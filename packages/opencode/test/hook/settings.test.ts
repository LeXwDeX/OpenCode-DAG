/**
 * Per-event unit tests for SettingsHook.Service.trigger.
 *
 * Design note: all 9 events share one trigger pipeline (settings load → matcher
 * → exec → stdout protocol). Splitting into 8 sibling files would duplicate the
 * fixture entirely. We use one file with 8 describe blocks (UserPromptSubmit
 * already covered by test/session/prompt.test.ts integration), each verifying:
 *
 *   1. event-specific stdin envelope shape (tool_name / prompt / source / ...)
 *   2. matcher target rule (tool events use tool_name; non-tool events ignore matcher)
 *   3. control-protocol effect on TriggerResult (additionalContext, systemMessage,
 *      decision=block, exit-code-2 block, continue=false, updatedInput)
 */
import { afterAll, beforeAll, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { SettingsHook } from "../../src/hook/settings"
import type { HookEvent, HookPayload, TriggerContext } from "../../src/hook/settings"

const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const it = testEffect(SettingsHook.defaultLayer.pipe(Layer.provideMerge(infra)))

const ctx: TriggerContext = { sessionID: "test-session", transcriptPath: "" }

// Force npm registry deterministic (matches installation.test.ts; harmless side-effect).
const SAVED_REGISTRY = process.env.npm_config_registry
beforeAll(() => {
  process.env.npm_config_registry = "https://registry.npmjs.org/"
})
afterAll(() => {
  if (SAVED_REGISTRY === undefined) delete process.env.npm_config_registry
  else process.env.npm_config_registry = SAVED_REGISTRY
})

/**
 * Write `.opencode/settings.json` in tmpdir with the given hook config for one
 * event. Returns nothing — caller then triggers and asserts.
 *
 * The hook command is a `sh -c` snippet that:
 *   - dumps stdin to a sidecar file `<dir>/captured.json` (so we can inspect envelope)
 *   - prints the supplied `stdoutJSON` to stdout
 *   - exits with `exitCode`
 */
async function writeHookSettings(
  dir: string,
  event: HookEvent,
  options: {
    matcher?: string
    stdoutJSON?: string
    exitCode?: number
    timeout?: number
  } = {},
) {
  const captured = path.join(dir, "captured.json").replace(/'/g, "'\\''")
  const stdout = (options.stdoutJSON ?? "").replace(/'/g, "'\\''")
  const exitCode = options.exitCode ?? 0
  // Read stdin → write to file. Then echo JSON. Then exit with code.
  const command = `cat > '${captured}'; printf '%s' '${stdout}'; exit ${exitCode}`
  const settings = {
    hooks: {
      [event]: [
        {
          ...(options.matcher !== undefined ? { matcher: options.matcher } : {}),
          hooks: [{ type: "command", command, ...(options.timeout ? { timeout: options.timeout } : {}) }],
        },
      ],
    },
  }
  await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
  await fs.writeFile(path.join(dir, ".opencode", "settings.json"), JSON.stringify(settings))
}

async function readEnvelope(dir: string): Promise<Record<string, unknown>> {
  const text = await fs.readFile(path.join(dir, "captured.json"), "utf8")
  return JSON.parse(text)
}

// ──────────────────────────────────────────────────────────────────
// PreToolUse
// ──────────────────────────────────────────────────────────────────

describe("SettingsHook.trigger / PreToolUse", () => {
  it.live("envelope carries tool_name + tool_input; matcher matches by tool name", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeHookSettings(dir, "PreToolUse", { matcher: "bash" }))
        const svc = yield* SettingsHook.Service
        const payload: HookPayload = {
          event: "PreToolUse",
          toolName: "bash",
          toolInput: { command: "ls" },
        }
        yield* svc.trigger(payload, ctx)
        const env = yield* Effect.promise(() => readEnvelope(dir))
        expect(env.hook_event_name).toBe("PreToolUse")
        expect(env.tool_name).toBe("bash")
        expect(env.tool_input).toEqual({ command: "ls" })
        expect(env.session_id).toBe("test-session")
      }),
    ),
  )

  it.live("matcher mismatch skips execution (no envelope captured)", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeHookSettings(dir, "PreToolUse", { matcher: "write" }))
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: {} },
          ctx,
        )
        expect(result.blocked).toBeUndefined()
        const exists = yield* Effect.promise(() =>
          fs
            .access(path.join(dir, "captured.json"))
            .then(() => true)
            .catch(() => false),
        )
        expect(exists).toBe(false)
      }),
    ),
  )

  it.live("hookSpecificOutput.permissionDecision propagates to result", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeHookSettings(dir, "PreToolUse", {
            matcher: "*",
            stdoutJSON: JSON.stringify({
              hookSpecificOutput: {
                permissionDecision: "deny",
                permissionDecisionReason: "policy violation",
              },
            }),
          }),
        )
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: {} },
          ctx,
        )
        expect(result.permissionDecision).toBe("deny")
        expect(result.permissionDecisionReason).toBe("policy violation")
      }),
    ),
  )

  it.live("exit code 2 → blocked with stderr-as-reason", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        // Custom: write stderr then exit 2
        const settings = {
          hooks: {
            PreToolUse: [
              {
                matcher: "*",
                hooks: [{ type: "command", command: "echo dangerous >&2; exit 2" }],
              },
            ],
          },
        }
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
          await fs.writeFile(path.join(dir, ".opencode", "settings.json"), JSON.stringify(settings))
        })
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: {} },
          ctx,
        )
        expect(result.blocked).toBeDefined()
        expect(result.blocked!.reason).toBe("dangerous")
      }),
    ),
  )

  it.live("hookSpecificOutput.updatedInput rewrites tool input", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeHookSettings(dir, "PreToolUse", {
            matcher: "*",
            stdoutJSON: JSON.stringify({
              hookSpecificOutput: { updatedInput: { command: "ls -la" } },
            }),
          }),
        )
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: { command: "ls" } },
          ctx,
        )
        expect(result.updatedInput).toEqual({ command: "ls -la" })
      }),
    ),
  )
})

