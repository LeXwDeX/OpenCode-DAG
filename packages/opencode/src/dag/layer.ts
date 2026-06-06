import { Context, Effect, Layer } from "effect"
import { DAGQuery } from "./query/dag-query"
import { DAGSessionService, setEventBus } from "./session/session-service"
import { EventBus } from "./state-machine/EventBus"

// ── Service Tags ──

export class DAGQueryTag extends Context.Service<DAGQueryTag, DAGQuery>()("@opencode/DAGQuery") {}

export class SharedEventBusTag extends Context.Service<SharedEventBusTag, EventBus>()("@opencode/SharedDAGEventBus") {}

// ── Layer: idempotent via Effect Layer memo map ──

export const defaultLayer = Layer.mergeAll(
  // Provide shared EventBus singleton so bridge-layer can subscribe to the same instance
  Layer.effect(
    SharedEventBusTag,
    Effect.sync(() => {
      const bus = new EventBus()
      // Mount to session-service module-level variable (Iron Law #3)
      setEventBus(bus)
      return bus
    }),
  ),
  // Provide DAGQuery backed by DAGSessionService
  Layer.effect(
    DAGQueryTag,
    Effect.gen(function* () {
      const bus = yield* SharedEventBusTag
      // Ensure event bus is mounted (idempotent: same bus if layer re-runs via memo)
      setEventBus(bus)
      const sessionService = yield* DAGSessionService.make
      return new DAGQuery(sessionService)
    }),
  ),
)
