/**
 * Session-scoped hook store (WP-5D).
 *
 * Holds hook entries that were dynamically attached to a single session
 * (e.g. injected by a Claude Code skill / agent frontmatter at runtime).
 * These hooks live alongside the 6-layer settings file chain — `SettingsHook.trigger`
 * concatenates session entries into the matcher list so they participate in
 * the same matcher / aggregation pipeline as on-disk hooks.
 *
 * Lifecycle:
 *   - `add(sessionID, entry)` — append; returns a uuid for later precise removal
 *   - `list(sessionID, event)` — query active entries for one event
 *   - `remove(sessionID, id)` — drop a single entry (used by `once: true` cleanup)
 *   - `clear(sessionID)` — drop the whole session bucket (call on session end)
 *
 * Uses `InstanceState` for per-directory isolation (mirrors `start-context.ts`).
 */
import { Context, Effect, Layer } from "effect"
import { SessionID } from "@/session/schema"
import { InstanceState } from "@/effect/instance-state"
import type { HookEvent, HookJSONOutput } from "./settings"

// Shape of the inner hooks array on a session entry. Mirrors the `hooks[]`
// array nested under each HookMatcher in the settings file format. We re-declare
// here rather than import HookCommand to avoid a settings.ts → session-hooks.ts
// import cycle (settings.ts already depends on session-hooks for the trigger merge).
export interface SessionHookCommand {
  type: "command" | "mcp" | "http" | "prompt" | "agent"
  command: string
  timeout?: number
  shell?: "bash" | "powershell"
  if?: string
  async?: boolean
  asyncRewake?: boolean
  options?: Record<string, unknown>
  __sourceDir?: string
}

export interface SessionHookEntryInput {
  event: HookEvent
  /** CC matcher pattern (exact / pipe-list / regex / "*"). Undefined = match all. */
  matcher?: string
  hooks: SessionHookCommand[]
  /** When true, the entry is removed automatically after its first execution. */
  once?: boolean
}

export interface SessionHookEntry extends SessionHookEntryInput {
  /** Auto-generated uuid. Stable for the entry's lifetime; used by remove(). */
  id: string
}

export interface Interface {
  readonly add: (sessionID: SessionID, entry: SessionHookEntryInput) => Effect.Effect<string>
  readonly remove: (sessionID: SessionID, id: string) => Effect.Effect<void>
  readonly list: (sessionID: SessionID, event: HookEvent) => Effect.Effect<readonly SessionHookEntry[]>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionHooks") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make(
      Effect.fn("SessionHooks.state")(() => Effect.succeed(new Map<SessionID, SessionHookEntry[]>())),
    )

    const add = Effect.fn("SessionHooks.add")(function* (sessionID: SessionID, entry: SessionHookEntryInput) {
      const data = yield* InstanceState.get(state)
      const list = data.get(sessionID) ?? []
      const id = crypto.randomUUID()
      list.push({ id, ...entry })
      data.set(sessionID, list)
      return id
    })

    const remove = Effect.fn("SessionHooks.remove")(function* (sessionID: SessionID, id: string) {
      const data = yield* InstanceState.get(state)
      const list = data.get(sessionID)
      if (!list) return
      const next = list.filter((e) => e.id !== id)
      if (next.length === 0) data.delete(sessionID)
      else data.set(sessionID, next)
    })

    const list = Effect.fn("SessionHooks.list")(function* (sessionID: SessionID, event: HookEvent) {
      const data = yield* InstanceState.get(state)
      const arr = data.get(sessionID) ?? []
      return arr.filter((e) => e.event === event) as readonly SessionHookEntry[]
    })

    const clear = Effect.fn("SessionHooks.clear")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      data.delete(sessionID)
    })

    return Service.of({ add, remove, list, clear })
  }),
)

export const defaultLayer = layer

// Re-export HookJSONOutput so consumers building entries don't need a second import.
export type { HookJSONOutput }

export * as SessionHooks from "./session-hooks"
