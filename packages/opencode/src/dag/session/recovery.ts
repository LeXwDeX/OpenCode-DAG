// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

import { Effect } from "effect"
import type { IDAGSessionService } from "./session-service"
import type { UpdateNodeStatusInput } from "./session-service"
import type { DAGNodeSession } from "./types"
import { WorkflowEngine } from "./workflow-engine"

export type RecoverResult = { scanned: number; marked: number }

/**
 * Pure recovery function: scan all workflows, find orphaned ones (status='running'
 * but no engine in memory), mark them failed with audit violations, and cascade-skip
 * downstream nodes using legal state transitions.
 *
 * Legal transitions (per session-service.ts:48-86):
 * - workflow: running → failed
 * - node: running → failed (was actively executing)
 * - node: queued / pending → skipped (never started)
 */
export function recoverOrphanedWorkflows(
  service: IDAGSessionService,
): Effect.Effect<RecoverResult> {
  return Effect.gen(function* () {
    const workflows = yield* service.listAllWorkflows()
    const orphans = workflows.filter(w =>
      w.status === 'running' && WorkflowEngine.get(w.id) === undefined
    )

    let marked = 0
    for (const wf of orphans) {
      yield* service.updateWorkflowStatus(wf.id, 'failed').pipe(
        Effect.tapError(err => Effect.logWarning(`[DAG recovery] failed to mark workflow ${wf.id}: ${err}`)),
        Effect.ignore,
      )

      yield* service.createViolation({
        workflowId: wf.id,
        type: 'process_orphan',
        severity: 'critical',
        message: `workflow orphaned by process restart (was running at previous shutdown)`,
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
      marked++
    }

    return { scanned: workflows.length, marked }
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
