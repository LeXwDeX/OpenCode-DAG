// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * Scenario 23: Recovery Resume (WP-A2) — orphaned workflow auto-resume tests.
 *
 * Exercises the WP-A2 resume assembly path in `recoverOrphanedWorkflows`:
 * 1. Normal resume: engine rebuilt + concurrencyRegistry filled + workflow stays running
 * 2. Assembly failure fallback: no promptOps → legacy mark-failed path
 * 3. Idempotent: second call skips already-assembled workflow
 *
 * Acceptance criteria (009-dag-capability-expansion.md §7 WP-A2):
 * - DB-level integration test: orphaned running workflow → engine rebuilt
 * - Pending/ready nodes can be rescheduled (engine + daemon functional)
 * - Assembly failure → fallback to mark-failed (no stuck state)
 * - Idempotent: repeat recovery does not duplicate engine/daemon
 *
 * Infrastructure:
 * - Flag.OPENCODE_DB = ":memory:" + Database.Client.reset() (isolated in-memory SQLite)
 * - DAGSessionService.make and WorkflowEngine.make via Effect.runSync
 * - Mock PromptOps (never actually invoked — only injected into engine)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Database from "@/storage/db"
import { DAGSessionService } from "../session-service"
import { WorkflowEngine, unregisterEngine, __internal_concurrencyRegistry } from "../workflow-engine"
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

/**
 * Creates a PromptOps stub for testing assembly injection. The stub is never
 * actually invoked by the recovery path (spawnReadyNode requires heavy Effect
 * context that is not provided in these tests). It exists solely to satisfy
 * `setPromptOps` in the assembly flow.
 */
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

describe("scenario-23: recovery resume (WP-A2)", () => {
  const originalDb = Flag.OPENCODE_DB

  beforeEach(() => {
    Flag.OPENCODE_DB = ":memory:"
    Database.Client.reset()
  })

  afterEach(() => {
    try { Database.close() } catch { /* ignore */ }
    Flag.OPENCODE_DB = originalDb
    Database.Client.reset()
  })

  it("normal resume: engine rebuilt + concurrencyRegistry filled + workflow stays running", () => {
    const service = Effect.runSync(DAGSessionService.make)

    // Setup: orphan workflow with 2 nodes (A=pending, B=pending dep A)
    const { workflowId: wid } = setupWorkflow(service, "resume-test", [
      { id: "A", deps: [], required: true },
      { id: "B", deps: ["A"], required: false },
    ], /* maxConcurrency */ 5)

    // Push workflow to running; both nodes stay pending (default from createNode)
    Effect.runSync(service.updateWorkflowStatus(wid, "running"))
    // A and B remain pending — no engine means no prior startWorkflow

    // No engine registered → orphan
    expect(WorkflowEngine.get(wid)).toBeUndefined()

    // Trigger recovery with promptOps
    const result = Effect.runSync(recoverOrphanedWorkflows(service, mockPromptOps()))

    // Assertions
    expect(result.scanned).toBe(1)
    expect(result.resumed).toBe(1)
    expect(result.marked).toBe(0)

    // Engine is registered
    expect(WorkflowEngine.get(wid)).not.toBeUndefined()

    // concurrencyRegistry filled from config.max_concurrency
    expect(__internal_concurrencyRegistry().get(wid)).toBe(5)

    // Workflow status remains 'running' (NOT failed — resume succeeded)
    const wfAfter = Effect.runSync(service.getWorkflow(wid))
    expect(wfAfter?.status).toBe("running")

    // Cleanup: unregister to avoid polluting other tests
    unregisterEngine(wid)
  })

  it("assembly failure fallback: no promptOps → legacy mark-failed path", () => {
    const service = Effect.runSync(DAGSessionService.make)

    const { workflowId: wid } = setupWorkflow(service, "fallback-test", [
      { id: "X", deps: [], required: true },
      { id: "Y", deps: ["X"], required: true },
    ])

    // Push workflow to running, X running (orphan at restart)
    Effect.runSync(service.updateWorkflowStatus(wid, "running"))
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::X`, status: "running" }))

    // No engine → orphan. Call WITHOUT promptOps (undefined)
    const result = Effect.runSync(recoverOrphanedWorkflows(service))

    // Assertions: legacy fallback — workflow marked failed
    expect(result.scanned).toBe(1)
    expect(result.marked).toBe(1)
    expect(result.resumed).toBe(0)

    // Workflow status = failed
    const wfAfter = Effect.runSync(service.getWorkflow(wid))
    expect(wfAfter?.status).toBe("failed")

    // process_orphan violation created
    const violations = Effect.runSync(service.listViolations(wid))
    const orphanViolations = violations.filter(v => v.type === "process_orphan")
    expect(orphanViolations.length).toBe(1)

    // Node transitions: X (running→failed), Y (pending→skipped)
    const nodes = Effect.runSync(service.listNodes(wid))
    const nodeMap = new Map(nodes.map(n => [n.node_id, n.status] as const))
    expect(nodeMap.get(`${wid}::X`)).toBe("failed")
    expect(nodeMap.get(`${wid}::Y`)).toBe("skipped")

    // No engine leaked (cleanup happened on fallback)
    expect(WorkflowEngine.get(wid)).toBeUndefined()
  })

  it("idempotent: second call skips already-assembled workflow", () => {
    const service = Effect.runSync(DAGSessionService.make)

    const { workflowId: wid } = setupWorkflow(service, "idempotent-test", [
      { id: "P", deps: [], required: true },
    ])

    // Push workflow to running; P stays pending
    Effect.runSync(service.updateWorkflowStatus(wid, "running"))

    // No engine → orphan
    expect(WorkflowEngine.get(wid)).toBeUndefined()

    // First recovery: should resume (register engine)
    const first = Effect.runSync(recoverOrphanedWorkflows(service, mockPromptOps()))

    expect(first.scanned).toBe(1)
    expect(first.resumed).toBe(1)
    expect(first.marked).toBe(0)
    expect(WorkflowEngine.get(wid)).not.toBeUndefined()

    // Second recovery: engine exists → skipped (idempotent)
    const second = Effect.runSync(recoverOrphanedWorkflows(service, mockPromptOps()))

    expect(second.scanned).toBe(1)
    expect(second.resumed).toBe(0)
    expect(second.marked).toBe(0)

    // Workflow still running (not failed)
    const wfAfter = Effect.runSync(service.getWorkflow(wid))
    expect(wfAfter?.status).toBe("running")

    // Engine still registered
    expect(WorkflowEngine.get(wid)).not.toBeUndefined()

    // Cleanup
    unregisterEngine(wid)
  })
})