// ──────────────────────────────────────────────────────────────────
// PostToolUse
// ──────────────────────────────────────────────────────────────────

describe("SettingsHook.trigger / PostToolUse", () => {
  it.live("envelope carries tool_name + tool_input + tool_response", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeHookSettings(dir, "PostToolUse", { matcher: "*" }))
        const svc = yield* SettingsHook.Service
        yield* svc.trigger(
          {
            event: "PostToolUse",
            toolName: "write",
            toolInput: { filePath: "/tmp/x" },
            toolResponse: { ok: true },
          },
          ctx,
        )
        const env = yield* Effect.promise(() => readEnvelope(dir))
        expect(env.hook_event_name).toBe("PostToolUse")
        expect(env.tool_name).toBe("write")
        expect(env.tool_input).toEqual({ filePath: "/tmp/x" })
        expect(env.tool_response).toEqual({ ok: true })
      }),
    ),
  )

  it.live("decision=block produces blocked with reason from JSON", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeHookSettings(dir, "PostToolUse", {
            matcher: "*",
            stdoutJSON: JSON.stringify({ decision: "block", reason: "audit failed" }),
          }),
        )
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger(
          { event: "PostToolUse", toolName: "bash", toolInput: {}, toolResponse: "" },
          ctx,
        )
        expect(result.blocked?.reason).toBe("audit failed")
      }),
    ),
  )
})

// ──────────────────────────────────────────────────────────────────
// Notification
// ──────────────────────────────────────────────────────────────────

describe("SettingsHook.trigger / Notification", () => {
  it.live("envelope carries message; matcher unused (any matcher matches)", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        // No matcher set → defaults to undefined which matches() treats as wildcard
        yield* Effect.promise(() => writeHookSettings(dir, "Notification"))
        const svc = yield* SettingsHook.Service
        yield* svc.trigger({ event: "Notification", message: "hello world" }, ctx)
        const env = yield* Effect.promise(() => readEnvelope(dir))
        expect(env.hook_event_name).toBe("Notification")
        expect(env.message).toBe("hello world")
      }),
    ),
  )

  it.live("systemMessage from JSON appended to result.systemMessages", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeHookSettings(dir, "Notification", {
            stdoutJSON: JSON.stringify({ systemMessage: "FYI: rate limit close" }),
          }),
        )
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger({ event: "Notification", message: "x" }, ctx)
        expect(result.systemMessages).toContain("FYI: rate limit close")
      }),
    ),
  )
})

// ──────────────────────────────────────────────────────────────────
// Stop / SubagentStop (share envelope shape)
// ──────────────────────────────────────────────────────────────────

describe("SettingsHook.trigger / Stop", () => {
  it.live("envelope carries stop_hook_active boolean", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeHookSettings(dir, "Stop"))
        const svc = yield* SettingsHook.Service
        yield* svc.trigger({ event: "Stop", stopHookActive: true }, ctx)
        const env = yield* Effect.promise(() => readEnvelope(dir))
        expect(env.hook_event_name).toBe("Stop")
        expect(env.stop_hook_active).toBe(true)
      }),
    ),
  )

  it.live("continue:false + stopReason propagates to preventContinuation/stopReason", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeHookSettings(dir, "Stop", {
            stdoutJSON: JSON.stringify({ continue: false, stopReason: "user wants pause" }),
          }),
        )
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger({ event: "Stop", stopHookActive: false }, ctx)
        expect(result.preventContinuation).toBe(true)
        expect(result.stopReason).toBe("user wants pause")
      }),
    ),
  )
})

