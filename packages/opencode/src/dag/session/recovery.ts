// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

import { Effect } from "effect"
import type { IDAGSessionService } from "./session-service"
import type { UpdateNodeStatusInput } from "./session-service"
import type { DAGNodeSession, DAGWorkflowSession } from "./types"
import { WorkflowEngine, registerEngine, unregisterEngine, setWorkflowConcurrency } from "./workflow-engine"
import { createWorkflowExecutor } from "./workflow-executor"
import type { PromptOps } from "@/session/prompt-ops"

export type RecoverResult = { scanned: number; marked: number; resumed: number }

/**
 * Pure recovery function: scan all workflows, find orphaned ones (status='running'
 * but no engine in memory), and either resume them (when promptOps is provided,
 * WP-A2) or mark them failed with audit violations (legacy fallback).
 *
 * **Resume path** (WP-A2, when `promptOps` is provided):
 * - Rebuilds a WorkflowEngine instance via `WorkflowEngine.make`
 * - Injects the headless `promptOps` (from WP-A1 capture in layer.ts)
 * - Fills `concurrencyRegistry` from `workflow.config.max_concurrency`
 * - Calls `registerEngine` and `scheduleReadyNodes` (NOT `startWorkflow`,
 *   which would attempt an illegal running→running transition)
 * - Forks a `createWorkflowExecutor` daemon for ongoing polling
 * - Assembly entry guard: `WorkflowEngine.get(wfId) !== undefined` → skip (idempotent)
 * - On assembly failure: falls back to mark-failed with violation (no stuck state)
 *
 * **Legacy path** (when `promptOps` is NOT provided):
 * - Marks orphaned workflows as failed (running → failed)
 * - Creates `process_orphan` violations
 * - Cascade-skips downstream nodes (running → failed, queued/pending → skipped)
 *
 * Legal transitions for legacy path (per session-service.ts:48-86):
 * - workflow: running → failed
 * - node: running → failed (was actively executing)
 * - node: queued / pending → skipped (never started)
 */
export function recoverOrphanedWorkflows(
  service: IDAGSessionService,
  promptOps?: PromptOps,
): Effect.Effect<RecoverResult> {
  return Effect.gen(function* () {
    const workflows = yield* service.listAllWorkflows()
    const orphans = workflows.filter(w =>
      w.status === 'running' && WorkflowEngine.get(w.id) === undefined
    )

    let marked = 0
    let resumed = 0
    for (const wf of orphans) {
      // INFO 1: assembly entry guard — if engine already exists for this workflow,
      // skip the entire rebuild + daemon fork (idempotency). This guard lives here
      // (not inside registerEngine) per architecture constraint.
      if (WorkflowEngine.get(wf.id) !== undefined) continue

      if (promptOps) {
        // WP-A2 resume assembly attempt
        const resumeOk = yield* resumeOrphanWorkflow(service, wf, promptOps)
        if (resumeOk) {
          resumed++
          continue
        }
        // Resume assembly failed → fall through to legacy mark-failed
        yield* failOrphanWorkflow(service, wf, 'recovery assembly failed')
        marked++
      } else {
        // Legacy fallback: no promptOps available
        yield* failOrphanWorkflow(service, wf, 'workflow orphaned by process restart (was running at previous shutdown)')
        marked++
      }
    }

    return { scanned: workflows.length, marked, resumed }
  })
}

/**
 * Returns the legal target status for an orphaned node, or null if already terminal.
 * See session-service.ts:48-86 for state transition tables.
 */
function recoverNodeTargetStatus(
  current: DAGNodeSession['status'],
): 'failed' | 'skipped' | null {
  switch (current) {
    case 'running': return 'failed'
    case 'queued': return 'skipped'
    case 'pending': return 'skipped'
    case 'completed':
    case 'failed':
    case 'skipped':
      return null
  }
}

/**
 * Legacy failure path: mark workflow failed + process_orphan violation + cascade-skip nodes.
 * Extracted from the inline body of the original recoverOrphanedWorkflows loop.
 */
