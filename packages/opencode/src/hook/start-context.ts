import { Context, Effect, Layer } from "effect"
import { SessionID } from "@/session/schema"
import { InstanceState } from "@/effect/instance-state"

export interface Interface {
  /** Append additionalContexts string to a session's pending start-context queue. */
  readonly append: (sessionID: SessionID, ctx: string) => Effect.Effect<void>
  /** Drain and return all pending start-contexts for a session. Idempotent — second call returns []. */
  readonly consume: (sessionID: SessionID) => Effect.Effect<readonly string[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/HookStartContext") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make(
      Effect.fn("HookStartContext.state")(() => Effect.succeed(new Map<SessionID, string[]>())),
    )

    const append = Effect.fn("HookStartContext.append")(function* (sessionID: SessionID, ctx: string) {
      const data = yield* InstanceState.get(state)
      const arr = data.get(sessionID) ?? []
      arr.push(ctx)
      data.set(sessionID, arr)
    })

    const consume = Effect.fn("HookStartContext.consume")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const arr = data.get(sessionID) ?? []
      data.delete(sessionID)
      return arr as readonly string[]
    })

    return Service.of({ append, consume })
  }),
)

export const defaultLayer = layer

export * as HookStartContext from "./start-context"
