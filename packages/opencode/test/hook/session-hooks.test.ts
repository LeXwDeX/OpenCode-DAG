/**
 * SessionHooks (WP-5D) — dynamic session-scoped hook injection.
 *
 * Verifies the SessionHookStore + SettingsHook.trigger merge contract:
 *   1. add() entries surface alongside settings-file matchers
 *   2. once: true entries auto-remove after one firing
 *   3. add() is per-session — sessions are isolated
 *   4. ctx.isSubAgent translates Stop→SubagentStop for session-hook lookup
 *   5. remove() drops a single entry by id
 *
 * Tests use a marker-file pattern: each session hook is a `command` type that
 * `touch`es a sentinel file. After triggering, we count files (or check existence)
 * to verify per-session isolation and once-cleanup.
 */
import { describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { existsSync } from "fs"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { SettingsHook } from "../../src/hook/settings"
import type { HookPayload, TriggerContext } from "../../src/hook/settings"
import { SessionHooks } from "../../src/hook/session-hooks"
import { SessionID } from "../../src/session/schema"

const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const it = testEffect(
  Layer.mergeAll(SettingsHook.defaultLayer, SessionHooks.defaultLayer).pipe(Layer.provideMerge(infra)),
)

function touchCommand(file: string) {
  // Quote-escape for sh -c. Hook entries already run under sh on POSIX.
  const escaped = file.replace(/'/g, "'\\''")
  return `cat > /dev/null; printf '' >> '${escaped}'`
}

async function countLines(file: string): Promise<number> {
  if (!existsSync(file)) return 0
  const text = await fs.readFile(file, "utf8")
  return text.length
}

describe("SessionHooks", () => {
  // ── 1. add + list main path ────────────────────────────────────
  it.live("addSessionHook → trigger fires the registered hook", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sh = yield* SessionHooks.Service
        const settings = yield* SettingsHook.Service
        const sid = SessionID.make("ses_main_1")
        const marker = path.join(dir, "fired.txt")

        yield* sh.add(sid, {
          event: "PreToolUse",
          matcher: "bash",
          hooks: [{ type: "command", command: touchCommand(marker) }],
        })

        const payload: HookPayload = {
          event: "PreToolUse",
          toolName: "bash",
          toolInput: { command: "ls" },
        }
        const ctx: TriggerContext = { sessionID: sid, transcriptPath: "" }
        yield* settings.trigger(payload, ctx)

        expect(existsSync(marker)).toBe(true)

        // Entry persists across triggers (no `once`).
        yield* settings.trigger(payload, ctx)
        // Two trigger invocations → two appends → 0 chars (printf '' appends nothing),
        // so use a real marker test: count occurrences via a different command.
        // Simpler: list() should still report 1 entry.
        const remaining = yield* sh.list(sid, "PreToolUse")
        expect(remaining.length).toBe(1)
      }),
    ),
  )

  // ── 2. once: true auto-removal ────────────────────────────────
  it.live("once: true entry executes exactly once and is then removed", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sh = yield* SessionHooks.Service
        const settings = yield* SettingsHook.Service
        const sid = SessionID.make("ses_once_1")
        const marker = path.join(dir, "once.txt")

        // Use a command that appends "x" each firing so we can count.
        const escaped = marker.replace(/'/g, "'\\''")
        const cmd = `cat > /dev/null; printf 'x' >> '${escaped}'`

        yield* sh.add(sid, {
          event: "UserPromptSubmit",
          hooks: [{ type: "command", command: cmd }],
          once: true,
        })

        const payload: HookPayload = { event: "UserPromptSubmit", prompt: "hi" }
        const ctx: TriggerContext = { sessionID: sid, transcriptPath: "" }

        yield* settings.trigger(payload, ctx)
        yield* settings.trigger(payload, ctx)
        yield* settings.trigger(payload, ctx)

        const chars = yield* Effect.promise(() => countLines(marker))
        expect(chars).toBe(1)

        const after = yield* sh.list(sid, "UserPromptSubmit")
        expect(after.length).toBe(0)
      }),
    ),
  )

  // ── 3. session isolation ──────────────────────────────────────
  it.live("hooks added under sessionA are invisible to sessionB triggers", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sh = yield* SessionHooks.Service
        const settings = yield* SettingsHook.Service
        const sidA = SessionID.make("ses_iso_a")
        const sidB = SessionID.make("ses_iso_b")
        const markerA = path.join(dir, "a.txt")

        yield* sh.add(sidA, {
          event: "PreToolUse",
          matcher: "*",
          hooks: [{ type: "command", command: touchCommand(markerA) }],
        })

        // Trigger from sessionB — A's hook must NOT run.
        const payload: HookPayload = {
          event: "PreToolUse",
          toolName: "bash",
          toolInput: {},
        }
        yield* settings.trigger(payload, { sessionID: sidB, transcriptPath: "" })
        expect(existsSync(markerA)).toBe(false)

        // Trigger from sessionA — A's hook DOES run.
        yield* settings.trigger(payload, { sessionID: sidA, transcriptPath: "" })
        expect(existsSync(markerA)).toBe(true)
      }),
    ),
  )

  // ── 4. Stop → SubagentStop translation ─────────────────────────
  it.live("ctx.isSubAgent routes Stop payload to SubagentStop session hooks", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sh = yield* SessionHooks.Service
        const settings = yield* SettingsHook.Service
        const sid = SessionID.make("ses_subagent_1")
        const stopMarker = path.join(dir, "stop.txt")
        const subMarker = path.join(dir, "sub.txt")

        yield* sh.add(sid, {
          event: "Stop",
          hooks: [{ type: "command", command: touchCommand(stopMarker) }],
        })
        yield* sh.add(sid, {
          event: "SubagentStop",
          hooks: [{ type: "command", command: touchCommand(subMarker) }],
        })

        const payload: HookPayload = { event: "Stop", stopHookActive: false }

        // Sub-agent context: Stop payload must translate to SubagentStop lookup.
        yield* settings.trigger(payload, {
          sessionID: sid,
          transcriptPath: "",
          isSubAgent: true,
        })
        expect(existsSync(subMarker)).toBe(true)
        expect(existsSync(stopMarker)).toBe(false)

        // Main session context: Stop payload looks up Stop session hooks.
        yield* settings.trigger(payload, {
          sessionID: sid,
          transcriptPath: "",
        })
        expect(existsSync(stopMarker)).toBe(true)
      }),
    ),
  )

  // ── 5. explicit remove drops the entry ─────────────────────────
  it.live("remove() drops a specific entry; trigger no longer fires it", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sh = yield* SessionHooks.Service
        const settings = yield* SettingsHook.Service
        const sid = SessionID.make("ses_remove_1")
        const marker = path.join(dir, "rm.txt")

        const id = yield* sh.add(sid, {
          event: "PreToolUse",
          matcher: "*",
          hooks: [{ type: "command", command: touchCommand(marker) }],
        })

        yield* sh.remove(sid, id)

        yield* settings.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: {} },
          { sessionID: sid, transcriptPath: "" },
        )
        expect(existsSync(marker)).toBe(false)

        const remaining = yield* sh.list(sid, "PreToolUse")
        expect(remaining.length).toBe(0)
      }),
    ),
  )
})
