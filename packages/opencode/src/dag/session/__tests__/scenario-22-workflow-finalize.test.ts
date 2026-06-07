/**
 * Scenario 22-26: Workflow terminal state convergence integration tests.
 *
 * Exercises `findPendingDescendants`, `cascadeSkipDownstream`, and
 * `maybeFinalizeWorkflow` to ensure workflows converge to 'completed' or
 * 'failed' status when all nodes reach terminal states, without waiting
 * for the 10-minute executor timeout.
 *
 * Infrastructure:
 * - Flag.OPENCODE_DB = ":memory:" enables in-memory SQLite (db.ts:39-41)
 * - Database.Client.reset() forces re-initialization with the in-memory DB
 * - Migrations auto-apply from packages/opencode/migration/ (including DAG tables)
 * - DAGSessionService.make and WorkflowEngine.make run via Effect.runSync
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Database from "@/storage/db"
import { DAGSessionService } from "../session-service"
import { WorkflowEngine, findPendingDescendants } from "../workflow-engine"
import type { DAGConfig, DAGNodeConfig, DAGNodeSession, DAGWorkflowSession } from "../types"

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
    readonly createWorkflow: (input: { name: string; chatSessionId: string; config: DAGConfig; metadata?: Record<string, unknown> }) => Effect.Effect<DAGWorkflowSession>
    readonly createNode: (input: { workflowId: string; nodeId?: string; name: string; nodeName: string; nodeType: string; config: DAGNodeConfig; dependencyNodes?: string[]; timeoutMs?: number; maxRetries?: number }) => Effect.Effect<DAGNodeSession>
  },
  name: string,
  nodes: { id: string; deps: string[]; required: boolean }[],
): { workflowId: string; nodeConfigs: DAGNodeConfig[] } {
  const nodeConfigs = nodes.map((n) => makeNodeConfig(n.id, n.deps, n.required))
  const config: DAGConfig = {
    name,
    nodes: nodeConfigs,
    max_concurrency: 3,
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
  return { workflowId: workflow.id, nodeConfigs }
}

// ============================================================================
// findPendingDescendants — pure function
// ============================================================================

describe("findPendingDescendants (pure function)", () => {
  it("Scenario 22a: collects downstream pending descendants via BFS", () => {
    const nodes: DAGNodeSession[] = [
      { node_id: "A", status: "failed", dependencies: [] } as any,
      { node_id: "B", status: "pending", dependencies: ["A"] } as any,
      { node_id: "C", status: "pending", dependencies: ["B"] } as any,
      { node_id: "D", status: "pending", dependencies: ["C"] } as any,
    ]
    const result = findPendingDescendants(nodes, "A")
    const ids = result.map((n) => n.node_id).sort()
    expect(ids).toEqual(["B", "C", "D"])
  })

  it("Scenario 22b: skips non-pending descendants (already running)", () => {
    const nodes: DAGNodeSession[] = [
      { node_id: "A", status: "failed", dependencies: [] } as any,
      { node_id: "B", status: "running", dependencies: ["A"] } as any,
      { node_id: "C", status: "pending", dependencies: ["B"] } as any,
    ]
    const result = findPendingDescendants(nodes, "A")
    const ids = result.map((n) => n.node_id).sort()
    expect(ids).toEqual([])
  })

  it("Scenario 22c: handles diamond dependency pattern", () => {
    const nodes: DAGNodeSession[] = [
      { node_id: "A", status: "failed", dependencies: [] } as any,
      { node_id: "B", status: "pending", dependencies: ["A"] } as any,
      { node_id: "C", status: "pending", dependencies: ["A"] } as any,
      { node_id: "D", status: "pending", dependencies: ["B", "C"] } as any,
    ]
    const result = findPendingDescendants(nodes, "A")
    const ids = result.map((n) => n.node_id).sort()
    expect(ids).toEqual(["B", "C", "D"])
  })
})

// ============================================================================
// Workflow terminal convergence — real DB + real helpers
// ============================================================================

describe("workflow terminal convergence (real DB + real helpers)", () => {
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

  it("Scenario 23: required failed → workflow = failed, downstream skipped", async () => {
    const service = Effect.runSync(DAGSessionService.make)
    const engine = Effect.runSync(WorkflowEngine.make)

    const { workflowId } = setupWorkflow(service, "cascade-skip-test", [
      { id: "A", deps: [], required: true },
      { id: "B", deps: ["A"], required: true },
      { id: "C", deps: ["B"], required: true },
    ])
    const wid = workflowId

    // Simulate startWorkflow pushing workflow to running (no fork in sync context)
    Effect.runSync(service.updateWorkflowStatus(wid, "running"))

    // Simulate fork fiber pushing A to running, then A completes
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
    Effect.runSync(engine.handleNodeCompletion(wid, `${wid}::A`, "ok-a"))

    // Simulate fork fiber pushing B to running, then B fails
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::B`, status: "running" }))
    Effect.runSync(engine.handleNodeFailure(wid, `${wid}::B`, new Error("fatal-b")))

    // Verify: C auto-skipped via cascade, workflow = failed
    const nodes = Effect.runSync(service.listNodes(wid))
    const wfAfter = Effect.runSync(service.getWorkflow(wid))
    const nodeMap = new Map(nodes.map((n) => [n.node_id, n.status] as const))

    expect(nodeMap.get(`${wid}::A`)).toBe("completed")
    expect(nodeMap.get(`${wid}::B`)).toBe("failed")
    expect(nodeMap.get(`${wid}::C`)).toBe("skipped")
    expect(wfAfter?.status).toBe("failed")
  })

  it("Scenario 24: optional failed + required all pass → workflow = completed", async () => {
    const service = Effect.runSync(DAGSessionService.make)
    const engine = Effect.runSync(WorkflowEngine.make)

    const { workflowId } = setupWorkflow(service, "optional-fail-test", [
      { id: "A", deps: [], required: true },
      { id: "B", deps: ["A"], required: false },
      { id: "C", deps: ["B"], required: true },
    ])
    const wid = workflowId

    // Simulate startWorkflow pushing workflow to running (no fork in sync context)
    Effect.runSync(service.updateWorkflowStatus(wid, "running"))

    // Simulate fork fiber pushing A to running, then A completes
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
    Effect.runSync(engine.handleNodeCompletion(wid, `${wid}::A`, "ok-a"))

    // B failed (optional) → cascade skips C
    // Since B is not required and C is only skipped (not failed), workflow → completed
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::B`, status: "running" }))
    Effect.runSync(engine.handleNodeFailure(wid, `${wid}::B`, new Error("optional-b-fail")))

    const nodes = Effect.runSync(service.listNodes(wid))
    const wfAfter = Effect.runSync(service.getWorkflow(wid))
    const nodeMap = new Map(nodes.map((n) => [n.node_id, n.status] as const))

    expect(nodeMap.get(`${wid}::A`)).toBe("completed")
    expect(nodeMap.get(`${wid}::B`)).toBe("failed")
    expect(nodeMap.get(`${wid}::C`)).toBe("skipped")
    expect(wfAfter?.status).toBe("completed")
  })

  it("Scenario 25: all required completed → workflow = completed", async () => {
    const service = Effect.runSync(DAGSessionService.make)
    const engine = Effect.runSync(WorkflowEngine.make)

    const { workflowId } = setupWorkflow(service, "all-complete-test", [
      { id: "A", deps: [], required: true },
      { id: "B", deps: ["A"], required: true },
      { id: "C", deps: ["B"], required: true },
    ])
    const wid = workflowId

    // Simulate startWorkflow pushing workflow to running (no fork in sync context)
    Effect.runSync(service.updateWorkflowStatus(wid, "running"))

    // A → B → C all complete (each needs running transition first)
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
    Effect.runSync(engine.handleNodeCompletion(wid, `${wid}::A`, "ok-a"))
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::B`, status: "running" }))
    Effect.runSync(engine.handleNodeCompletion(wid, `${wid}::B`, "ok-b"))
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::C`, status: "running" }))
    Effect.runSync(engine.handleNodeCompletion(wid, `${wid}::C`, "ok-c"))

    const wfAfter = Effect.runSync(service.getWorkflow(wid))
    expect(wfAfter?.status).toBe("completed")
  })

  it("Scenario 26: idempotent guard — cancelled workflow stays cancelled after late completion", async () => {
    const service = Effect.runSync(DAGSessionService.make)
    const engine = Effect.runSync(WorkflowEngine.make)

    const { workflowId } = setupWorkflow(service, "idempotent-guard-test", [
      { id: "A", deps: [], required: true },
    ])
    const wid = workflowId

    // Simulate startWorkflow pushing workflow to running (no fork in sync context)
    Effect.runSync(service.updateWorkflowStatus(wid, "running"))

    // Cancel before any node completes
    Effect.runSync(engine.cancelWorkflow(wid))

    // Late completion (race condition) — maybeFinalize must be a no-op
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
    Effect.runSync(engine.handleNodeCompletion(wid, `${wid}::A`, "late-complete"))

    const wfAfter = Effect.runSync(service.getWorkflow(wid))
    expect(wfAfter?.status).toBe("cancelled")
  })
})
