import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { SettingsHook } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { watchSettings } from "@/hook/extensions"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

// Real SettingsHook layer with its deps, mirroring the dedup test. SessionHooks
// is exposed via Layer.provideMerge. Each it.instance test runs in a fresh temp
// instance dir, so InstanceState-built state (loadChain + the seen Map) and the
// watchSettings watcher are fresh per test.
const testLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)

const it = testEffect(testLayer)

const CONTEXT_V1 = "ctx-hot-reload-v1"
const CONTEXT_V2 = "ctx-hot-reload-v2"

// A SessionStart command hook whose stdout JSON carries a fixed additionalContext
// marker. `printf '%s' '<json>'` single-quotes the JSON so its inner double
// quotes reach the shell literally; parseStdout then JSON.parses the output.
const hookJson = (ctx: string) =>
  JSON.stringify({ hookSpecificOutput: { additionalContext: ctx } })

const settingsFor = (ctx: string) => ({
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: `printf '%s' '${hookJson(ctx)}'` }] }],
  },
})

const opencodeDir = (dir: string) => path.join(dir, ".opencode")
const settingsPath = (dir: string) => path.join(opencodeDir(dir), "settings.json")

const writeSettings = (dir: string, ctx: string) =>
  Effect.promise(async () => {
    await fs.mkdir(opencodeDir(dir), { recursive: true })
    await fs.writeFile(settingsPath(dir), JSON.stringify(settingsFor(ctx)))
  })

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe("SettingsHook hot-reload — watchSettings wiring (F3)", () => {
  // F3.1 integration: changing settings.json at runtime is picked up by the
  // next trigger after the watcher debounce. The first trigger runs
  // InstanceState.get → loadChain (reads v1) AND wires watchSettings; the
  // on-disk edit fires the .opencode dir watcher, reload() re-runs loadChain
  // (reads v2), and onReload mutates the cached state object's .settings in
  // place — visible to trigger without invalidating the cache.
  it.instance(
    "runtime settings.json change is surfaced by the next trigger after debounce",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service

        // Baseline: trigger runs loadChain (v1) and starts the watcher.
        const r1 = yield* hook.trigger(
          { event: "SessionStart", source: "startup" },
          { sessionID: "sess-f3-base", transcriptPath: "" },
        )
        expect(r1.additionalContexts).toEqual([CONTEXT_V1])

        // Edit the on-disk settings to v2.
        const inst = yield* TestInstance
        yield* writeSettings(inst.directory, CONTEXT_V2)

        // Poll until the hot-reload has mutated the cached settings to v2.
        // Each poll uses a fresh session so per-session dedup never masks the
        // new marker. The reload is driven by the watcher's 500ms setTimeout
        // debounce + fs.watch delivery, so we wait on the observable effect
        // rather than a fixed sleep.
        let n = 0
        yield* pollWithTimeout(
          Effect.gen(function* () {
            n += 1
            const r = yield* hook.trigger(
              { event: "SessionStart", source: "startup" },
              { sessionID: `sess-f3-poll-${n}`, transcriptPath: "" },
            )
            return r.additionalContexts.includes(CONTEXT_V2) ? true : undefined
          }),
          "settings hot-reload did not surface v2 within timeout",
          "6 seconds",
        )

        // Final confirmation with a clean session.
        const r2 = yield* hook.trigger(
          { event: "SessionStart", source: "startup" },
          { sessionID: "sess-f3-final", transcriptPath: "" },
        )
        expect(r2.additionalContexts).toEqual([CONTEXT_V2])
      }),
    { init: (dir) => writeSettings(dir, CONTEXT_V1) },
  )

  // F3.2 + cleanup: watchSettings watches parent dirs (so it fires on a
  // settings.json change) and handle.close() stops all reloads. Direct unit
  // test of the watcher mechanism, independent of the SettingsHook layer.
  // Fixed sleeps are justified here — this test exercises debounce/throttle
  // timing and proves absence of reload after close().
  test("watchSettings reloads on settings.json change and stops after close", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hot-reload-"))
    const file = settingsPath(dir)
    await fs.mkdir(opencodeDir(dir), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ hooks: {} }))

    let marker: string | undefined
    const handle = watchSettings(
      dir,
      undefined,
      () =>
        Effect.sync(() => ({
          hooks: { SessionStart: [{ hooks: [{ type: "command", command: "true" }] }] },
        })),
      () => {
        marker = "reloaded"
      },
    )

    // Trigger a change. fs.watch fires "change" for settings.json on overwrite.
    await fs.writeFile(file, JSON.stringify({ hooks: { Stop: [] } }))
    // Wait past the 500ms debounce for the reload to land.
    await sleep(1000)
    expect(marker).toBe("reloaded")

    // After close(), further changes must NOT reload.
    handle.close()
    marker = undefined
    await fs.writeFile(file, JSON.stringify({ hooks: { Notification: [] } }))
    await sleep(1000)
    expect(marker).toBeUndefined()

    await fs.rm(dir, { recursive: true, force: true })
  })
})
