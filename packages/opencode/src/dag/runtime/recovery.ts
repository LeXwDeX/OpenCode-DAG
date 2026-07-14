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
  cancelSession?: (sessionID: string) => Effect.Effect<void>,
): Effect.Effect<{ reconciled: number; leftRunning: number }, Error, Dag.Service> {
  return Effect.gen(function* () {
    const dag = yield* Dag.Service
    const nodes = yield* dag.store.getNodes(dagID)
    let reconciled = 0
    let leftRunning = 0

    for (const node of nodes) {
      // Pending nodes have not been admitted to an execution attempt yet. This
      // includes ordinary dependency-blocked work and restart-orphans; both are
      // left for spawnReady to schedule after runtime reconstruction.
      // A restart-orphan (pending + stale childSessionId) must have its old
      // child session cancelled here, since spawnReady may never revisit it if
      // the workflow is about to become terminal.
      if (node.status === "pending") {
        if (node.childSessionId && cancelSession) {
          yield* cancelSession(node.childSessionId).pipe(Effect.catch(() => Effect.void))
        }
        continue
      }
      if (node.status !== "running") continue
      if (!node.childSessionId) {
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
        // active or unknown: leave running — the recovery watcher will poll
        // until a definitive status arrives. A session with 0 messages may
        // legitimately still be starting (semaphore queue, provider latency).
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
      if (msgs.length === 0) return "unknown" as const
      const last = msgs[msgs.length - 1]
      if (last.info.role !== "assistant") return "active" as const
      // An interrupted/aborted session has error set but finish undefined.
      if (last.info.error) return "failed" as const
      const finish = last.info.finish
      if (!finish || finish === "tool-calls" || finish === "unknown") return "active" as const
      if (finish === "error" || finish === "content-filter") return "failed" as const
      // stop, length, and any other terminal finish → completed
      return "completed" as const
    })
}
