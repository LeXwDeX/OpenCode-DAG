// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * Scenario 36: WP2 recoverable state machine basics
 *
 * When a DAG node is configured with `failure_policy: 'recoverable'` and fails
 * while in running state, it transitions to a non-terminal `recoverable` state
 * instead of the usual `failed` state. The workflow does not finalize; downstream
 * pending nodes are preserved (no cascade skip).
 *
 * Architecture constraints (archgate PASS):
 *   - recoverable is non-terminal (not in isNodeTerminalStatus set)
 *   - Legal transitions: running → recoverable; recoverable → pending; recoverable → failed
 *   - Illegal transitions: recoverable → running (must reset to pending first);
 *     pending → recoverable (only running can go recoverable)
 *   - recoverable nodes excluded from ready set (no auto-reschedule)
 *   - failure_policy missing or 'fail' = existing behavior (running → failed + cascade)
 *   - computeFinalWorkflowStatus sees recoverable as in-progress (returns null)
 *
 * Coverage (7 cases, minimum):
 *   (a) Regression baseline: default (no failure_policy) → running→failed + cascade skip
 *   (b) running → recoverable transition, no cascade skip downstream
 *   (c) Downstream pending preserved when upstream is recoverable
 *   (d) Workflow does not finalize while recoverable node exists
 *   (e) recoverable excluded from ready set (getReadyNodes pure function)
 *   (f) State machine illegal transitions: recoverable→running rejected; pending→recoverable rejected
 *   (g) Legal transitions: recoverable→pending success; recoverable→failed success
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Database from "@/storage/db"
import { DAGSessionService } from "../session-service"
import { WorkflowEngine } from "../workflow-engine"
import type { DAGConfig, DAGNodeConfig, DAGNodeSession, DAGWorkflowSession } from "../types"
import {
  getReadyNodes,
  computeFinalWorkflowStatus,
  getValidNextSessionNodeStatuses,
  classifyReplanNodes,
} from "../execution-core"
import { isNodeTerminalStatus } from "../types"

// ============================================================================
// Helpers (mirrors scenario-35 setup)
// ============================================================================

