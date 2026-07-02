/**
 * DAG crash recovery — EventV2-driven, no separate recovery table/scan.
 *
 * With D3 (node = real child Session), crash recovery reduces to "what does the
 * child session's actual state say?" — which dev already tracks durably via
 * EventV2. On startup, any node left `running` by an unclean shutdown is
 * reconciled by querying its backing child session's state.
 *
 * This is NOT a startup-blocking scan (unlike the old recoverOrphanedWorkflows).
 * It runs lazily when a workflow is first accessed, and only touches workflows
 * that have running nodes.
 */

import { Effect } from "effect"
import { Dag } from "../dag"
import type { DagStore } from "@opencode-ai/core/dag/store"

/**
 * Reconcile a workflow's running nodes against their backing child sessions.
 *
 * For each node in `running` state:
 * - If the child session is complete → mark node completed
 * - If the child session failed → mark node failed
 * - If the child session is still alive → leave as running
 *
 * This is a no-op for workflows with no running nodes.
 */
export function reconcileWorkflow(
  dagID: string,
  checkSessionStatus: (childSessionID: string) => Effect.Effect<"active" | "completed" | "failed" | "unknown", Error>,
): Effect.Effect<{ reconciled: number; leftRunning: number }, Error, Dag.Service> {
  return Effect.gen(function* () {
    const dag = yield* Dag.Service
    const nodes = yield* dag.store.getNodes(dagID)
    let reconciled = 0
    let leftRunning = 0

    for (const node of nodes) {
      if (node.status !== "running") continue
      if (!node.childSessionId) {
        // No child session recorded — the node was running but never spawned
        yield* dag.nodeFailed(dagID, node.id, "node was running but had no child session on recovery", "exec_failed")
        reconciled++
        continue
      }

      const sessionStatus = yield* checkSessionStatus(node.childSessionId).pipe(
        Effect.catch(() => Effect.succeed("unknown" as const)),
      )

      if (sessionStatus === "completed") {
        yield* dag.nodeCompleted(dagID, node.id, undefined)
        reconciled++
      } else if (sessionStatus === "failed") {
        yield* dag.nodeFailed(dagID, node.id, "child session failed (recovered)", "exec_failed")
        reconciled++
      } else {
        // active or unknown — leave as running, the scheduling loop will pick it up
        leftRunning++
      }
    }

    return { reconciled, leftRunning }
  })
}
