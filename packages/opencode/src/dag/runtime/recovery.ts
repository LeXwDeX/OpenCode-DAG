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
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import type { DagStore } from "@opencode-ai/core/dag/store"

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
      if (node.status !== "running" && node.status !== "pending") continue
      if (!node.childSessionId) {
        yield* dag.nodeFailed(dagID, node.id, node.status === "pending" ? "node was pending but never started" : "node was running but had no child session on recovery", "exec_failed")
        reconciled++
        continue
      }

      const sessionStatus = yield* checkSessionStatus(node.childSessionId).pipe(
        Effect.catch(() => Effect.succeed("unknown" as const)),
      )

      if (sessionStatus === "completed") {
        if (node.status === "pending") yield* dag.nodeStarted(dagID, node.id, node.childSessionId)
        yield* dag.nodeCompleted(dagID, node.id, undefined)
        reconciled++
      } else if (sessionStatus === "failed") {
        if (node.status === "pending") yield* dag.nodeStarted(dagID, node.id, node.childSessionId)
        yield* dag.nodeFailed(dagID, node.id, "child session failed (recovered)", "exec_failed")
        reconciled++
      } else {
        if (node.status === "pending") yield* dag.nodeStarted(dagID, node.id, node.childSessionId)
        leftRunning++
      }
    }

    return { reconciled, leftRunning }
  })
}

export function makeSessionStatusChecker(
  sessions: Session.Interface,
): (childSessionID: string) => Effect.Effect<"active" | "completed" | "failed" | "unknown", Error> {
  return (childSessionID) =>
    Effect.gen(function* () {
      const info = yield* sessions.get(SessionID.make(childSessionID)).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (!info) return "unknown" as const
      const msgs = yield* sessions.messages({ sessionID: SessionID.make(childSessionID), limit: 1 }).pipe(
        Effect.catch(() => Effect.succeed([] as never)),
      )
      if (msgs.length === 0) return "active" as const
      const last = msgs[msgs.length - 1]
      if (last.info.role === "assistant" && last.info.finish === "stop") return "completed" as const
      if (last.info.role === "assistant" && last.info.finish === "error") return "failed" as const
      return "active" as const
    })
}