function makeNodeConfig(
  id: string,
  deps: string[],
  required: boolean,
  failurePolicy?: 'fail' | 'recoverable',
): DAGNodeConfig {
  const cfg: DAGNodeConfig = {
    id,
    name: id,
    dependencies: deps,
    required,
    worker_type: "general",
    worker_config: { prompt: "test task" },
  }
  if (failurePolicy !== undefined) cfg.failure_policy = failurePolicy
  return cfg
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setupWorkflow(service: any, name: string, nodes: { id: string; deps: string[]; required: boolean; failurePolicy?: 'fail' | 'recoverable' }[]): { workflowId: string; nodeConfigs: DAGNodeConfig[]; workflow: DAGWorkflowSession } {
  const nodeConfigs = nodes.map((n) => makeNodeConfig(n.id, n.deps, n.required, n.failurePolicy))
  const config: DAGConfig = { name, nodes: nodeConfigs, max_concurrency: 3 }
  const workflow = Effect.runSync(
    service.createWorkflow({
      name,
      chatSessionId: `s36-session-${name}-${Date.now()}`,
      config,
    }),
  ) as DAGWorkflowSession
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
  return { workflowId: workflow.id, nodeConfigs, workflow }
}

// ============================================================================
// Re-export helpers shim — execution-core is imported via its canonical path.
// We define a local re-export to keep the import lines clean (single-source).
// ============================================================================

// (The imported symbols above are direct — see top of file.)

// ============================================================================
// Test suite
// ============================================================================

describe("Scenario 36: WP2 recoverable state machine basics", () => {
  beforeAll(() => {
    Flag.OPENCODE_DB = ":memory:"
    Database.Client.reset()
  })
  afterAll(() => {
    Database.Client.reset()
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let service: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let engine: any

  beforeEach(() => {
    service = Effect.runSync(DAGSessionService.make)
    engine = Effect.runSync(WorkflowEngine.make)
  })

  // --------------------------------------------------------------------------
  // (a) Regression baseline: default (no failure_policy) → running→failed + cascade
  // --------------------------------------------------------------------------
  it("(a) regression: default (no failure_policy) failure → running→failed + cascade skip downstream", () => {
    // A(required) → B(required): A fails → A=failed, B cascade-skipped
    const { workflowId } = setupWorkflow(service, "test-36a", [
      { id: "a", deps: [], required: true },
      { id: "b", deps: ["a"], required: true },
    ])
    const nodeIdA = `${workflowId}::a`
    const nodeIdB = `${workflowId}::b`

    Effect.runSync(engine.startWorkflow(workflowId, { name: "test-36a", nodes: [], max_concurrency: 3 }))
    // Pre-set node A to running (handleNodeFailure needs a running node)
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "running" }))
    // Drive failure
    Effect.runSync(engine.handleNodeFailure(workflowId, nodeIdA, new Error("test failure 36a")))

    // A should be failed
    const nodeA = Effect.runSync(service.getNode(nodeIdA)) as DAGNodeSession
    expect(nodeA.status).toBe("failed")

    // B should be cascade-skipped (pending → skipped)
    const nodeB = Effect.runSync(service.getNode(nodeIdB)) as DAGNodeSession
    expect(nodeB.status).toBe("skipped")

    // Workflow should be failed (required node failed)
    const wf = Effect.runSync(service.getWorkflow(workflowId)) as DAGWorkflowSession
    expect(wf.status).toBe("failed")
  })

  // --------------------------------------------------------------------------
  // (b) running → recoverable transition, no cascade skip downstream
  // --------------------------------------------------------------------------
  it("(b) failure_policy='recoverable' → running→recoverable, no cascade skip", () => {
    // A(required, recoverable) → B(required): A fails → A=recoverable, B stays pending
    const { workflowId } = setupWorkflow(service, "test-36b", [
      { id: "a", deps: [], required: true, failurePolicy: "recoverable" },
      { id: "b", deps: ["a"], required: true },
    ])
    const nodeIdA = `${workflowId}::a`
    const nodeIdB = `${workflowId}::b`

    Effect.runSync(engine.startWorkflow(workflowId, { name: "test-36b", nodes: [], max_concurrency: 3 }))
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "running" }))
    Effect.runSync(engine.handleNodeFailure(workflowId, nodeIdA, new Error("test failure 36b")))

    // A should be recoverable (not failed)
    const nodeA = Effect.runSync(service.getNode(nodeIdA)) as DAGNodeSession
    expect(nodeA.status).toBe("recoverable")

    // B should still be pending (NOT skipped)
    const nodeB = Effect.runSync(service.getNode(nodeIdB)) as DAGNodeSession
    expect(nodeB.status).toBe("pending")

    // Workflow should NOT be terminal (still running because recoverable is in-progress)
    const wf = Effect.runSync(service.getWorkflow(workflowId)) as DAGWorkflowSession
    expect(["running", "paused"]).toContain(wf.status)
  })

  // --------------------------------------------------------------------------
  // (c) Downstream pending preserved — independent branch still schedulable
  // --------------------------------------------------------------------------
  it("(c) downstream pending preserved; independent sibling branch still schedulable", () => {
    // A(required, recoverable), B(required, independent of A): A fails → A=recoverable.
    // B should still be pending (schedulable independently of A's recoverable state).
    const { workflowId } = setupWorkflow(service, "test-36c", [
      { id: "a", deps: [], required: true, failurePolicy: "recoverable" },
      { id: "b", deps: [], required: true },
    ])
    const nodeIdA = `${workflowId}::a`
    const nodeIdB = `${workflowId}::b`

    Effect.runSync(engine.startWorkflow(workflowId, { name: "test-36c", nodes: [], max_concurrency: 3 }))
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "running" }))
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdB, status: "running" }))
    // Both nodes running. A fails with recoverable policy; B continues running.
    Effect.runSync(engine.handleNodeFailure(workflowId, nodeIdA, new Error("test failure 36c")))

    // A should be recoverable
    const nodeA = Effect.runSync(service.getNode(nodeIdA)) as DAGNodeSession
    expect(nodeA.status).toBe("recoverable")

    // B should still be running (independent branch not touched by A's failure)
    const nodeB = Effect.runSync(service.getNode(nodeIdB)) as DAGNodeSession
    expect(nodeB.status).toBe("running")

    // Workflow should be non-terminal (recoverable + running = in-progress)
    const wf = Effect.runSync(service.getWorkflow(workflowId)) as DAGWorkflowSession
    expect(["running", "paused"]).toContain(wf.status)
  })

  // --------------------------------------------------------------------------
  // (d) Workflow does not finalize while recoverable node exists
  // --------------------------------------------------------------------------
  it("(d) computeFinalWorkflowStatus returns null while recoverable exists", () => {
    // Pure function test: computeFinalWorkflowStatus with recoverable node → null
    const nodes: DAGNodeSession[] = [
      { status: "recoverable", config: { required: true } } as unknown as DAGNodeSession,
    ]
    expect(computeFinalWorkflowStatus(nodes)).toBeNull()

    // And: computeFinalWorkflowStatus with completed + recoverable → null (recoverable counts as in-progress)
    const nodes2: DAGNodeSession[] = [
      { status: "completed", config: { required: true } } as unknown as DAGNodeSession,
      { status: "recoverable", config: { required: true } } as unknown as DAGNodeSession,
    ]
    expect(computeFinalWorkflowStatus(nodes2)).toBeNull()

    // Workflow should stay running when only a recoverable node exists
    const { workflowId } = setupWorkflow(service, "test-36d", [
      { id: "a", deps: [], required: true, failurePolicy: "recoverable" },
    ])
    const nodeIdA = `${workflowId}::a`

    Effect.runSync(engine.startWorkflow(workflowId, { name: "test-36d", nodes: [], max_concurrency: 3 }))
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "running" }))
    Effect.runSync(engine.handleNodeFailure(workflowId, nodeIdA, new Error("test failure 36d")))

    const wf = Effect.runSync(service.getWorkflow(workflowId)) as DAGWorkflowSession
    // Workflow must NOT have terminalized (not completed, not failed, not cancelled)
    expect(["running", "paused"]).toContain(wf.status)
    expect(wf.completed_at).toBeNull()
  })

  // --------------------------------------------------------------------------
  // (e) recoverable excluded from ready set (pure getReadyNodes)
  // --------------------------------------------------------------------------
  it("(e) recoverable nodes excluded from ready set by getReadyNodes", () => {
    // Three nodes: A (recoverable), B (pending, no deps), C (pending, depends on A)
    // Ready set should contain only B (A excluded by recoverable filter, C deps unsatisfied).
    const nodes: DAGNodeSession[] = [
      { node_id: "wf::a", status: "recoverable", dependencies: [], config: { required: true } } as unknown as DAGNodeSession,
      { node_id: "wf::b", status: "pending", dependencies: [], config: { required: true } } as unknown as DAGNodeSession,
      { node_id: "wf::c", status: "pending", dependencies: ["wf::a"], config: { required: true } } as unknown as DAGNodeSession,
    ]
    const completedNodeIds = new Set<string>([])
    const failedNodeIds = new Set<string>([])
    const runningNodeIds = new Set<string>([])

    const ready = getReadyNodes(nodes, completedNodeIds, failedNodeIds, runningNodeIds)
    const readyIds = ready.map((n: DAGNodeSession) => n.node_id)

    // A must NOT be in ready set (recoverable)
    expect(readyIds).not.toContain("wf::a")
    // B should be in ready set (pending, no deps)
    expect(readyIds).toContain("wf::b")
    // C must NOT be in ready set (deps on A unsatisfied)
    expect(readyIds).not.toContain("wf::c")
    expect(ready.length).toBe(1)
  })

  // --------------------------------------------------------------------------
  // (f) State machine illegal transitions
  // --------------------------------------------------------------------------
  it("(f) state machine: recoverable→running rejected, pending→recoverable rejected", () => {
    // Pure: getValidNextSessionNodeStatuses
    const fromRecoverable = getValidNextSessionNodeStatuses("recoverable")
    expect(fromRecoverable).not.toContain("running")
    expect(fromRecoverable).not.toContain("queued")
    expect(fromRecoverable).not.toContain("skipped")
    expect(fromRecoverable).not.toContain("recoverable") // can't re-enter

    const fromPending = getValidNextSessionNodeStatuses("pending")
    expect(fromPending).not.toContain("recoverable") // pending cannot jump to recoverable

    // End-to-end via actual updateNodeStatus: recoverable→running should throw
    const { workflowId } = setupWorkflow(service, "test-36f", [
      { id: "a", deps: [], required: true, failurePolicy: "recoverable" },
    ])
    const nodeIdA = `${workflowId}::a`
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "running" }))
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "recoverable" }))

    // Try recoverable → running: should throw
    expect(() => {
      Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "running" }))
    }).toThrow()

    // Try pending → recoverable: set up a fresh node at pending and try
    const { workflowId: wfId2 } = setupWorkflow(service, "test-36f2", [
      { id: "b", deps: [], required: true },
    ])
    const nodeIdB = `${wfId2}::b`
    // B starts as pending (initial state). Try pending → recoverable: should throw.
    expect(() => {
      Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdB, status: "recoverable" }))
    }).toThrow()
  })

  // --------------------------------------------------------------------------
  // (g) Legal transitions: recoverable→pending, recoverable→failed
  // --------------------------------------------------------------------------
  it("(g) state machine: recoverable→pending success, recoverable→failed success", () => {
    // Pure: getValidNextSessionNodeStatuses
    const fromRecoverable = getValidNextSessionNodeStatuses("recoverable")
    expect(fromRecoverable).toContain("pending")
    expect(fromRecoverable).toContain("failed")
    expect(fromRecoverable.length).toBe(2) // exactly two legal transitions

    // End-to-end: recoverable→pending success
    const { workflowId: wfId1 } = setupWorkflow(service, "test-36g1", [
      { id: "a", deps: [], required: true, failurePolicy: "recoverable" },
    ])
    const nodeIdA1 = `${wfId1}::a`
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA1, status: "running" }))
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA1, status: "recoverable" }))
    // recoverable → pending: should succeed (reset for rerun)
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA1, status: "pending" }))
    const nodeA1After = Effect.runSync(service.getNode(nodeIdA1)) as DAGNodeSession
    expect(nodeA1After.status).toBe("pending")

    // End-to-end: recoverable→failed success
    const { workflowId: wfId2 } = setupWorkflow(service, "test-36g2", [
      { id: "b", deps: [], required: true, failurePolicy: "recoverable" },
    ])
    const nodeIdB2 = `${wfId2}::b`
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdB2, status: "running" }))
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdB2, status: "recoverable" }))
    // recoverable → failed: should succeed (abandon recovery)
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdB2, status: "failed" }))
    const nodeB2After = Effect.runSync(service.getNode(nodeIdB2)) as DAGNodeSession
    expect(nodeB2After.status).toBe("failed")
  })

  // --------------------------------------------------------------------------
  // (h) isNodeTerminalStatus: recoverable is NOT terminal
  // --------------------------------------------------------------------------
  it("(h) isNodeTerminalStatus: recoverable is not terminal", () => {
    expect(isNodeTerminalStatus("recoverable")).toBe(false)
    // Baseline: confirm terminal states are still terminal
    expect(isNodeTerminalStatus("completed")).toBe(true)
    expect(isNodeTerminalStatus("failed")).toBe(true)
    expect(isNodeTerminalStatus("skipped")).toBe(true)
    // Non-terminal in-progress states
    expect(isNodeTerminalStatus("pending")).toBe(false)
    expect(isNodeTerminalStatus("queued")).toBe(false)
    expect(isNodeTerminalStatus("running")).toBe(false)
  })

  // --------------------------------------------------------------------------
  // (i) classifyReplanNodes: recoverable is in frozen set
  // --------------------------------------------------------------------------
  it("(i) classifyReplanNodes: recoverable nodes are frozen (WP2; WP3 may relax)", () => {
    const nodes: DAGNodeSession[] = [
      { node_id: "wf::a", status: "recoverable", config: { required: true } } as unknown as DAGNodeSession,
      { node_id: "wf::b", status: "pending", config: { required: true } } as unknown as DAGNodeSession,
      { node_id: "wf::c", status: "running", config: { required: true } } as unknown as DAGNodeSession,
    ]
    const { frozen, mutable, frozenIds } = classifyReplanNodes(nodes)

    // frozen should have a and c, mutable should have b
    const frozenNodeIds = frozen.map((n: DAGNodeSession) => n.node_id)
    const mutableNodeIds = mutable.map((n: DAGNodeSession) => n.node_id)
    expect(frozenNodeIds).toContain("wf::a")
    expect(frozenNodeIds).toContain("wf::c")
    expect(frozenNodeIds).not.toContain("wf::b")
    expect(mutableNodeIds).toContain("wf::b")
    expect(frozenIds.has("wf::a")).toBe(true)
  })
})
