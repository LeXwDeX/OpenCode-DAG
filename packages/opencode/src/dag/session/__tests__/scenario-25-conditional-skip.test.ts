// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * Scenario 25: WP-B3 — Conditional skip + downstream cascade integration tests.
 *
 * Validates:
 * - Condition-false nodes transition to skipped via Session path (iron law #1)
 * - Downstream pending nodes are cascade-skipped (reuses findPendingDescendants BFS)
 * - Workflow terminal convergence: skip does not block finalize
 * - Audit differentiation: condition_skipped violation + condition_skip executionPhase
 *   vs execution_failed/cascade_skip for failure cascade
 * - Multi-skipCandidate overlap (I3): shared downstream skipped exactly once
 * - Comparison with failure cascade: same topology, different audit trail
 *
 * Infrastructure:
 * - Flag.OPENCODE_DB = ":memory:" enables in-memory SQLite
 * - Database.Client.reset() forces re-initialization
 * - DAGSessionService.make and WorkflowEngine.make run via Effect.runSync
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Database from "@/storage/db"
import { DAGSessionService } from "../session-service"
import { WorkflowEngine } from "../workflow-engine"
import type {
  DAGConfig,
  DAGNodeConfig,
  DAGNodeSession,
  DAGWorkflowSession,
  DAGNodeCondition,
} from "../types"

// ============================================================================
// Helpers
// ============================================================================

function makeNodeConfig(
  id: string,
  deps: string[],
  required: boolean,
  condition?: DAGNodeCondition,
): DAGNodeConfig {
  return {
    id,
    name: id,
    dependencies: deps,
    required,
    worker_type: "general",
    worker_config: {},
    condition,
  }
}

function setupWorkflow(
  service: {
    readonly createWorkflow: (input: {
      name: string
      chatSessionId: string
      config: DAGConfig
      metadata?: Record<string, unknown>
    }) => Effect.Effect<DAGWorkflowSession, unknown>
    readonly createNode: (input: {
      workflowId: string
      nodeId?: string
      name: string
      nodeName: string
      nodeType: string
      config: DAGNodeConfig
      dependencyNodes?: string[]
      timeoutMs?: number
      maxRetries?: number
    }) => Effect.Effect<DAGNodeSession>
  },
  name: string,
  nodeConfigs: DAGNodeConfig[],
): { workflowId: string } {
  const config: DAGConfig = {
    name,
    nodes: nodeConfigs,
    max_concurrency: 5,
  }
  const workflow = Effect.runSync(
    service.createWorkflow({
      name,
      chatSessionId: `test-session-${name}`,
      config,
    }),
  )
  for (const cfg of nodeConfigs) {
    Effect.runSync(
      service.createNode({
        workflowId: workflow.id,
        nodeId: `${workflow.id}::${cfg.id}`,
        name: cfg.name,
        nodeName: cfg.name,
        nodeType: cfg.worker_type,
        config: cfg,
        dependencyNodes: cfg.dependencies.map((d) => `${workflow.id}::${d}`),
        timeoutMs: cfg.timeout_ms,
        maxRetries: cfg.retry?.max_attempts ?? 0,
      }),
    )
  }
  return { workflowId: workflow.id }
}

// ============================================================================
// Tests
// ============================================================================

describe("WP-B3: Conditional skip + downstream cascade", () => {
  const originalDb = Flag.OPENCODE_DB

  beforeAll(() => {
    Flag.OPENCODE_DB = ":memory:"
    Database.Client.reset()
  })

  afterAll(() => {
    try { Database.close() } catch { /* ignore */ }
    Flag.OPENCODE_DB = originalDb
    Database.Client.reset()
  })

  it("Test 1: Single node condition false → skipped + condition_skipped violation + condition_skip log", () => {
    const service = Effect.runSync(DAGSessionService.make)
    const engine = Effect.runSync(WorkflowEngine.make)

    const nodeConfigs = [
      makeNodeConfig("A", [], false),
      makeNodeConfig("B", ["A"], false, { ref_node: "A", op: "eq", value: "yes" }),
    ]
    const { workflowId: wid } = setupWorkflow(service, "cond-skip-single", nodeConfigs)

    // Start workflow → running
    Effect.runSync(service.updateWorkflowStatus(wid, "running"))

    // A runs and completes with output "no" (condition on B requires "yes" → false)
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
    Effect.runSync(engine.handleNodeCompletion(wid, `${wid}::A`, "no"))

    // scheduleReadyNodes was called inside handleNodeCompletion.
    // B has condition ref_node=A, op=eq, value="yes". A's output is "no" → condition false.
    // B should be skipped (condition_skipped violation + condition_skip log).

    const nodes = Effect.runSync(service.listNodes(wid))
    const nodeMap = new Map(nodes.map((n) => [n.node_id, n] as const))
    const bNode = nodeMap.get(`${wid}::B`)!

    // B status = skipped (via state machine, not bypassed)
    expect(bNode.status).toBe("skipped")

    // Violation: condition_skipped type with trigger=condition_false details
    const violations = Effect.runSync(service.listViolations(wid))
    const condViolation = violations.find((v) => v.nodeId === `${wid}::B`)
    expect(condViolation).toBeDefined()
    expect(condViolation!.type).toBe("condition_skipped")
    expect(condViolation!.details).toBeDefined()
    expect((condViolation!.details as Record<string, unknown>)["trigger"]).toBe("condition_false")
    expect((condViolation!.details as Record<string, unknown>)["condition"]).toEqual({
      ref_node: "A",
      op: "eq",
      value: "yes",
    })

    // D1 fix: violation details now include runtime evaluation snapshot.
    // Users can see the actual ref_node output ("no") and the declared value
    // ("yes") that caused the condition to evaluate false — no need to
    // cross-reference node_log to diagnose why B was skipped.
    expect((condViolation!.details as Record<string, unknown>)["ref_node_id"]).toBe("A")
    expect((condViolation!.details as Record<string, unknown>)["ref_node_output"]).toBe("no")
    expect((condViolation!.details as Record<string, unknown>)["declared_value"]).toBe("yes")
    expect((condViolation!.details as Record<string, unknown>)["evaluated_result"]).toBe(false)

    // Log: condition_skip executionPhase
    const logs = Effect.runSync(service.listNodeLogs(`${wid}::B`))
    const condLogs = logs.filter((l) => l.execution_phase === "condition_skip")
    expect(condLogs.length).toBe(1)
    expect(condLogs[0].log_level).toBe("warn")
  })

  it("Test 2: Downstream cascade — A condition false, B depends on A → B cascade skipped", () => {
    const service = Effect.runSync(DAGSessionService.make)
    const engine = Effect.runSync(WorkflowEngine.make)

    const nodeConfigs = [
      makeNodeConfig("A", [], false),
      makeNodeConfig("B", ["A"], false, { ref_node: "A", op: "exists" }),
      makeNodeConfig("C", ["B"], false),
    ]
    const { workflowId: wid } = setupWorkflow(service, "cond-skip-cascade", nodeConfigs)

    Effect.runSync(service.updateWorkflowStatus(wid, "running"))

    // A completes with null output → B's condition (exists) evaluates to false
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
    Effect.runSync(engine.handleNodeCompletion(wid, `${wid}::A`, null))

    // B condition false → skipped + cascade to C (B's pending descendant)
    const nodes = Effect.runSync(service.listNodes(wid))
    const nodeMap = new Map(nodes.map((n) => [n.node_id, n.status] as const))

    expect(nodeMap.get(`${wid}::A`)).toBe("completed")
    expect(nodeMap.get(`${wid}::B`)).toBe("skipped")
    expect(nodeMap.get(`${wid}::C`)).toBe("skipped")

    // C should have a cascade_skip log with trigger_type=condition_false
    const cLogs = Effect.runSync(service.listNodeLogs(`${wid}::C`))
    const cascadeLogs = cLogs.filter(
      (l) => l.execution_phase === "cascade_skip",
    )
    expect(cascadeLogs.length).toBe(1)
    const logData = cascadeLogs[0].log_data as Record<string, unknown> | null
    expect(logData?.trigger_type).toBe("condition_false")
  })

  it("Test 3: Multi-dependency — node not in cascade path is unaffected", () => {
    const service = Effect.runSync(DAGSessionService.make)
    const engine = Effect.runSync(WorkflowEngine.make)

    // Topology: ROOT → A1 (condition false → skipped), ROOT → A2 → B
    // A1's skip must NOT cascade to A2 or B (they don't depend on A1).
    const nodeConfigs = [
      makeNodeConfig("ROOT", [], false),
      makeNodeConfig("A1", ["ROOT"], false, { ref_node: "ROOT", op: "eq", value: "go" }),
      makeNodeConfig("A2", ["ROOT"], false),
      makeNodeConfig("B", ["A2"], false),
    ]
    const { workflowId: wid } = setupWorkflow(service, "cond-no-miss", nodeConfigs)

    Effect.runSync(service.updateWorkflowStatus(wid, "running"))

    // ROOT is the only ready node (no deps). Complete it with output "block".
    // A1's condition (ref ROOT, eq "go") evaluates to false since ROOT output ≠ "go".
    // handleNodeCompletion → scheduleReadyNodes: A1 condition false → skip;
    //   A2 no condition → executeList (fork-spawn, pending in sync); B pending (A2 not done).
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::ROOT`, status: "running" }))
    Effect.runSync(engine.handleNodeCompletion(wid, `${wid}::ROOT`, "block"))

    const nodes = Effect.runSync(service.listNodes(wid))
    const nodeMap = new Map(nodes.map((n) => [n.node_id, n.status] as const))

    // A1 should be skipped (condition false: ROOT output "block" ≠ "go")
    expect(nodeMap.get(`${wid}::A1`)).toBe("skipped")
    // A2 should NOT be cascade-skipped (A1's skip doesn't reach siblings)
    expect(nodeMap.get(`${wid}::A2`)).not.toBe("skipped")
    // B should still be pending (depends on A2 which hasn't completed; NOT cascade-skipped from A1)
    expect(nodeMap.get(`${wid}::B`)).toBe("pending")
  })

  it("Test 4: Terminal convergence — completed + skipped → workflow = completed", () => {
    const service = Effect.runSync(DAGSessionService.make)
    const engine = Effect.runSync(WorkflowEngine.make)

    // A completes, B depends on A with condition false → B skipped
    // No required nodes failed, all nodes terminal → workflow completed
    const nodeConfigs = [
      makeNodeConfig("A", [], true),
      makeNodeConfig("B", ["A"], false, { ref_node: "A", op: "eq", value: "skip-me" }),
    ]
    const { workflowId: wid } = setupWorkflow(service, "cond-converge", nodeConfigs)

    Effect.runSync(service.updateWorkflowStatus(wid, "running"))

    // A runs and completes
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
    Effect.runSync(engine.handleNodeCompletion(wid, `${wid}::A`, "other"))

    // B condition false → skipped. All nodes terminal (A=completed, B=skipped).
    // maybeFinalizeWorkflow should set workflow to completed.
    const wfAfter = Effect.runSync(service.getWorkflow(wid))
    expect(wfAfter?.status).toBe("completed")
  })

  it("Test 5: Multiple skipCandidates sharing downstream (I3) — no duplicate skip", () => {
    const service = Effect.runSync(DAGSessionService.make)
    const engine = Effect.runSync(WorkflowEngine.make)

    // ROOT → A1 (condition false), ROOT → A2 (condition false), D depends on both A1 and A2
    const nodeConfigs = [
      makeNodeConfig("ROOT", [], false),
      makeNodeConfig("A1", ["ROOT"], false, { ref_node: "ROOT", op: "eq", value: "go" }),
      makeNodeConfig("A2", ["ROOT"], false, { ref_node: "ROOT", op: "eq", value: "go" }),
      makeNodeConfig("D", ["A1", "A2"], false),
    ]
    const { workflowId: wid } = setupWorkflow(service, "cond-shared-downstream", nodeConfigs)

    Effect.runSync(service.updateWorkflowStatus(wid, "running"))

    // ROOT is the only ready node. Complete it with output "block".
    // handleNodeCompletion internally calls scheduleReadyNodes → A1 and A2 both
    // evaluate conditions (ref ROOT, eq "go") → false → both skipCandidates.
    // D is not ready (depends on A1, A2 both pending at scheduling time).
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::ROOT`, status: "running" }))
    Effect.runSync(engine.handleNodeCompletion(wid, `${wid}::ROOT`, "block"))

    const nodes = Effect.runSync(service.listNodes(wid))
    const nodeMap = new Map(nodes.map((n) => [n.node_id, n] as const))

    // A1 and A2 both skipped
    expect(nodeMap.get(`${wid}::A1`)!.status).toBe("skipped")
    expect(nodeMap.get(`${wid}::A2`)!.status).toBe("skipped")

    // D should also be skipped (cascade from A1's skip reaches D, then A2's skip
    // cascade calls findPendingDescendants which doesn't find D anymore since it's
    // already skipped).
    expect(nodeMap.get(`${wid}::D`)!.status).toBe("skipped")

    // D should have exactly 1 cascade_skip log (I3: first cascade skips D,
    // second cascade's findPendingDescendants doesn't pick D since status != pending)
    const dLogs = Effect.runSync(service.listNodeLogs(`${wid}::D`))
    const cascadeLogs = dLogs.filter(
      (l) => l.execution_phase === "cascade_skip",
    )
    expect(cascadeLogs.length).toBe(1)
  })

  it("Test 6: Condition skip vs failure cascade — same topology, different audit", () => {
    // --- Run 1: upstream condition false → condition skip + cascade ---
    const service1 = Effect.runSync(DAGSessionService.make)
    const engine1 = Effect.runSync(WorkflowEngine.make)

    const nodeConfigs1 = [
      makeNodeConfig("A", [], true),
      makeNodeConfig("B", ["A"], false, { ref_node: "A", op: "eq", value: "go" }),
      makeNodeConfig("C", ["B"], false),
    ]
    const { workflowId: wid1 } = setupWorkflow(service1, "compare-cond", nodeConfigs1)
    Effect.runSync(service1.updateWorkflowStatus(wid1, "running"))

    Effect.runSync(service1.updateNodeStatus({ sessionId: `${wid1}::A`, status: "running" }))
    Effect.runSync(engine1.handleNodeCompletion(wid1, `${wid1}::A`, "nope"))
    // B condition false → skipped, C cascade skipped

    // --- Run 2: upstream failure → failure cascade ---
    const service2 = Effect.runSync(DAGSessionService.make)
    const engine2 = Effect.runSync(WorkflowEngine.make)

    const nodeConfigs2 = [
      makeNodeConfig("A", [], true),
      makeNodeConfig("B", ["A"], false),
      makeNodeConfig("C", ["B"], false),
    ]
    const { workflowId: wid2 } = setupWorkflow(service2, "compare-fail", nodeConfigs2)
    Effect.runSync(service2.updateWorkflowStatus(wid2, "running"))

    Effect.runSync(service2.updateNodeStatus({ sessionId: `${wid2}::A`, status: "running" }))
    Effect.runSync(service2.updateNodeStatus({ sessionId: `${wid2}::B`, status: "running" }))
    Effect.runSync(engine2.handleNodeFailure(wid2, `${wid2}::B`, new Error("B failed")))
    // B failed, C cascade skipped

    // Both: B and C end up in terminal skip/fail states
    const nodes1 = Effect.runSync(service1.listNodes(wid1))
    const map1 = new Map(nodes1.map((n) => [n.node_id, n.status] as const))
    expect(map1.get(`${wid1}::B`)).toBe("skipped")
    expect(map1.get(`${wid1}::C`)).toBe("skipped")

    const nodes2 = Effect.runSync(service2.listNodes(wid2))
    const map2 = new Map(nodes2.map((n) => [n.node_id, n.status] as const))
    expect(map2.get(`${wid2}::B`)).toBe("failed")
    expect(map2.get(`${wid2}::C`)).toBe("skipped")

    // Audit differentiation:
    // Condition skip: B has condition_skipped violation
    const v1 = Effect.runSync(service1.listViolations(wid1))
    const bViolation1 = v1.find((v) => v.nodeId === `${wid1}::B`)
    expect(bViolation1?.type).toBe("condition_skipped")

    // Failure cascade: B has execution_failed violation (not required → execution_failed)
    const v2 = Effect.runSync(service2.listViolations(wid2))
    const bViolation2 = v2.find((v) => v.nodeId === `${wid2}::B`)
    expect(bViolation2?.type).toBe("execution_failed")

    // Condition skip: B has condition_skip log
    const bCondLogs = Effect.runSync(service1.listNodeLogs(`${wid1}::B`))
    expect(bCondLogs.some((l) => l.execution_phase === "condition_skip")).toBe(true)

    // Failure cascade: B has failed log (not condition_skip)
    const bFailLogs = Effect.runSync(service2.listNodeLogs(`${wid2}::B`))
    expect(bFailLogs.some((l) => l.execution_phase === "failed")).toBe(true)
    expect(bFailLogs.some((l) => l.execution_phase === "condition_skip")).toBe(false)

    // Both cascade C log has cascade_skip phase
    const cCondCascade = Effect.runSync(service1.listNodeLogs(`${wid1}::C`))
    expect(cCondCascade.some((l) => l.execution_phase === "cascade_skip")).toBe(true)
    const cFailCascade = Effect.runSync(service2.listNodeLogs(`${wid2}::C`))
    expect(cFailCascade.some((l) => l.execution_phase === "cascade_skip")).toBe(true)
  })
})
