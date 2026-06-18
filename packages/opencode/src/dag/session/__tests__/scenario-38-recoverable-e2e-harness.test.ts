// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * Scenario 38: WP6 recoverable E2E harness — full integration path
 *
 * End-to-end test validating the complete WP0-WP5 recoverable chain:
 *   1. Workflow contains completed A + recoverable B + pending C
 *   2. B enters recoverable (non-terminal) — no WP1 notification
 *   3. Parent agent replans: remove B+C, add B2+C2
 *   4. B2 is immediately scheduled by forked scheduleReadyNodes
 *   5. B2+C2 complete → workflow converges to completed
 *   6. WP1 notification never fires (workflow never entered "failed")
 *
 * Sub-scenarios:
 *   (b) abandon — recoverable node transitions to failed (abandon decision),
 *       WP1 notification fires after maybeFinalizeWorkflow converges to "failed"
 *   (c) pause + replan — workflow paused, replan executes, resume triggers
 *       forked scheduleReadyNodes for the replacement node
 *
 * Architecture constraints (archgate PASS):
 *   - DAG iron law #1/#2: state changes via state machine API, terminal states immutable
 *   - execution-core A-layer: buildReplanDbInputs namespaces add_nodes dependencies
 *   - DAG persistence schema independent of storage schema
 *   - SessionStatus.Service captured via serviceOption, undefined when not provided
 *
 * Coverage (3 cases):
 *   (a) full recoverable E2E: A→B(recoverable)→C → replan → B2→C2 → completed, no WP1
 *   (b) abandon sub-scenario: B recoverable → failed → workflow failed → WP1 fires
 *   (c) pause + replan: B recoverable → pause → replan → resume → B2 scheduled
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import { eq, and } from "drizzle-orm"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Database from "@/storage/db"
import { DAGSessionService } from "../session-service"
import { WorkflowEngine, __internal_spawnedNodes } from "../workflow-engine"
import { computeFinalWorkflowStatus } from "../execution-core"
import { isNodeTerminalStatus } from "../types"
import { dagWorkflowHistory } from "../../persistence/schema"
import type {
  DAGConfig,
  DAGNodeConfig,
  DAGNodeSession,
  DAGWorkflowSession,
  ReplanResult,
} from "../types"
import type { SessionID } from "@/session/schema"
import * as SessionStatus from "@/session/status"
import type { PromptOps } from "@/session/prompt-ops"
import type { SessionPrompt } from "@/session/prompt"
import type { MessageV2 } from "@/session/message-v2"

// ============================================================================
// Helpers (mirrors scenario-35/37 setup)
// ============================================================================

