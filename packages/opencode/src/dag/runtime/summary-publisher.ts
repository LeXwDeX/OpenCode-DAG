export * as DagSummaryPublisher from "./summary-publisher"

import { Effect, Layer, Stream, Context } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { DagStore } from "@opencode-ai/core/dag/store"
import { GlobalBus } from "@/bus/global"

/**
 * Stateless derived-view publisher for DAG workflow summaries.
 *
 * Subscribes to all `dag.*` events. On each event, reads the affected session's
 * workflow summaries from DagStore (the single source of truth) and emits a
 * `dag.workflow.summary.updated` event on GlobalBus carrying the full
 * `WorkflowSummary[]` payload for that session.
 *
 * Invariants (enforced by the "stateless derived view" contract):
 * - No module-level Map, Set, counter, or cached state.
 * - Every emission is a full recompute from DagStore.
 * - Emits ONLY through the ephemeral GlobalBus path — no EventV2 durable
 *   registration, no SQL writes.
 * - Removing this module has no effect on correctness; only realtime push is lost.
 */

// The events that can change a workflow's visible progress or topology.
// WorkflowCreated/Started/Replanned/ConfigUpdated/Paused/Resumed/Completed/Failed/Cancelled
// and every Node* event can all alter the aggregated summary.
const SUMMARY_TRIGGER_EVENTS = [
  DagEvent.WorkflowCreated,
  DagEvent.WorkflowStarted,
  DagEvent.WorkflowPaused,
  DagEvent.WorkflowResumed,
  DagEvent.WorkflowCompleted,
  DagEvent.WorkflowFailed,
  DagEvent.WorkflowCancelled,
  DagEvent.WorkflowReplanned,
  DagEvent.WorkflowConfigUpdated,
  DagEvent.NodeRegistered,
  DagEvent.NodeStarted,
  DagEvent.NodeCompleted,
  DagEvent.NodeFailed,
  DagEvent.NodeSkipped,
  DagEvent.NodeCancelled,
  DagEvent.NodeRestarted,
] as const

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/DagSummaryPublisher") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const store = yield* DagStore.Service

    const state = yield* InstanceState.make(
      Effect.fn("DagSummaryPublisher.state")(function* (ctx) {
        // Per-session debounce map. Keys are sessionIDs with an in-flight
        // recompute; a single fiber yield collapses a burst into one read.
        //
        // NOTE: This is request-coalescing state for I/O deduplication, NOT
        // a parallel projection of DAG state. The summary is always recomputed
        // fresh from DagStore on emission; this map only prevents redundant
        // reads when many events fire in a tight window. If the map were
        // removed entirely, correctness is unchanged — only more DagStore
        // reads would occur. This satisfies the "stateless derived view"
        // contract: no cached summary is ever served from this map.
        const pending = new Set<string>()

        const publishForSession = (sessionID: string) =>
          Effect.gen(function* () {
            const summaries = yield* store.getWorkflowSummaries(sessionID).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("DagSummaryPublisher: failed to read summaries", { sessionID, cause }).pipe(
                  Effect.as([]),
                ),
              ),
            )
            GlobalBus.emit("event", {
              directory: ctx.directory,
              project: ctx.project.id,
              payload: {
                type: "dag.workflow.summary.updated",
                properties: { sessionID, summaries },
              },
            })
          })

        const schedulePublish = (sessionID: string) =>
          Effect.gen(function* () {
            // Coalesce: if a recompute is already scheduled for this session,
            // let it absorb this trigger rather than queueing a second read.
            if (pending.has(sessionID)) return
            pending.add(sessionID)
            // Yield once so a burst of synchronous events collapse into one read.
            // Correctness does not depend on the window length, only freshness.
            yield* Effect.yieldNow
            pending.delete(sessionID)
            yield* publishForSession(sessionID)
          })

        for (const def of SUMMARY_TRIGGER_EVENTS) {
          yield* events.subscribe(def).pipe(
            Stream.mapEffect((evt) => {
              const dagID = evt.data.dagID as string
              const sessionID = (evt.data as { sessionID?: string }).sessionID
              if (sessionID) return schedulePublish(sessionID)
              // Node events don't carry sessionID — look it up via the workflow.
              return Effect.gen(function* () {
                const wf = yield* store.getWorkflow(dagID).pipe(Effect.catch(() => Effect.succeed(undefined)))
                if (wf) yield* schedulePublish(wf.sessionId)
              }).pipe(Effect.catchCause(() => Effect.logWarning("DagSummaryPublisher: lookup failed", { dagID })))
            }),
            Stream.runDrain,
            Effect.forkScoped,
          )
        }
        return {}
      }),
    )

    const init = Effect.fn("DagSummaryPublisher.init")(function* () {
      yield* InstanceState.get(state)
    })

    return Service.of({ init })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(DagStore.defaultLayer),
)

export const node = LayerNode.make(layer, [EventV2Bridge.node, DagStore.node])
