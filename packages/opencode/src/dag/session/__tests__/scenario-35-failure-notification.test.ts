// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * Scenario 35: DAG workflow failure → parent session notification (WP1)
 *
 * When a DAG workflow converges to status "failed" via maybeFinalizeWorkflow,
 * the engine injects a synthetic text message into the parent session's
 * message buffer. If the parent session is idle, it also reactivates via
 * ops.loop so the user sees the failure alert immediately.
 *
 * Wake strategy:
 *   - busy: inject message only (no disruption)
 *   - idle: inject message + reactivate loop
 *
 * Architecture constraints (archgate PASS):
 *   - SessionStatus.Service captured via Effect.serviceOption (no propagation)
 *   - Best-effort: all notification ops use catchCause → void
 *   - Notification fires AFTER updateWorkflowStatus persist + EventBus emit
 *   - Terminal guard prevents double-notification
 *   - stepMode suppresses maybeFinalizeWorkflow → no notification
 *
 * Test approach:
 *   Uses in-memory SQLite + real DAGSessionService. Engine is constructed
 *   with a mock SessionStatus.Service injected via Effect.provideService.
 *   PromptOps mock records all calls to `prompt` and `loop` for assertion.
 *
 * Coverage (6 cases):
 *   (a) workflow failed + parent idle → message injected + loop reactivated
 *   (b) workflow failed + parent busy → message injected only, no loop
 *   (c) workflow completed → no notification
 *   (d) workflow cancelled → no notification (terminal guard)
 *   (e) SessionStatus.Service unavailable → no notification, workflow still converges
 *   (f) PromptOps unavailable → no notification, workflow still converges
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Database from "@/storage/db"
import { DAGSessionService } from "../session-service"
import { WorkflowEngine } from "../workflow-engine"
import type { DAGConfig, DAGNodeConfig, DAGNodeSession, DAGWorkflowSession } from "../types"
import * as SessionStatus from "@/session/status"
import type { SessionID } from "@/session/schema"
import type { PromptOps } from "@/session/prompt-ops"
import type { SessionPrompt } from "@/session/prompt"
import type { MessageV2 } from "@/session/message-v2"

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
    worker_config: { prompt: "test task" },
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setupWorkflow(service: any, name: string, nodes: { id: string; deps: string[]; required: boolean }[]): { workflowId: string; nodeConfigs: DAGNodeConfig[]; workflow: DAGWorkflowSession } {
  const nodeConfigs = nodes.map((n) => makeNodeConfig(n.id, n.deps, n.required))
  const config: DAGConfig = { name, nodes: nodeConfigs, max_concurrency: 3 }
  const workflow = Effect.runSync(
    service.createWorkflow({
      name,
      chatSessionId: `parent-session-${name}-${Date.now()}`,
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

interface PromptCall {
  sessionID: SessionID
  noReply?: boolean
  parts: SessionPrompt.PromptInput["parts"]
}

interface LoopCall {
  sessionID: SessionID
}

function makeRecordingPromptOps(): PromptOps & { promptCalls: PromptCall[]; loopCalls: LoopCall[] } {
  const promptCalls: PromptCall[] = []
  const loopCalls: LoopCall[] = []
  return {
    promptCalls,
    loopCalls,
    cancel: () => Effect.void,
    resolvePromptParts: () => Effect.succeed([]),
    prompt: (input: SessionPrompt.PromptInput) => {
      promptCalls.push({ sessionID: input.sessionID, noReply: input.noReply, parts: input.parts })
      return Effect.succeed({ messages: [], parts: [] } as unknown as MessageV2.WithParts)
    },
    loop: (input: SessionPrompt.LoopInput) => {
      loopCalls.push({ sessionID: input.sessionID })
      return Effect.succeed({ messages: [], parts: [] } as unknown as MessageV2.WithParts)
    },
  }
}

// ============================================================================
// Test suite
// ============================================================================

describe("Scenario 35: DAG workflow failure notification to parent session", () => {
  beforeAll(() => {
    Flag.OPENCODE_DB = ":memory:"
    Database.Client.reset()
  })
  afterAll(() => {
    Database.Client.reset()
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let service: any
  let mockStatus: { get: (sessionID: SessionID) => Effect.Effect<SessionStatus.Info>; list: () => Effect.Effect<Map<SessionID, SessionStatus.Info>>; set: (sessionID: SessionID, status: SessionStatus.Info) => Effect.Effect<void> }
  let mockPromptOps: ReturnType<typeof makeRecordingPromptOps>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let engine: any

  beforeEach(() => {
    service = Effect.runSync(DAGSessionService.make)

    mockStatus = {
      get: (_sessionID: SessionID) => Effect.succeed({ type: "idle" } as SessionStatus.Info),
      list: () => Effect.succeed(new Map<SessionID, SessionStatus.Info>()),
      set: () => Effect.void,
    }

    mockPromptOps = makeRecordingPromptOps()

    engine = Effect.runSync(
      WorkflowEngine.make.pipe(
        Effect.provideService(SessionStatus.Service, mockStatus as SessionStatus.Interface),
      ),
    )
    engine.setPromptOps(mockPromptOps)
  })

  // --------------------------------------------------------------------------
  // (a) workflow failed + parent idle → message injected + loop reactivated
  // --------------------------------------------------------------------------
  it("(a) workflow failed + parent idle → message injected + loop reactivated", () => {
    const { workflowId, workflow } = setupWorkflow(service, "test-35a", [
      { id: "a", deps: [], required: true },
    ])
    const parentSessionID = workflow.chat_session_id as SessionID
    const nodeIdA = `${workflowId}::a`

    // Start workflow
    Effect.runSync(engine.startWorkflow(workflowId, { name: "test-35a", nodes: [], max_concurrency: 3 }))

    // Pre-set node A to running (required for handleNodeFailure)
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "running" }))

    // Drive convergence via handleNodeFailure — this marks A failed then calls maybeFinalizeWorkflow
    Effect.runSync(engine.handleNodeFailure(workflowId, nodeIdA, new Error("test failure")))

    // Verify workflow converged to failed
    const wf = Effect.runSync(service.getWorkflow(workflowId)) as DAGWorkflowSession
    expect(wf.status).toBe("failed")

    // Verify notification message was injected (exactly 1 prompt call with noReply)
    const notifyCalls = mockPromptOps.promptCalls.filter((c) => c.sessionID === parentSessionID && c.noReply === true)
    expect(notifyCalls.length).toBe(1)
    const textPart = notifyCalls[0].parts.find((p): p is MessageV2.TextPartInput => p.type === "text")
    expect(textPart).toBeDefined()
    expect(textPart!.synthetic).toBe(true)
    expect(textPart!.text).toContain("dag_workflow_failed")
    expect(textPart!.text).toContain(workflowId)

    // Verify loop was reactivated (parent was idle)
    const loopForParent = mockPromptOps.loopCalls.filter((c) => c.sessionID === parentSessionID)
    expect(loopForParent.length).toBe(1)
  })

  // --------------------------------------------------------------------------
  // (b) workflow failed + parent busy → message injected only, no loop
  // --------------------------------------------------------------------------
  it("(b) workflow failed + parent busy → message injected only, no loop", () => {
    // Override: parent is busy
    mockStatus.get = () => Effect.succeed({ type: "busy" } as SessionStatus.Info)
    // Rebuild engine with updated mock
    engine = Effect.runSync(
      WorkflowEngine.make.pipe(
        Effect.provideService(SessionStatus.Service, mockStatus as SessionStatus.Interface),
      ),
    )
    engine.setPromptOps(mockPromptOps)

    const { workflowId, workflow } = setupWorkflow(service, "test-35b", [
      { id: "a", deps: [], required: true },
    ])
    const parentSessionID = workflow.chat_session_id as SessionID
    const nodeIdA = `${workflowId}::a`

    Effect.runSync(engine.startWorkflow(workflowId, { name: "test-35b", nodes: [], max_concurrency: 3 }))
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "running" }))
    Effect.runSync(engine.handleNodeFailure(workflowId, nodeIdA, new Error("test failure")))

    // Verify workflow converged to failed
    const wf = Effect.runSync(service.getWorkflow(workflowId)) as DAGWorkflowSession
    expect(wf.status).toBe("failed")

    // Verify notification message was injected
    const notifyCalls = mockPromptOps.promptCalls.filter((c) => c.sessionID === parentSessionID && c.noReply === true)
    expect(notifyCalls.length).toBe(1)

    // Verify loop was NOT reactivated (parent was busy)
    const loopForParent = mockPromptOps.loopCalls.filter((c) => c.sessionID === parentSessionID)
    expect(loopForParent.length).toBe(0)
  })

  // --------------------------------------------------------------------------
  // (c) workflow completed → completion notification (B3 fix: symmetric with failure)
  // --------------------------------------------------------------------------
  it("(c) workflow completed → completion notification", () => {
    const { workflowId, workflow } = setupWorkflow(service, "test-35c", [
      { id: "a", deps: [], required: true },
    ])
    const parentSessionID = workflow.chat_session_id as SessionID
    const nodeIdA = `${workflowId}::a`

    Effect.runSync(engine.startWorkflow(workflowId, { name: "test-35c", nodes: [], max_concurrency: 3 }))

    // Pre-set node A to running, then complete it
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "running" }))
    Effect.runSync(engine.handleNodeCompletion(workflowId, nodeIdA, "done"))

    // Verify workflow converged to completed
    const wf = Effect.runSync(service.getWorkflow(workflowId)) as DAGWorkflowSession
    expect(wf.status).toBe("completed")

    // B3 fix: completion now emits a symmetric notification (was: no notification)
    const notifyCalls = mockPromptOps.promptCalls.filter((c) => c.sessionID === parentSessionID && c.noReply === true)
    expect(notifyCalls.length).toBe(1)
    const textPart = notifyCalls[0].parts.find((p) => p.type === "text")
    expect(textPart!.text).toContain("dag_workflow_completed")
    expect(textPart!.text).toContain("completed successfully")

    // parent is idle (default mock) → loop reactivated, mirrors failure path (a)
    const loopForParent = mockPromptOps.loopCalls.filter((c) => c.sessionID === parentSessionID)
    expect(loopForParent.length).toBe(1)
  })

  // --------------------------------------------------------------------------
  // (d) workflow cancelled → no notification (terminal guard prevents re-entry)
  // --------------------------------------------------------------------------
  it("(d) workflow cancelled → no notification (terminal guard)", () => {
    const { workflowId, workflow } = setupWorkflow(service, "test-35d", [
      { id: "a", deps: [], required: true },
    ])
    const parentSessionID = workflow.chat_session_id as SessionID
    const nodeIdA = `${workflowId}::a`

    Effect.runSync(engine.startWorkflow(workflowId, { name: "test-35d", nodes: [], max_concurrency: 3 }))

    // Cancel the workflow
    Effect.runSync(engine.cancelWorkflow(workflowId))

    // Verify cancelled
    const wf = Effect.runSync(service.getWorkflow(workflowId)) as DAGWorkflowSession
    expect(wf.status).toBe("cancelled")

    // Try to trigger a late failure — terminal guard in maybeFinalizeWorkflow should prevent notification
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "running" }))
    Effect.runSync(engine.handleNodeFailure(workflowId, nodeIdA, new Error("late failure")))

    // Verify NO notification was sent
    const notifyCalls = mockPromptOps.promptCalls.filter((c) => c.sessionID === parentSessionID && c.noReply === true)
    expect(notifyCalls.length).toBe(0)
  })

  // --------------------------------------------------------------------------
  // (e) SessionStatus.Service unavailable → no notification, workflow still converges
  // --------------------------------------------------------------------------
  it("(e) SessionStatus.Service unavailable → no notification, workflow still converges", () => {
    // Create engine WITHOUT providing SessionStatus.Service
    const e = Effect.runSync(WorkflowEngine.make)
    e.setPromptOps(mockPromptOps)

    const { workflowId, workflow } = setupWorkflow(service, "test-35e", [
      { id: "a", deps: [], required: true },
    ])
    const parentSessionID = workflow.chat_session_id as SessionID
    const nodeIdA = `${workflowId}::a`

    Effect.runSync(e.startWorkflow(workflowId, { name: "test-35e", nodes: [], max_concurrency: 3 }))
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "running" }))
    Effect.runSync(e.handleNodeFailure(workflowId, nodeIdA, new Error("test failure")))

    // Verify workflow still converged to failed
    const wf = Effect.runSync(service.getWorkflow(workflowId)) as DAGWorkflowSession
    expect(wf.status).toBe("failed")

    // Verify NO notification was sent (service unavailable → capturedSessionStatus undefined)
    const notifyCalls = mockPromptOps.promptCalls.filter((c) => c.sessionID === parentSessionID && c.noReply === true)
    expect(notifyCalls.length).toBe(0)
  })

  // --------------------------------------------------------------------------
  // (f) PromptOps unavailable → no notification, workflow still converges
  // --------------------------------------------------------------------------
  it("(f) PromptOps unavailable → no notification, workflow still converges", () => {
    // Create engine with SessionStatus but WITHOUT setting PromptOps
    const e = Effect.runSync(
      WorkflowEngine.make.pipe(
        Effect.provideService(SessionStatus.Service, mockStatus as SessionStatus.Interface),
      ),
    )
    // NOTE: NOT calling e.setPromptOps() — _promptOps stays undefined

    const { workflowId, workflow } = setupWorkflow(service, "test-35f", [
      { id: "a", deps: [], required: true },
    ])
    const parentSessionID = workflow.chat_session_id as SessionID
    const nodeIdA = `${workflowId}::a`

    Effect.runSync(e.startWorkflow(workflowId, { name: "test-35f", nodes: [], max_concurrency: 3 }))
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "running" }))
    Effect.runSync(e.handleNodeFailure(workflowId, nodeIdA, new Error("test failure")))

    // Verify workflow still converged to failed
    const wf = Effect.runSync(service.getWorkflow(workflowId)) as DAGWorkflowSession
    expect(wf.status).toBe("failed")

    // Verify NO notification was sent (promptOps unavailable)
    const notifyCalls = mockPromptOps.promptCalls.filter((c) => c.sessionID === parentSessionID && c.noReply === true)
    expect(notifyCalls.length).toBe(0)
  })
})
