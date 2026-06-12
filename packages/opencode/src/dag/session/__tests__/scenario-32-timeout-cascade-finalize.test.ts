// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * Scenario 32: Timeout/retry-exhaustion paths must drive DAG convergence.
 *
 * Regression for the bug where `spawnReadyNode`'s timer and retry-exhaustion
 * paths marked a node as failed but never called `cascadeSkipDownstream`,
 * `scheduleReadyNodes`, or `maybeFinalizeWorkflow`. Result: required-node
 * time-outs left downstream nodes stuck in `pending` and the workflow stuck
 * in `running` forever.
 *
 * Fix locations (workflow-engine.ts):
 *   1. Timer (setTimeout) fiber: after marking failed, also cascade + converge.
 *   2. Retry exhaustion: after marking failed, also cascade + converge.
 *
 * This test exercises the same convergence sequence the fix introduces, via
 * the public engine API: `handleNodeFailure` already performs the full
 * sequence, so we additionally verify the idempotency guard — when two paths
 * race to mark the same node failed, downstream must still be skipped and the
 * workflow must still converge exactly once.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Database from "@/storage/db"
import { DAGSessionService } from "../session-service"
import { WorkflowEngine } from "../workflow-engine"
import type { DAGConfig, DAGNodeConfig, DAGNodeSession, DAGWorkflowSession } from "../types"

// ============================================================================
// Helpers (mirror scenario-22-workflow-finalize.test.ts)
// ============================================================================

function makeNodeConfig(id: string, deps: string[], required: boolean, timeoutMs?: number): DAGNodeConfig {
  return {
    id,
    name: id,
    dependencies: deps,
    required,
    worker_type: "general",
    worker_config: {},
    ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
  }
}

const originalDb = Flag.OPENCODE_DB

