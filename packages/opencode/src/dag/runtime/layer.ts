export * as DagRuntime from "./layer"

import { Effect, Layer } from "effect"
import { Semaphore } from "effect"
import { Dag } from "../dag"
import { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { startScheduling } from "./scheduling"
import { WorktreeManager } from "./worktree-manager"
import type { TaskPromptOps } from "@/tool/task"
import type { SessionPrompt } from "@/session/prompt"

/**
 * DAG runtime layer — InstanceState-based lazy construction (D9).
 *
 * Mirrors `background/job.ts`: the DAG runtime is built lazily per-directory,
 * NOT eagerly in AppLayer. Agent.Service / Session.Service are resolved via
 * Effect.serviceOption at call time, not hard yield* in the layer body.
 *
 * This layer provides the Dag.Service tag (opencode lineage) so consumers
 * (the `workflow` tool, HTTP routes, TUI) can resolve it. The actual execution
 * runtime (spawn + scheduling) is invoked when a workflow is started, not at
 * layer construction time.
 */

/** Per-directory runtime state — the worktree manager + active workflow schedulers. */
export interface RuntimeState {
  readonly worktreeManager: WorktreeManager
  /** Active workflow schedulers keyed by dagID (for cleanup on shutdown). */
  readonly schedulers: Map<string, ReturnType<typeof Effect.forkDetach>>
}

export const RuntimeState = Effect.gen(function* () {
  return {
    worktreeManager: new WorktreeManager(),
    schedulers: new Map<string, ReturnType<typeof Effect.forkDetach>>(),
  } satisfies RuntimeState
})

/**
 * The Dag runtime layer wraps the Dag.Service (opencode lineage) and adds
 * lazy runtime state. No AppLayer wiring — consumers resolve Dag.Service
 * via Effect.serviceOption at call time.
 *
 * Usage in a tool/handler:
 * ```ts
 * const dag = yield* Dag.Service  // resolved from context
 * const dagID = yield* dag.create({ ... })
 * // scheduling starts automatically inside create() or via a follow-up call
 * ```
 */
export const layer = Dag.defaultLayer

/**
 * Start the scheduling loop for a workflow. Called after Dag.Service.create()
 * to kick off node spawning. Fork-detached — runs until workflow reaches terminal.
 *
 * The caller provides promptOps (injected by the session runner, same as task.ts).
 */
export function startWorkflowScheduling(
  dagID: string,
  maxConcurrency: number,
  parentSessionID: string,
  parentModelID: string,
  parentProviderID: string,
  projectDir: string,
  promptOps: TaskPromptOps,
): Effect.Effect<void, Error, Dag.Service | EventV2.Service | import("@/agent/agent").Agent.Service | import("@/session/session").Session.Service> {
  return Effect.gen(function* () {
    const dag = yield* Dag.Service
    yield* startScheduling(dagID, maxConcurrency, {
      dag,
      store: dag.store,
      promptOps,
      parentSessionID,
      parentModelID,
      parentProviderID,
      projectDir,
    })
  })
}
