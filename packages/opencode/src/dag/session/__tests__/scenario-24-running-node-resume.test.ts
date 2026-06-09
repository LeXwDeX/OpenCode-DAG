// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * Scenario 24: Running Node Recovery Resume (WP-A3)
 *
 * Exercises the running-to-pending recovery reset in orphaned workflows:
 * 1. Running nodes are reset to pending via state machine (legal transition)
 *    + recovery_reset log appended (executionPhase: 'recovery_reset')
 * 2. After reset, scheduleReadyNodes picks them up for re-spawn
 * 3. Transfer legality: direct updateNodeStatus(running→pending) succeeds
 *
 * Acceptance criteria (009-dag-capability-expansion.md §7 WP-A3):
 * - Running nodes in orphan workflows transition to pending (legal via state machine)
 * - No violation created for the reset
 * - dagNodeLogs contain recovery_reset marker (executionPhase: 'recovery_reset')
 * - Original running log entries preserved (audit integrity)
 * - Reset happens BEFORE scheduleReadyNodes (assembly timing, INFO 2)
 * - After reset, nodes are re-spawnable by existing scheduleReadyNodes/spawnReadyNode
 *
 * Infrastructure:
 * - Flag.OPENCODE_DB = ":memory:" + Database.Client.reset() (isolated in-memory SQLite)
 * - DAGSessionService.make + WorkflowEngine.make via Effect.runSync
 * - Mock PromptOps (never actually invoked)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Database from "@/storage/db"
import { DAGSessionService } from "../session-service"
import { WorkflowEngine, unregisterEngine } from "../workflow-engine"
import { recoverOrphanedWorkflows } from "../recovery"
import type { PromptOps } from "@/session/prompt-ops"
import type { DAGConfig, DAGNodeConfig, DAGNodeSession, DAGWorkflowSession } from "../types"
import type { MessageV2 } from "@/session/message-v2"
import type { SessionPrompt } from "@/session/prompt"

// ============================================================================
// Helpers
// ============================================================================

function makeNodeConfig(id: string, deps: string[], required: boolean): DAGNodeConfig {
  return {
    id,
    name: id,
    dependencies: deps,
    required,
    worker_type: "general",
    worker_config: {},
  }
}

