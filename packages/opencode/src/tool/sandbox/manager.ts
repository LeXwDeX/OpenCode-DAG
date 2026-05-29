import { InstanceState } from "@/effect/instance-state"
import { Identifier } from "@/id/id"
import type { InstanceContext } from "@/project/instance-context"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Clock, Context, Effect, Layer, Scope, SynchronizedRef } from "effect"
import { rm } from "node:fs/promises"
import path from "path"

// Upper bound on live sandbox workspaces per project. When the model fans out
// many workers the oldest idle workspaces are reclaimed first (LRU) so disk and
// file handles stay bounded even under ~100 concurrent creates.
const MAX_SANDBOXES = 256

export type Info = {
  id: string
  workspace: string
  language: string
  created_at: number
  last_used_at: number
  initialized: boolean
}

type State = {
  root: string
  sandboxes: SynchronizedRef.SynchronizedRef<Map<string, Info>>
  scope: Scope.Scope
}

export interface Interface {
  /** Absolute path of the directory that holds all sandbox workspaces. */
  readonly root: () => Effect.Effect<string>
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  /** Create a new sandbox, or return the existing one when `id` is provided. */
  readonly ensure: (input: { id?: string; language: string }) => Effect.Effect<Info>
  readonly markInitialized: (id: string) => Effect.Effect<void>
  readonly touch: (id: string) => Effect.Effect<void>
  readonly destroy: (id: string) => Effect.Effect<Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Sandbox") {}

function snapshot(info: Info): Info {
  return { ...info }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Sandbox.state")(function* (ctx: InstanceContext) {
        return {
          root: path.join(ctx.directory, ".opencode", "sandboxes"),
          sandboxes: yield* SynchronizedRef.make(new Map<string, Info>()),
          scope: yield* Scope.Scope,
        }
      }),
    )

    const root: Interface["root"] = Effect.fn("Sandbox.root")(function* () {
      return (yield* InstanceState.get(state)).root
    })

    const list: Interface["list"] = Effect.fn("Sandbox.list")(function* () {
      return Array.from((yield* SynchronizedRef.get((yield* InstanceState.get(state)).sandboxes)).values())
        .map(snapshot)
        .toSorted((a, b) => a.created_at - b.created_at)
    })

    const get: Interface["get"] = Effect.fn("Sandbox.get")(function* (id) {
      const info = (yield* SynchronizedRef.get((yield* InstanceState.get(state)).sandboxes)).get(id)
      if (!info) return
      return snapshot(info)
    })

    // Physically delete a workspace directory. Best-effort: a failed rm must not
    // crash the tool call, the directory lives under the project's gitignored
    // scratch area and will be reclaimed when the instance closes.
    const removeWorkspace = Effect.fn("Sandbox.removeWorkspace")(function* (workspace: string) {
      yield* Effect.promise(() => rm(workspace, { recursive: true, force: true })).pipe(Effect.ignore)
    })

    const destroy: Interface["destroy"] = Effect.fn("Sandbox.destroy")(function* (id) {
      const s = yield* InstanceState.get(state)
      const removed = yield* SynchronizedRef.modify(s.sandboxes, (map): readonly [Info | undefined, Map<string, Info>] => {
        const info = map.get(id)
        if (!info) return [undefined, map]
        const next = new Map(map)
        next.delete(id)
        return [info, next]
      })
      if (removed) yield* removeWorkspace(removed.workspace)
      return removed ? snapshot(removed) : undefined
    })

    // Evict least-recently-used sandboxes until the map is back under the cap.
    // Runs inside the same atomic modify that inserts a new entry so the cap is
    // never exceeded even under concurrent creates.
    function evict(map: Map<string, Info>): { map: Map<string, Info>; evicted: Info[] } {
      if (map.size <= MAX_SANDBOXES) return { map, evicted: [] }
      const ordered = Array.from(map.values()).toSorted((a, b) => a.last_used_at - b.last_used_at)
      const drop = ordered.slice(0, map.size - MAX_SANDBOXES)
      const next = new Map(map)
      for (const item of drop) next.delete(item.id)
      return { map: next, evicted: drop }
    }

    const ensure: Interface["ensure"] = Effect.fn("Sandbox.ensure")(function* (input) {
      const s = yield* InstanceState.get(state)
      const now = yield* Clock.currentTimeMillis

      if (input.id) {
        const existing = yield* SynchronizedRef.modify(
          s.sandboxes,
          (map): readonly [Info | undefined, Map<string, Info>] => {
            const info = map.get(input.id!)
            if (!info) return [undefined, map]
            const next = new Map(map).set(info.id, { ...info, last_used_at: now })
            return [{ ...info, last_used_at: now }, next]
          },
        )
        if (existing) return snapshot(existing)
        // Unknown id: fall through and create a sandbox under that exact id so the
        // model can pick its own stable handle and reuse it across calls.
      }

      const id = input.id ?? Identifier.create("sandbox", "ascending")
      const workspace = path.join(s.root, id)
      const resolved = path.resolve(workspace)
      if (resolved !== s.root && !resolved.startsWith(s.root + path.sep)) {
        return yield* Effect.die(new Error(`sandbox_id escapes workspace root: ${input.id}`))
      }
      // Make the sandbox root self-ignoring so scratch workspaces never get
      // committed, regardless of the host project's .gitignore.
      yield* fs.ensureDir(s.root).pipe(Effect.orDie)
      const ignore = path.join(s.root, ".gitignore")
      if (!(yield* fs.existsSafe(ignore))) yield* fs.writeWithDirs(ignore, "*\n").pipe(Effect.ignore)
      yield* fs.ensureDir(workspace).pipe(Effect.orDie)

      const info: Info = {
        id,
        workspace,
        language: input.language,
        created_at: now,
        last_used_at: now,
        initialized: false,
      }

      const evicted = yield* SynchronizedRef.modify(s.sandboxes, (map): readonly [Info[], Map<string, Info>] => {
        const inserted = new Map(map).set(id, info)
        const result = evict(inserted)
        return [result.evicted, result.map]
      })
      yield* Effect.forEach(evicted, (item) => removeWorkspace(item.workspace), { concurrency: "unbounded" })

      return snapshot(info)
    })

    const markInitialized: Interface["markInitialized"] = Effect.fn("Sandbox.markInitialized")(function* (id) {
      const s = yield* InstanceState.get(state)
      yield* SynchronizedRef.update(s.sandboxes, (map) => {
        const info = map.get(id)
        if (!info) return map
        return new Map(map).set(id, { ...info, initialized: true })
      })
    })

    const touch: Interface["touch"] = Effect.fn("Sandbox.touch")(function* (id) {
      const s = yield* InstanceState.get(state)
      const now = yield* Clock.currentTimeMillis
      yield* SynchronizedRef.update(s.sandboxes, (map) => {
        const info = map.get(id)
        if (!info) return map
        return new Map(map).set(id, { ...info, last_used_at: now })
      })
    })

    return Service.of({ root, list, get, ensure, markInitialized, touch, destroy })
  }),
)

export const defaultLayer = layer

export * as SandboxManager from "./manager"