function setupWorkflow(
  service: {
    readonly createWorkflow: (input: { name: string; chatSessionId: string; config: DAGConfig; metadata?: Record<string, unknown> }) => Effect.Effect<DAGWorkflowSession, unknown>
    readonly createNode: (input: { workflowId: string; nodeId?: string; name: string; nodeName: string; nodeType: string; config: DAGNodeConfig; dependencyNodes?: string[]; timeoutMs?: number; maxRetries?: number }) => Effect.Effect<DAGNodeSession>
  },
  name: string,
  nodes: { id: string; deps: string[]; required: boolean; timeout_ms?: number }[],
): { workflowId: string } {
  const nodeConfigs = nodes.map((n) => makeNodeConfig(n.id, n.deps, n.required, n.timeout_ms))
  const config: DAGConfig = {
    name,
    nodes: nodeConfigs,
    max_concurrency: 4,
  }
  const workflow = Effect.runSync(
    service.createWorkflow({
      name,
      chatSessionId: `test-${name}`,
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
// Core regression: required node marked failed → downstream cascade + converge
// ============================================================================

describe("Scenario 32: Timeout-cascade convergence", () => {
  beforeAll(() => {
    Flag.OPENCODE_DB = ":memory:"
    Database.Client.reset()
  })

  afterAll(() => {
    try { Database.close() } catch { /* ignore */ }
    Flag.OPENCODE_DB = originalDb
    Database.Client.reset()
  })

  it("G-chain: required node failed via handleNodeFailure cascades and converges", async () => {
    // Mirrors the real DAG v5 layout that exposed the bug:
    //   G (required, no deps) → J (depends G) → K (depends J) → L (depends K)
    // When G times out and gets marked failed, J/K/L MUST be skipped and the
    // workflow MUST converge to 'failed' — not remain stuck at 'running'.
    const service = Effect.runSync(DAGSessionService.make)
    const engine = Effect.runSync(WorkflowEngine.make)

    const { workflowId: wid } = setupWorkflow(service, "g-chain-timeout", [
      { id: "G", deps: [], required: true, timeout_ms: 30000 },
      { id: "J", deps: ["G"], required: true },
      { id: "K", deps: ["J"], required: true },
      { id: "L", deps: ["K"], required: true },
    ])

    Effect.runSync(service.updateWorkflowStatus(wid, "running"))
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::G`, status: "running" }))

    // Simulate what the timer + retry-exhaustion paths now do: call
    // handleNodeFailure which marks failed + cascade + converge.
    Effect.runSync(engine.handleNodeFailure(wid, `${wid}::G`, new Error("node exceeded timeout_ms=30000")))

    const nodes = Effect.runSync(service.listNodes(wid))
    const wf = Effect.runSync(service.getWorkflow(wid))
    const nodeMap = new Map(nodes.map((n) => [n.node_id, n.status] as const))

    expect(nodeMap.get(`${wid}::G`)).toBe("failed")
    expect(nodeMap.get(`${wid}::J`)).toBe("skipped")
    expect(nodeMap.get(`${wid}::K`)).toBe("skipped")
    expect(nodeMap.get(`${wid}::L`)).toBe("skipped")
    expect(wf?.status).toBe("failed")
  })

  it("Idempotence: double handleNodeFailure (timer + retry race) converges once", async () => {
    // If both the timer and the retry-exhaustion path try to converge the same
    // node, the second call must be a safe no-op and the DAG must still converge.
    const service = Effect.runSync(DAGSessionService.make)
    const engine = Effect.runSync(WorkflowEngine.make)

    const { workflowId: wid } = setupWorkflow(service, "timer-retry-race", [
      { id: "A", deps: [], required: true, timeout_ms: 100 },
      { id: "B", deps: ["A"], required: true },
    ])

    Effect.runSync(service.updateWorkflowStatus(wid, "running"))
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))

    // First: timer fires, marks failed, cascades, converges.
    Effect.runSync(engine.handleNodeFailure(wid, `${wid}::A`, new Error("timer-fired-first")))

    // Second: retry exhaustion attempts the same thing. This must NOT throw
    // (state machine rejects failed→failed) and the DAG must remain converged.
    Effect.runSync(engine.handleNodeFailure(wid, `${wid}::A`, new Error("retry-exhausted-second")))

    const nodes = Effect.runSync(service.listNodes(wid))
    const wf = Effect.runSync(service.getWorkflow(wid))
    const nodeMap = new Map(nodes.map((n) => [n.node_id, n.status] as const))

    expect(nodeMap.get(`${wid}::A`)).toBe("failed")
    expect(nodeMap.get(`${wid}::B`)).toBe("skipped")
    expect(wf?.status).toBe("failed")
  })

  it("Optional node timed-out + convergence: workflow = completed (no required failed)", async () => {
    // An optional timing out should NOT fail the workflow — it should cascade-skip
    // and converge to 'completed' when no required node has failed.
    const service = Effect.runSync(DAGSessionService.make)
    const engine = Effect.runSync(WorkflowEngine.make)

    const { workflowId: wid } = setupWorkflow(service, "optional-timeout", [
      { id: "A", deps: [], required: false, timeout_ms: 100 },
      { id: "B", deps: ["A"], required: true },
    ])

    Effect.runSync(service.updateWorkflowStatus(wid, "running"))
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
    Effect.runSync(engine.handleNodeFailure(wid, `${wid}::A`, new Error("optional-timed-out")))

    const nodes = Effect.runSync(service.listNodes(wid))
    const wf = Effect.runSync(service.getWorkflow(wid))
    const nodeMap = new Map(nodes.map((n) => [n.node_id, n.status] as const))

    expect(nodeMap.get(`${wid}::A`)).toBe("failed")
    expect(nodeMap.get(`${wid}::B`)).toBe("skipped")
    expect(wf?.status).toBe("completed")
  })

  it("Stale timer on completed node MUST NOT cascade (v8 regression)", async () => {
    // Regression test for the v8 workflow bug:
    //   F started with timeout_ms=60000. F completed at T+30s.
    //   Due to event-loop lag the timer callback ran at T+67s, AFTER F was already
    //   completed and the spawn effect's Effect.ensuring had cleared the timer ID.
    //   But the timer's Effect.runPromise had already captured the callback; the
    //   callback then called handleNodeFailure(F). The old handleNodeFailure
    //   correctly skipped re-marking failed (idempotency guard), BUT still ran
    //   cascadeSkipDownstream(F) — which wrongly skipped N (F's downstream).
    //
    // Fix: handleNodeFailure must short-circuit entirely when the node is already
    // completed or skipped — a failed-redelivery on an already-completed node is
    // never legitimate and must not trigger cascade.
    const service = Effect.runSync(DAGSessionService.make)
    const engine = Effect.runSync(WorkflowEngine.make)

    const { workflowId: wid } = setupWorkflow(service, "stale-timer-no-cascade", [
      { id: "F", deps: [], required: true, timeout_ms: 60000 },
      { id: "N", deps: ["F"], required: true },
    ])

    Effect.runSync(service.updateWorkflowStatus(wid, "running"))
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::F`, status: "running" }))

    // F legitimately completes (via node_complete tool call inside the spawn).
    Effect.runSync(engine.handleNodeCompletion(wid, `${wid}::F`, "F-ok"))

    // F is now "completed", N should become ready for scheduling. But before N
    // runs, a stale timer callback fires handleNodeFailure(F) — this must be a
    // no-op: F stays completed, N stays ready/pending-to-be-scheduled, workflow
    // does not converge to failed.
    Effect.runSync(engine.handleNodeFailure(wid, `${wid}::F`, new Error("stale timer redelivery")))

    const nodes = Effect.runSync(service.listNodes(wid))
    const wf = Effect.runSync(service.getWorkflow(wid))
    const nodeMap = new Map(nodes.map((n) => [n.node_id, n.status] as const))

    expect(nodeMap.get(`${wid}::F`)).toBe("completed")  // F must NOT become failed
    expect(nodeMap.get(`${wid}::N`)).toBe("pending")   // N must NOT be cascade-skipped
    // Workflow stays running — N is still pending and F is completed; convergence
    // must NOT flip workflow to any terminal status.
    expect(wf?.status).toBe("running")
  })
})
