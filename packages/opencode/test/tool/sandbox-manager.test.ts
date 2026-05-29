import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { existsSync, readFileSync } from "node:fs"
import path from "path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { SandboxManager } from "../../src/tool/sandbox/manager"
import { testEffect } from "../lib/effect"

const sandboxLayer = SandboxManager.defaultLayer.pipe(Layer.provideMerge(AppFileSystem.defaultLayer))
const it = testEffect(sandboxLayer)

describe("sandbox.manager", () => {
  it.instance("creates a sandbox with a generated id and workspace under the root", () =>
    Effect.gen(function* () {
      const manager = yield* SandboxManager.Service
      const root = yield* manager.root()
      const sb = yield* manager.ensure({ language: "python" })

      expect(sb.id.startsWith("sandbox")).toBe(true)
      expect(sb.language).toBe("python")
      expect(sb.initialized).toBe(false)
      expect(sb.workspace).toBe(path.join(root, sb.id))
      expect(existsSync(sb.workspace)).toBe(true)
    }),
  )

  it.instance("self-isolates the sandbox root with a wildcard .gitignore", () =>
    Effect.gen(function* () {
      const manager = yield* SandboxManager.Service
      const root = yield* manager.root()
      yield* manager.ensure({ language: "node" })

      const ignore = path.join(root, ".gitignore")
      expect(existsSync(ignore)).toBe(true)
      expect(readFileSync(ignore, "utf8")).toBe("*\n")
    }),
  )

  it.instance("reuses an existing sandbox when the same id is passed", () =>
    Effect.gen(function* () {
      const manager = yield* SandboxManager.Service
      const first = yield* manager.ensure({ language: "python" })
      const again = yield* manager.ensure({ id: first.id, language: "python" })

      expect(again.id).toBe(first.id)
      expect(again.workspace).toBe(first.workspace)
      expect((yield* manager.list()).length).toBe(1)
    }),
  )

  it.instance("creates a sandbox under an explicit unknown id", () =>
    Effect.gen(function* () {
      const manager = yield* SandboxManager.Service
      const sb = yield* manager.ensure({ id: "sb-custom", language: "go" })

      expect(sb.id).toBe("sb-custom")
      expect((yield* manager.get("sb-custom"))?.id).toBe("sb-custom")
    }),
  )

  it.instance("markInitialized flips the initialized flag", () =>
    Effect.gen(function* () {
      const manager = yield* SandboxManager.Service
      const sb = yield* manager.ensure({ language: "python" })
      expect((yield* manager.get(sb.id))?.initialized).toBe(false)

      yield* manager.markInitialized(sb.id)
      expect((yield* manager.get(sb.id))?.initialized).toBe(true)
    }),
  )

  it.instance("touch advances last_used_at", () =>
    Effect.gen(function* () {
      const manager = yield* SandboxManager.Service
      const sb = yield* manager.ensure({ language: "python" })
      yield* Effect.sleep("5 millis")
      yield* manager.touch(sb.id)

      const after = yield* manager.get(sb.id)
      expect(after!.last_used_at).toBeGreaterThanOrEqual(sb.last_used_at)
    }),
  )

  it.instance("destroy removes the entry and deletes the workspace directory", () =>
    Effect.gen(function* () {
      const manager = yield* SandboxManager.Service
      const sb = yield* manager.ensure({ language: "python" })
      expect(existsSync(sb.workspace)).toBe(true)

      const removed = yield* manager.destroy(sb.id)
      expect(removed?.id).toBe(sb.id)
      expect(yield* manager.get(sb.id)).toBeUndefined()
      expect(existsSync(sb.workspace)).toBe(false)
    }),
  )

  it.instance("destroy of an unknown id is a no-op", () =>
    Effect.gen(function* () {
      const manager = yield* SandboxManager.Service
      expect(yield* manager.destroy("does-not-exist")).toBeUndefined()
    }),
  )

  it.instance("evicts the oldest sandbox once the cap is exceeded", () =>
    Effect.gen(function* () {
      const manager = yield* SandboxManager.Service
      // MAX_SANDBOXES is 256; create one more to force a single LRU eviction.
      const total = 257
      let firstWorkspace = ""
      for (let i = 0; i < total; i++) {
        const sb = yield* manager.ensure({ id: `sb-${i}`, language: "python" })
        if (i === 0) firstWorkspace = sb.workspace
      }

      const list = yield* manager.list()
      expect(list.length).toBe(256)
      // The first (oldest) sandbox should have been reclaimed.
      expect(yield* manager.get("sb-0")).toBeUndefined()
      expect(existsSync(firstWorkspace)).toBe(false)
      expect((yield* manager.get("sb-256"))?.id).toBe("sb-256")
    }),
  )
})