describe("SettingsHook.trigger / SubagentStop", () => {
  it.live("envelope carries stop_hook_active for subagent variant", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeHookSettings(dir, "SubagentStop"))
        const svc = yield* SettingsHook.Service
        yield* svc.trigger({ event: "SubagentStop", stopHookActive: false }, ctx)
        const env = yield* Effect.promise(() => readEnvelope(dir))
        expect(env.hook_event_name).toBe("SubagentStop")
        expect(env.stop_hook_active).toBe(false)
      }),
    ),
  )
})

// ──────────────────────────────────────────────────────────────────
// PreCompact
// ──────────────────────────────────────────────────────────────────

describe("SettingsHook.trigger / PreCompact", () => {
  it.live("envelope carries trigger + custom_instructions (defaulted to empty)", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeHookSettings(dir, "PreCompact"))
        const svc = yield* SettingsHook.Service
        yield* svc.trigger({ event: "PreCompact", trigger: "manual" }, ctx)
        const env = yield* Effect.promise(() => readEnvelope(dir))
        expect(env.hook_event_name).toBe("PreCompact")
        expect(env.trigger).toBe("manual")
        expect(env.custom_instructions).toBe("")
      }),
    ),
  )

  it.live("custom_instructions passed through when set", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeHookSettings(dir, "PreCompact"))
        const svc = yield* SettingsHook.Service
        yield* svc.trigger(
          { event: "PreCompact", trigger: "auto", customInstructions: "preserve TODOs" },
          ctx,
        )
        const env = yield* Effect.promise(() => readEnvelope(dir))
        expect(env.trigger).toBe("auto")
        expect(env.custom_instructions).toBe("preserve TODOs")
      }),
    ),
  )
})

// ──────────────────────────────────────────────────────────────────
// SessionStart
// ──────────────────────────────────────────────────────────────────

describe("SettingsHook.trigger / SessionStart", () => {
  it.live("envelope carries source enum", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeHookSettings(dir, "SessionStart"))
        const svc = yield* SettingsHook.Service
        yield* svc.trigger({ event: "SessionStart", source: "resume" }, ctx)
        const env = yield* Effect.promise(() => readEnvelope(dir))
        expect(env.hook_event_name).toBe("SessionStart")
        expect(env.source).toBe("resume")
      }),
    ),
  )

  it.live("hookSpecificOutput.additionalContext deduped per instance", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeHookSettings(dir, "SessionStart", {
            stdoutJSON: JSON.stringify({
              hookSpecificOutput: { additionalContext: "load project README" },
            }),
          }),
        )
        const svc = yield* SettingsHook.Service
        const r1 = yield* svc.trigger({ event: "SessionStart", source: "startup" }, ctx)
        const r2 = yield* svc.trigger({ event: "SessionStart", source: "startup" }, ctx)
        expect(r1.additionalContexts).toEqual(["load project README"])
        // Second trigger sees same string already in `seen` set → deduped out
        expect(r2.additionalContexts).toEqual([])
      }),
    ),
  )
})

// ──────────────────────────────────────────────────────────────────
// SessionEnd
// ──────────────────────────────────────────────────────────────────

describe("SettingsHook.trigger / SessionEnd", () => {
  it.live("envelope carries reason enum", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeHookSettings(dir, "SessionEnd"))
        const svc = yield* SettingsHook.Service
        yield* svc.trigger({ event: "SessionEnd", reason: "logout" }, ctx)
        const env = yield* Effect.promise(() => readEnvelope(dir))
        expect(env.hook_event_name).toBe("SessionEnd")
        expect(env.reason).toBe("logout")
      }),
    ),
  )

  it.live("non-zero non-2 exit is non-blocking (logged warn, no result effect)", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeHookSettings(dir, "SessionEnd", {
            exitCode: 5,
            stdoutJSON: JSON.stringify({ systemMessage: "still parsed" }),
          }),
        )
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger({ event: "SessionEnd", reason: "other" }, ctx)
        expect(result.blocked).toBeUndefined()
        // stdout JSON still parsed even on non-zero (unless exit==2)
        expect(result.systemMessages).toContain("still parsed")
      }),
    ),
  )
})