function makeNodeConfig(
  id: string,
  deps: string[],
  required: boolean,
  failurePolicy?: "fail" | "recoverable",
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
function setupWorkflow(
  service: any,
  name: string,
  nodes: { id: string; deps: string[]; required: boolean; failurePolicy?: "fail" | "recoverable" }[],
): { workflowId: string; nodeConfigs: DAGNodeConfig[]; workflow: DAGWorkflowSession } {
  const nodeConfigs = nodes.map((n) => makeNodeConfig(n.id, n.deps, n.required, n.failurePolicy))
  const config: DAGConfig = { name, nodes: nodeConfigs, max_concurrency: 3 }
  const workflow = Effect.runSync(
    service.createWorkflow({
      name,
      chatSessionId: `s38-session-${name}-${Date.now()}`,
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

/**
 * Poll a predicate up to `maxAttempts` times with `delayMs` interval.
 * Returns true if the predicate becomes truthy, false if timeout.
 */
async function pollFor(predicate: () => boolean, delayMs = 50, maxAttempts = 20): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, delayMs))
  }
  return false
}

// ============================================================================
// Test suite
// ============================================================================

describe("Scenario 38: WP6 recoverable E2E harness", () => {
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let service: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let engine: any
  let mockPromptOps: ReturnType<typeof makeRecordingPromptOps>
  let mockStatus: {
    get: (sessionID: SessionID) => Effect.Effect<SessionStatus.Info>
    list: () => Effect.Effect<Map<SessionID, SessionStatus.Info>>
    set: (sessionID: SessionID, status: SessionStatus.Info) => Effect.Effect<void>
  }

  beforeEach(() => {
    service = Effect.runSync(DAGSessionService.make)

    // Adopt the scenario-35 mock shape (archgate advisory A1)
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
    __internal_spawnedNodes().clear()
  })

  afterEach(() => {
    __internal_spawnedNodes().clear()
  })

  // --------------------------------------------------------------------------
  // (a) Full recoverable E2E: A→B(recoverable)→C → replan → B2→C2 → completed
  // --------------------------------------------------------------------------
  it("(a) full recoverable E2E: A completed + B recoverable → replan → B2+C2 → workflow completed, no WP1", async () => {
    // Setup: A (required) → B (recoverable, non-required) → C (non-required, dep: B)
    const { workflowId, workflow } = setupWorkflow(service, "test-38a", [
      { id: "a", deps: [], required: true },
      { id: "b", deps: ["a"], required: false, failurePolicy: "recoverable" },
      { id: "c", deps: ["b"], required: false },
    ])
    const parentSessionID = workflow.chat_session_id as SessionID
    const nodeIdA = `${workflowId}::a`
    const nodeIdB = `${workflowId}::b`
    const nodeIdC = `${workflowId}::c`

    // Start workflow
    Effect.runSync(engine.startWorkflow(workflowId, { name: "test-38a", nodes: [], max_concurrency: 3 }))

    // Drive A to completed
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "running" }))
    Effect.runSync(engine.handleNodeCompletion(workflowId, nodeIdA, "A done"))

    // Verify A is completed
    const nodeA = Effect.runSync(service.getNode(nodeIdA)) as DAGNodeSession
    expect(nodeA.status).toBe("completed")

    // Drive B to running, then trigger failure → recoverable
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdB, status: "running" }))
    Effect.runSync(engine.handleNodeFailure(workflowId, nodeIdB, new Error("B failed recoverably")))

    // ASSERT: B is recoverable (non-terminal)
    const nodeB = Effect.runSync(service.getNode(nodeIdB)) as DAGNodeSession
    expect(nodeB.status).toBe("recoverable")
    expect(isNodeTerminalStatus("recoverable")).toBe(false)

    // ASSERT: C stays pending (no cascade skip)
    const nodeC = Effect.runSync(service.getNode(nodeIdC)) as DAGNodeSession
    expect(nodeC.status).toBe("pending")

    // ASSERT: Workflow is non-terminal (still running/paused)
    const wf1 = Effect.runSync(service.getWorkflow(workflowId)) as DAGWorkflowSession
    expect(["running", "paused"]).toContain(wf1.status)

    // ASSERT: computeFinalWorkflowStatus sees recoverable as in-progress → null
    expect(computeFinalWorkflowStatus([nodeA, nodeB, nodeC])).toBeNull()

    // ASSERT: WP1 notification NOT triggered (workflow not in failed state)
    const notifyCallsBefore = mockPromptOps.promptCalls.filter(
      (c) => c.sessionID === parentSessionID && c.noReply === true,
    )
    expect(notifyCallsBefore.length).toBe(0)
    expect(mockPromptOps.loopCalls.filter((c) => c.sessionID === parentSessionID).length).toBe(0)

    // REPLAN: remove B+C, add B2 (dep: A) + C2 (dep: B2) using short cfg IDs
    const replanResult = Effect.runSync(engine.replanWorkflow(workflowId, {
      workflow_id: workflowId,
      remove_nodes: [nodeIdB, nodeIdC],
      add_nodes: [
        { id: "b2", name: "b2", dependencies: ["a"], required: true, worker_type: "general", worker_config: { prompt: "replacement b2" } },
        { id: "c2", name: "c2", dependencies: ["b2"], required: true, worker_type: "general", worker_config: { prompt: "replacement c2" } },
      ],
      changed_by: "scenario-38a",
    })) as ReplanResult

    // ASSERT: replan succeeded
    expect(replanResult.ok).toBe(true)
    if (replanResult.ok) {
      expect(replanResult.nodes_removed).toBe(2)
      expect(replanResult.nodes_added).toBe(2)
    }

    // ASSERT: B and C removed from DB
    expect(Effect.runSync(service.getNode(nodeIdB))).toBeFalsy()
    expect(Effect.runSync(service.getNode(nodeIdC))).toBeFalsy()

    // ASSERT: B2 and C2 exist with correct status
    const nodeIdB2 = `${workflowId}::b2`
    const nodeIdC2 = `${workflowId}::c2`
    const nodeB2 = Effect.runSync(service.getNode(nodeIdB2)) as DAGNodeSession
    expect(nodeB2).toBeTruthy()
    expect(["pending", "running"]).toContain(nodeB2.status)
    expect(nodeB2.dependencies).toEqual([nodeIdA])

    const nodeC2 = Effect.runSync(service.getNode(nodeIdC2)) as DAGNodeSession
    expect(nodeC2).toBeTruthy()
    expect(["pending", "running"]).toContain(nodeC2.status)
    expect(nodeC2.dependencies).toEqual([nodeIdB2])

    // ASSERT: B2 is in spawnedNodes (scheduleReadyNodes forked after replan)
    const b2Spawned = await pollFor(() => __internal_spawnedNodes().has(nodeIdB2), 50, 20)
    expect(b2Spawned).toBe(true)

    // Drive B2: pending/running → completed
    if (nodeB2.status !== "running") {
      Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdB2, status: "running" }))
    }
    Effect.runSync(engine.handleNodeCompletion(workflowId, nodeIdB2, "B2 done"))

    // Drive C2: pending → running → completed
    const nodeC2After = Effect.runSync(service.getNode(nodeIdC2)) as DAGNodeSession
    if (nodeC2After.status !== "running") {
      Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdC2, status: "running" }))
    }
    Effect.runSync(engine.handleNodeCompletion(workflowId, nodeIdC2, "C2 done"))

    // ASSERT: workflow converged to completed
    const wfFinal = Effect.runSync(service.getWorkflow(workflowId)) as DAGWorkflowSession
    expect(wfFinal.status).toBe("completed")

    // ASSERT: final node states
    const finalA = Effect.runSync(service.getNode(nodeIdA)) as DAGNodeSession
    expect(finalA.status).toBe("completed")
    const finalB2 = Effect.runSync(service.getNode(nodeIdB2)) as DAGNodeSession
    expect(finalB2.status).toBe("completed")
    const finalC2 = Effect.runSync(service.getNode(nodeIdC2)) as DAGNodeSession
    expect(finalC2.status).toBe("completed")

    // ASSERT: removed nodes remain gone
    expect(Effect.runSync(service.getNode(nodeIdB))).toBeFalsy()
    expect(Effect.runSync(service.getNode(nodeIdC))).toBeFalsy()

    // ASSERT: audit history has a replan row
    const historyRows = Database.use((db) =>
      db.select()
        .from(dagWorkflowHistory)
        .where(and(
          eq(dagWorkflowHistory.workflow_id, workflowId),
          eq(dagWorkflowHistory.action, "replan"),
        ))
        .all(),
    )
    expect(historyRows.length).toBeGreaterThanOrEqual(1)
    const row = historyRows[0]
    const changeDetails = row.change_details as Record<string, unknown>
    expect(changeDetails).toBeTruthy()
    expect(changeDetails.removed).toContain(nodeIdB)
    expect(changeDetails.removed).toContain(nodeIdC)

    // ASSERT: WP1 FAILURE notification NEVER triggered throughout the entire flow.
    // B3 fix: workflow converged to completed, so a completion notification IS
    // expected (notifyParentOfCompletion). The assertion must distinguish failure
    // notifications (dag_workflow_failed) from completion notifications
    // (dag_workflow_completed) — only the failure kind must be absent here.
    const failureNotifyCalls = mockPromptOps.promptCalls.filter(
      (c) => c.sessionID === parentSessionID && c.noReply === true &&
        c.parts.some((p) => p.type === "text" && (p as { text?: string }).text?.includes("dag_workflow_failed")),
    )
    expect(failureNotifyCalls.length).toBe(0)

    // Completion notification is expected and acceptable (B3 symmetric behavior).
    const completionNotifyCalls = mockPromptOps.promptCalls.filter(
      (c) => c.sessionID === parentSessionID && c.noReply === true &&
        c.parts.some((p) => p.type === "text" && (p as { text?: string }).text?.includes("dag_workflow_completed")),
    )
    expect(completionNotifyCalls.length).toBeLessThanOrEqual(1)
  })

  // --------------------------------------------------------------------------
  // (b) Abandon sub-scenario: recoverable → failed → WP1 notification fires
  // --------------------------------------------------------------------------
  it("(b) abandon: recoverable node → failed (abandon decision) → workflow failed → WP1 fires", () => {
    // Setup: A (required) + B (required, recoverable) — B required so failure finalizes workflow
    const { workflowId, workflow } = setupWorkflow(service, "test-38b", [
      { id: "a", deps: [], required: true },
      { id: "b", deps: ["a"], required: true, failurePolicy: "recoverable" },
    ])
    const parentSessionID = workflow.chat_session_id as SessionID
    const nodeIdA = `${workflowId}::a`
    const nodeIdB = `${workflowId}::b`

    // Start workflow
    Effect.runSync(engine.startWorkflow(workflowId, { name: "test-38b", nodes: [], max_concurrency: 3 }))

    // Drive A to completed
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "running" }))
    Effect.runSync(engine.handleNodeCompletion(workflowId, nodeIdA, "A done"))

    // Drive B running → recoverable via handleNodeFailure
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdB, status: "running" }))
    Effect.runSync(engine.handleNodeFailure(workflowId, nodeIdB, new Error("B failed recoverably")))

    // ASSERT: B is recoverable, workflow not failed
    const nodeB1 = Effect.runSync(service.getNode(nodeIdB)) as DAGNodeSession
    expect(nodeB1.status).toBe("recoverable")
    const wf1 = Effect.runSync(service.getWorkflow(workflowId)) as DAGWorkflowSession
    expect(wf1.status).not.toBe("failed")

    // Simulate parent agent abandon decision:
    // 1. Manually transition B from recoverable → failed (abandon)
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdB, status: "failed" }))

    // 2. Call handleNodeFailure to trigger cascade + maybeFinalizeWorkflow
    //    Idempotent guard: node was already transitioned to failed, so
    //    handleNodeFailure still proceeds with cascade/finalize safely.
    Effect.runSync(engine.handleNodeFailure(workflowId, nodeIdB, new Error("abandon")))

    // ASSERT: workflow converged to failed (B was required)
    const wfFinal = Effect.runSync(service.getWorkflow(workflowId)) as DAGWorkflowSession
    expect(wfFinal.status).toBe("failed")

    // ASSERT: WP1 notification fired — idle parent gets noReply prompt injection
    const notifyCalls = mockPromptOps.promptCalls.filter(
      (c) => c.sessionID === parentSessionID && c.noReply === true,
    )
    expect(notifyCalls.length).toBeGreaterThanOrEqual(1)

    // ASSERT: notification contains dag_workflow_failed marker
    const textPart = notifyCalls[0].parts.find(
      (p): p is MessageV2.TextPartInput => p.type === "text",
    )
    expect(textPart).toBeDefined()
    expect(textPart!.synthetic).toBe(true)
    expect(textPart!.text).toContain("dag_workflow_failed")
    expect(textPart!.text).toContain(workflowId)

    // ASSERT: loop reactivated (parent was idle)
    expect(mockPromptOps.loopCalls.filter((c) => c.sessionID === parentSessionID).length).toBeGreaterThanOrEqual(1)
  })

  // --------------------------------------------------------------------------
  // (c) Pause + replan: B recoverable → pause → replan → resume → B2 scheduled
  // --------------------------------------------------------------------------
  it("(c) pause + replan: B recoverable → pause workflow → replan → resume → B2 scheduled", async () => {
    // Setup: A (required) → B (recoverable, non-required) → C (non-required, dep: B)
    const { workflowId } = setupWorkflow(service, "test-38c", [
      { id: "a", deps: [], required: true },
      { id: "b", deps: ["a"], required: false, failurePolicy: "recoverable" },
      { id: "c", deps: ["b"], required: false },
    ])
    const nodeIdA = `${workflowId}::a`
    const nodeIdB = `${workflowId}::b`
    const nodeIdC = `${workflowId}::c`

    // Start workflow
    Effect.runSync(engine.startWorkflow(workflowId, { name: "test-38c", nodes: [], max_concurrency: 3 }))

    // Drive A to completed
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "running" }))
    Effect.runSync(engine.handleNodeCompletion(workflowId, nodeIdA, "A done"))

    // Drive B to recoverable
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdB, status: "running" }))
    Effect.runSync(engine.handleNodeFailure(workflowId, nodeIdB, new Error("B failed recoverably")))

    // ASSERT: B is recoverable
    const nodeB = Effect.runSync(service.getNode(nodeIdB)) as DAGNodeSession
    expect(nodeB.status).toBe("recoverable")

    // Pause workflow
    Effect.runSync(engine.pauseWorkflow(workflowId))

    // ASSERT: workflow is paused
    const wfPaused = Effect.runSync(service.getWorkflow(workflowId)) as DAGWorkflowSession
    expect(wfPaused.status).toBe("paused")

    // Replan: remove B and C, add B2 (dep: A) using short cfg ID
    const nodeIdB2 = `${workflowId}::b2`
    const replanResult = Effect.runSync(engine.replanWorkflow(workflowId, {
      workflow_id: workflowId,
      remove_nodes: [nodeIdB, nodeIdC],
      add_nodes: [
        { id: "b2", name: "b2", dependencies: ["a"], required: true, worker_type: "general", worker_config: { prompt: "replacement b2" } },
      ],
      changed_by: "scenario-38c",
    })) as ReplanResult

    // ASSERT: replan succeeded
    expect(replanResult.ok).toBe(true)
    if (replanResult.ok) {
      expect(replanResult.nodes_removed).toBe(2)
      expect(replanResult.nodes_added).toBe(1)
    }

    // ASSERT: B and C removed
    expect(Effect.runSync(service.getNode(nodeIdB))).toBeFalsy()
    expect(Effect.runSync(service.getNode(nodeIdC))).toBeFalsy()

    // ASSERT: replacement node B2 exists (cfg ID "b2" → namespaced to workflowId::b2)
    const nodeB2 = Effect.runSync(service.getNode(nodeIdB2)) as DAGNodeSession
    expect(nodeB2).toBeTruthy()
    expect(["pending", "running"]).toContain(nodeB2.status)
    expect(nodeB2.dependencies).toEqual([nodeIdA])

    // Resume workflow
    Effect.runSync(engine.resumeWorkflow(workflowId))

    // ASSERT: workflow is running again
    const wfResumed = Effect.runSync(service.getWorkflow(workflowId)) as DAGWorkflowSession
    expect(wfResumed.status).toBe("running")

    // ASSERT: B2 is scheduled by forked scheduleReadyNodes after resume
    const b2Spawned = await pollFor(() => __internal_spawnedNodes().has(nodeIdB2), 50, 20)
    expect(b2Spawned).toBe(true)
  })
})
