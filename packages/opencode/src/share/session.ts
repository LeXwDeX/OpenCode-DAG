import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SyncEvent } from "@/sync"
import { Effect, Layer, Scope, Context } from "effect"
import { Config } from "@/config/config"
import { SettingsHook } from "@/hook/settings"
import { HookStartContext } from "@/hook/start-context"
import { Flag } from "@opencode-ai/core/flag/flag"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as ShareNext from "./share-next"

export interface Interface {
  readonly create: (input?: Session.CreateInput) => Effect.Effect<Session.Info>
  readonly share: (sessionID: SessionID) => Effect.Effect<{ url: string }, unknown>
  readonly unshare: (sessionID: SessionID) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionShare") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const session = yield* Session.Service
    const shareNext = yield* ShareNext.Service
    const settingsHook = yield* SettingsHook.Service
    const startCtx = yield* HookStartContext.Service
    const scope = yield* Scope.Scope
    const sync = yield* SyncEvent.Service
    const flags = yield* RuntimeFlags.Service

    const share = Effect.fn("SessionShare.share")(function* (sessionID: SessionID) {
      const conf = yield* cfg.get()
      if (conf.share === "disabled") throw new Error("Sharing is disabled in configuration")
      const result = yield* shareNext.create(sessionID)
      yield* sync.run(Session.Event.Updated, { sessionID, info: { share: { url: result.url } } })
      return result
    })

    const unshare = Effect.fn("SessionShare.unshare")(function* (sessionID: SessionID) {
      yield* shareNext.remove(sessionID)
      yield* sync.run(Session.Event.Updated, { sessionID, info: { share: { url: null } } })
    })

    const create = Effect.fn("SessionShare.create")(function* (input?: Session.CreateInput) {
      const result = yield* session.create(input)
      // SessionStart hook (Claude Code compatible) — fires for top-level
      // sessions only. Sub-agent sessions (parentID set) are excluded; CC has
      // no SubagentStart event. Failures never abort session creation.
      if (!result.parentID) {
        const exit = yield* settingsHook
          .trigger(
            { event: "SessionStart", source: "startup" },
            { sessionID: result.id, transcriptPath: "" },
          )
          .pipe(Effect.exit)
        if (exit._tag === "Success") {
          for (const ctx of exit.value.additionalContexts) {
            yield* startCtx.append(result.id, ctx)
          }
        }
        // Failures are silently swallowed (matches prior Effect.ignore semantics)
      }
      if (result.parentID) return result
      const conf = yield* cfg.get()
      if (!(flags.autoShare || conf.share === "auto")) return result
      yield* share(result.id).pipe(Effect.ignore, Effect.forkIn(scope))
      return result
    })

    return Service.of({ create, share, unshare })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(ShareNext.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(SettingsHook.defaultLayer),
  Layer.provide(HookStartContext.defaultLayer),
  Layer.provide(SyncEvent.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export * as SessionShare from "./session"