function failOrphanWorkflow(
  service: IDAGSessionService,
  wf: DAGWorkflowSession,
  violationMessage: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* service.updateWorkflowStatus(wf.id, 'failed').pipe(
      Effect.tapError(err => Effect.logWarning(`[DAG recovery] failed to mark workflow ${wf.id}: ${err}`)),
      Effect.ignore,
    )

    yield* service.createViolation({
      workflowId: wf.id,
      type: 'process_orphan',
      severity: 'critical',
      message: violationMessage,
    }).pipe(
      Effect.tapError(err => Effect.logWarning(`[DAG recovery] violation creation failed for ${wf.id}: ${err}`)),
      Effect.ignore,
    )

    const nodes = yield* service.listNodes(wf.id)
    for (const node of nodes) {
      const targetStatus = recoverNodeTargetStatus(node.status)
      if (!targetStatus) continue
      yield* service.updateNodeStatus({
        sessionId: node.node_id,
        status: targetStatus,
        error: targetStatus === 'failed' ? 'orphaned by process restart' : undefined,
      } satisfies UpdateNodeStatusInput).pipe(
        Effect.tapError(err => Effect.logWarning(`[DAG recovery] failed to transition ${node.node_id} → ${targetStatus}: ${err}`)),
        Effect.ignore,
      )
    }
  })
}

/**
 * WP-A2 resume assembly: rebuild WorkflowEngine, inject promptOps, fill
 * concurrencyRegistry, registerEngine, scheduleReadyNodes, fork daemon.
 *
 * Returns `true` on success; `false` on any assembly step failure.
 * On failure, caller falls through to `failOrphanWorkflow` — this function
 * does NOT modify workflow status itself (no stuck intermediate state).
 *
 * **Does NOT call startWorkflow** (which would attempt running→running).
 * Instead: sets concurrencyRegistry directly + scheduleReadyNodes + forkDetach daemon.
 */
function resumeOrphanWorkflow(
  service: IDAGSessionService,
  wf: DAGWorkflowSession,
  promptOps: PromptOps,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    // 1. Build engine (yields DAGSessionService.make internally — satisfied by DB layer)
    const engine = yield* WorkflowEngine.make

    // 2. Inject headless promptOps (WP-A1 reference, passed from layer.ts)
    //    setPromptOps is a non-interface method exposed on the engine instance.
    ;(engine as WorkflowEngine & { setPromptOps: (ops: PromptOps) => void }).setPromptOps(promptOps)

    // 3. Fill concurrencyRegistry from workflow config (bypasses startWorkflow)
    setWorkflowConcurrency(wf.id, wf.config.max_concurrency)

    // 4. Register engine in module-level registry
    registerEngine(wf.id, engine)

    // 4.5. WP-A3: Reset running nodes to pending (recovery reset).
    //      Must happen BEFORE scheduleReadyNodes (step 5) so the scheduler
    //      picks them up for re-spawn. Legal transition per session-service.ts:81-82.
    yield* resetRunningNodes(service, wf)

    // 5. Schedule pending/ready nodes (NOT startWorkflow — avoids running→running transition)
    yield* engine.scheduleReadyNodes(wf.id)

    // 6. Fork detached daemon for ongoing polling (ensuring cleanup on exit)
    const executor = createWorkflowExecutor(engine, wf.config)
    yield* executor.start(wf.id).pipe(Effect.forkDetach)

    return true
  }).pipe(
    // On any assembly failure: cleanup registered engine to prevent leaks
    Effect.tapError(() =>
      Effect.sync(() => unregisterEngine(wf.id)),
    ),
    // Collapse Effect.fail into a boolean result for the caller
    Effect.catchCause(() => Effect.succeed(false)),
  )
}

/**
 * WP-A3: Reset all running nodes in an orphaned workflow to pending.
 * Called between registerEngine (step 4) and scheduleReadyNodes (step 5)
 * so the scheduler picks them up for re-spawn.
 *
 * Per INFO 5: appends a recovery_reset log entry per reset node.
 * Original running logs are preserved (audit integrity).
 */
function resetRunningNodes(
  service: IDAGSessionService,
  wf: DAGWorkflowSession,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const nodes = yield* service.listNodes(wf.id)
    for (const node of nodes) {
      if (node.status !== 'running') continue

      yield* service.updateNodeStatus({
        sessionId: node.node_id,
        status: 'pending',
      } satisfies UpdateNodeStatusInput).pipe(
        Effect.tapError(err => Effect.logWarning(`[DAG recovery] failed to reset ${node.node_id} running→pending: ${err}`)),
        Effect.ignore,
      )

      yield* service.appendNodeLog({
        nodeId: node.node_id,
        workflowId: wf.id,
        chatSessionId: wf.chat_session_id,
        logLevel: 'info',
        logMessage: `Recovery reset: running node reset to pending for re-spawn (WP-A3)`,
        executionPhase: 'recovery_reset',
      }).pipe(
        Effect.tapError(err => Effect.logWarning(`[DAG recovery] failed to append recovery_reset log for ${node.node_id}: ${err}`)),
        Effect.ignore,
      )
    }
  })
}