function setupWorkflow(
  service: {
    readonly createWorkflow: (input: { name: string; chatSessionId: string; config: DAGConfig; metadata?: Record<string, unknown> }) => Effect.Effect<DAGWorkflowSession, unknown>
    readonly createNode: (input: { workflowId: string; nodeId?: string; name: string; nodeName: string; nodeType: string; config: DAGNodeConfig; dependencyNodes?: string[]; timeoutMs?: number; maxRetries?: number }) => Effect.Effect<DAGNodeSession>
  },
  name: string,
  nodes: { id: string; deps: string[]; required: boolean }[],
  maxConcurrency: number = 3,
): { workflowId: string; nodeConfigs: DAGNodeConfig[] } {
  const nodeConfigs = nodes.map((n) => makeNodeConfig(n.id, n.deps, n.required))
  const config: DAGConfig = { name, nodes: nodeConfigs, max_concurrency: maxConcurrency }
  const workflow = Effect.runSync(
    service.createWorkflow({ name, chatSessionId: `test-session-${name}`, config }),
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
  return { workflowId: workflow.id, nodeConfigs }
}

function mockPromptOps(): PromptOps {
  const stubParts = [] as SessionPrompt.PromptInput["parts"]
  const stubWithParts = { messages: [], parts: [] } as unknown as MessageV2.WithParts
  return {
    cancel: () => Effect.void,
    resolvePromptParts: () => Effect.succeed(stubParts),
    prompt: () => Effect.succeed(stubWithParts),
    loop: () => Effect.succeed(stubWithParts),
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("scenario-24: running node recovery resume (WP-A3)", () => {
  const originalDb = Flag.OPENCODE_DB

  beforeEach(() => {
    Flag.OPENCODE_DB = ":memory:"
    Database.Client.reset()
  })

  afterEach(() => {
    try { Database.close() } catch { /* ignore */ }
    Flag.OPENCODE_DB = originalDb
    Database.Client.reset()
    // Clean up any stale engine registrations from previous tests
    try { unregisterEngine("cleanup") } catch { /* ignore */ }
  })

  it("running node resets to pending + recovery_reset log appended, no violation", () => {
    const service = Effect.runSync(DAGSessionService.make)

    // Setup: orphan workflow with A=running, B=pending (dep on A)
    const { workflowId: wid } = setupWorkflow(service, "reset-test", [
      { id: "A", deps: [], required: true },
      { id: "B", deps: ["A"], required: true },
    ])

    // Push workflow to running, A to running (simulates crash during execution)
    Effect.runSync(service.updateWorkflowStatus(wid, "running"))
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
    // B stays pending

    // Pre-recovery: write an original "running" log for A (simulates real execution log)
    Effect.runSync(service.appendNodeLog({
      nodeId: `${wid}::A`,
      workflowId: wid,
      chatSessionId: `test-session-reset-test`,
      logLevel: "info",
      logMessage: "node execution started",
      executionPhase: "running",
    }))

    // Verify pre-state: A is running, B is pending
    const nodesBefore = Effect.runSync(service.listNodes(wid))
    const beforeMap = new Map(nodesBefore.map(n => [n.node_id, n.status] as const))
    expect(beforeMap.get(`${wid}::A`)).toBe("running")
    expect(beforeMap.get(`${wid}::B`)).toBe("pending")

    // No engine → orphan
    expect(WorkflowEngine.get(wid)).toBeUndefined()

    // Trigger recovery with promptOps (resume path)
    const result = Effect.runSync(recoverOrphanedWorkflows(service, mockPromptOps()))

    // Recovery succeeded (resume, not legacy fail)
    expect(result.scanned).toBe(1)
    expect(result.resumed).toBe(1)
    expect(result.marked).toBe(0)

    // A reset to pending; B still pending
    const nodesAfter = Effect.runSync(service.listNodes(wid))
    const afterMap = new Map(nodesAfter.map(n => [n.node_id, n.status] as const))
    expect(afterMap.get(`${wid}::A`)).toBe("pending")
    expect(afterMap.get(`${wid}::B`)).toBe("pending")

    // No violation created for the reset
    const violations = Effect.runSync(service.listViolations(wid))
    const orphanViolations = violations.filter(v => v.type === "process_orphan")
    expect(orphanViolations.length).toBe(0)

    // Audit: original "running" log preserved + recovery_reset log appended
    const logs = Effect.runSync(service.listNodeLogs(`${wid}::A`))
    const runningLogs = logs.filter(l => l.execution_phase === "running")
    const resetLogs = logs.filter(l => l.execution_phase === "recovery_reset")
    expect(runningLogs.length).toBe(1) // original preserved
    expect(resetLogs.length).toBe(1) // recovery reset marker
    expect(resetLogs[0].log_level).toBe("info")

    // Engine is registered (resume succeeded)
    expect(WorkflowEngine.get(wid)).not.toBeUndefined()

    // Cleanup
    unregisterEngine(wid)
  })

  it("reset nodes picked up by scheduleReadyNodes (assembly timing INFO 2)", () => {
    const service = Effect.runSync(DAGSessionService.make)

    // Setup: orphan workflow with A=running (no deps)
    const { workflowId: wid } = setupWorkflow(service, "spawn-test", [
      { id: "A", deps: [], required: true },
    ], /* maxConcurrency */ 5)

    // Push A to running
    Effect.runSync(service.updateWorkflowStatus(wid, "running"))
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))

    // No engine → orphan
    expect(WorkflowEngine.get(wid)).toBeUndefined()

    // Trigger recovery
    const result = Effect.runSync(recoverOrphanedWorkflows(service, mockPromptOps()))
    expect(result.resumed).toBe(1)

    // After recovery, A must be pending (reset happened before scheduleReadyNodes)
    const nodes = Effect.runSync(service.listNodes(wid))
    const nodeMap = new Map(nodes.map(n => [n.node_id, n.status] as const))
    expect(nodeMap.get(`${wid}::A`)).toBe("pending")

    // The engine is registered and scheduleReadyNodes was called as part
    // of resumeOrphanWorkflow. Since A is now pending and has no deps,
    // it should have been considered by the scheduler. We verify by checking
    // that the engine exists (the real spawn requires full Effect context
    // that these integration tests don't provide).
    expect(WorkflowEngine.get(wid)).not.toBeUndefined()

    // Cleanup
    unregisterEngine(wid)
  })

  it("direct updateNodeStatus(running→pending) is a legal transition", () => {
    const service = Effect.runSync(DAGSessionService.make)

    const { workflowId: wid } = setupWorkflow(service, "transition-test", [
      { id: "T", deps: [], required: true },
    ])

    // Push T to running
    Effect.runSync(service.updateWorkflowStatus(wid, "running"))
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::T`, status: "running" }))

    // Direct running→pending should NOT throw
    const pendingResult = Effect.runSync(
      service.updateNodeStatus({ sessionId: `${wid}::T`, status: "pending" }).pipe(
        Effect.map(() => "success" as const),
        Effect.catchCause(() => Effect.succeed("failed" as const)),
      ),
    )
    expect(pendingResult).toBe("success")

    // Verify node is now pending
    const node = Effect.runSync(service.getNode(`${wid}::T`))
    expect(node?.status).toBe("pending")
  })

  it("preserves completed nodes untouched during running reset", () => {
    const service = Effect.runSync(DAGSessionService.make)

    // Setup: A completed, B running (orphan), C pending dep B
    const { workflowId: wid } = setupWorkflow(service, "mixed-test", [
      { id: "A", deps: [], required: true },
      { id: "B", deps: ["A"], required: true },
      { id: "C", deps: ["B"], required: false },
    ])

    Effect.runSync(service.updateWorkflowStatus(wid, "running"))
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "completed" }))
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::B`, status: "running" }))
    // C stays pending

    // Run recovery
    const result = Effect.runSync(recoverOrphanedWorkflows(service, mockPromptOps()))
    expect(result.resumed).toBe(1)

    // A stays completed (not touched), B reset to pending, C still pending
    const nodes = Effect.runSync(service.listNodes(wid))
    const nodeMap = new Map(nodes.map(n => [n.node_id, n.status] as const))
    expect(nodeMap.get(`${wid}::A`)).toBe("completed")
    expect(nodeMap.get(`${wid}::B`)).toBe("pending")
    expect(nodeMap.get(`${wid}::C`)).toBe("pending")

    // Cleanup
    unregisterEngine(wid)
  })
})
