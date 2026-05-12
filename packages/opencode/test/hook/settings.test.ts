/**
 * Per-event unit tests for SettingsHook.Service.trigger.
 *
 * Design note: all 8 events share one trigger pipeline (settings load → matcher
 * → exec → stdout protocol). Splitting into 8 sibling files would duplicate the
 * fixture entirely. We use one file with one describe block per event (UserPromptSubmit
 * already covered by test/session/prompt.test.ts integration), each verifying:
 *
 *   1. event-specific stdin envelope shape (tool_name / prompt / source / ...)
 *   2. matcher target rule (tool events use tool_name; non-tool events ignore matcher)
 *   3. control-protocol effect on TriggerResult (additionalContext, systemMessage,
 *      decision=block, exit-code-2 block, continue=false, updatedInput)
 *
 * WP-4A/4B/4C/4D-2 add per-handler describe blocks at the bottom of this file.
 * Those use a separate `itCustom` instance so each test can substitute its own
 * Provider/Auth/HttpClient layer (the global `it` above runs the production
 * defaultLayer which only exercises the command handler path).
 */
import { afterAll, beforeAll, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { HttpClient, HttpClientResponse, FetchHttpClient } from "effect/unstable/http"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { SettingsHook } from "../../src/hook/settings"
import type { HookEvent, HookPayload, TriggerContext } from "../../src/hook/settings"
import { SessionHooks } from "../../src/hook/session-hooks"
import { MCP } from "../../src/mcp"
import { Provider } from "../../src/provider/provider"
import { Auth } from "../../src/auth"
import { ProviderTest } from "../fake/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"

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

describe("SettingsHook.trigger / WP-5B continue=false short-circuit", () => {
  // Strategy: each hook command writes a marker file. After trigger we list
  // the directory and assert which markers exist — the second hook (post
  // continue=false) must be absent.
  async function writeShortCircuitSettings(dir: string, mode: "inner" | "outer") {
    const mk = (name: string, json?: string) => {
      const marker = path.join(dir, name).replace(/'/g, "'\\''")
      const stdout = (json ?? "").replace(/'/g, "'\\''")
      return `touch '${marker}'; printf '%s' '${stdout}'`
    }
    const stop1 = JSON.stringify({ continue: false, stopReason: "halt" })
    const hook1 = { type: "command", command: mk("hit-1", stop1) }
    const hook2 = { type: "command", command: mk("hit-2") }
    const settings =
      mode === "inner"
        ? {
            hooks: {
              Stop: [{ matcher: "*", hooks: [hook1, hook2] }],
            },
          }
        : {
            hooks: {
              Stop: [
                { matcher: "*", hooks: [hook1] },
                { matcher: "*", hooks: [hook2] },
              ],
            },
          }
    await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
    await fs.writeFile(path.join(dir, ".opencode", "settings.json"), JSON.stringify(settings))
  }

  it.live("inner-loop break: subsequent hooks in same matcher are skipped", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeShortCircuitSettings(dir, "inner"))
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger({ event: "Stop", stopHookActive: false }, ctx)
        expect(result.preventContinuation).toBe(true)
        expect(result.stopReason).toBe("halt")
        const ran1 = yield* Effect.promise(() =>
          fs.access(path.join(dir, "hit-1")).then(() => true).catch(() => false),
        )
        const ran2 = yield* Effect.promise(() =>
          fs.access(path.join(dir, "hit-2")).then(() => true).catch(() => false),
        )
        expect(ran1).toBe(true)
        expect(ran2).toBe(false)
      }),
    ),
  )

  it.live("outer-loop break: subsequent matchers are skipped", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeShortCircuitSettings(dir, "outer"))
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger({ event: "Stop", stopHookActive: false }, ctx)
        expect(result.preventContinuation).toBe(true)
        const ran1 = yield* Effect.promise(() =>
          fs.access(path.join(dir, "hit-1")).then(() => true).catch(() => false),
        )
        const ran2 = yield* Effect.promise(() =>
          fs.access(path.join(dir, "hit-2")).then(() => true).catch(() => false),
        )
        expect(ran1).toBe(true)
        expect(ran2).toBe(false)
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

// ══════════════════════════════════════════════════════════════════
// WP-4A — handler abstraction (command/mcp dispatch + unsupported)
// ══════════════════════════════════════════════════════════════════
//
// runEntry walks `handlers[entry.type]` (settings.ts:951-957). For the command
// path we already exercise it everywhere above; here we add focused tests for:
//   1. `type:"command"` produces command-handler effects (decision=block JSON wins).
//   2. `type:"mcp"` is dispatched to the mcp handler — `mcp__` prefix gate ensures
//      a malformed command is silent-allowed (never crashes the host).
//   3. Unknown type → silent allow + synthetic exitBlock string per
//      runEntry's "not yet implemented" branch.
//
// All three use the production defaultLayer (the global `it`) — no custom
// dependency stubs are needed because the dispatch table is built inside the
// layer's gen block and is not parameterizable.

describe("SettingsHook.trigger / WP-4A handler dispatch", () => {
  it.live("dispatches type:command to the command handler (decision=block round-trip)", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        // PostToolUse: top-level decision=block is honored (parseStdout → result.blocked.reason).
        yield* Effect.promise(() =>
          writeHookSettings(dir, "PostToolUse", {
            matcher: "*",
            stdoutJSON: JSON.stringify({ decision: "block", reason: "command-handler routed" }),
          }),
        )
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger(
          { event: "PostToolUse", toolName: "bash", toolInput: {}, toolResponse: "" },
          ctx,
        )
        expect(result.blocked?.reason).toBe("command-handler routed")
      }),
    ),
  )

  it.live("dispatches type:mcp to the mcp handler (malformed command → silent allow)", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        // `command` doesn't start with mcp__ → mcp handler logs warn and returns undefined,
        // proving dispatch reached invokeMcpHook (settings.ts:1090-1093) rather than the
        // command shell or the unsupported-type branch (which would set exitBlock).
        const settings = {
          hooks: {
            PreToolUse: [
              {
                matcher: "*",
                hooks: [{ type: "mcp", command: "not_mcp_prefix__server__tool" }],
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
        // Silent allow — no exitBlock, no decision propagated.
        expect(result.blocked).toBeUndefined()
        expect(result.permissionDecision).toBeUndefined()
      }),
    ),
  )

  it.live("unknown type is silently skipped by trigger's whitelist (no blocked)", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        // trigger's loop (settings.ts:1002-1009) filters out non-{command,mcp,http,prompt,agent}
        // types before runEntry. Result: no exitBlock, the entry is just skipped.
        // This documents forward-compat behavior for future schema entries the fork
        // doesn't yet recognize.
        const settings = {
          hooks: {
            PreToolUse: [
              {
                matcher: "*",
                hooks: [{ type: "foobar", command: "irrelevant" }],
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
        expect(result.blocked).toBeUndefined()
        expect(result.systemMessages).toEqual([])
      }),
    ),
  )
})

// ══════════════════════════════════════════════════════════════════
// WP-4B — http handler (mock HttpClient)
// ══════════════════════════════════════════════════════════════════
//
// Each test substitutes a mock HttpClient via Layer.fresh(SettingsHook.layer) +
// Layer.provide chain. The mock returns a synthesized Response and we assert on
// the trigger-aggregator outcome.
//
// makeHttpHandler (settings.ts:691-728) contract:
//   2xx → parseStdout(body) → JSON merged into result
//   non-2xx → exitBlock = "http hook returned status N"
//   timeout / network error → silent allow (result.blocked undefined)

const encoder = new TextEncoder()

function mockHttpClient(handler: (req: any) => Response) {
  const client = HttpClient.make((req) => Effect.succeed(HttpClientResponse.fromWeb(req, handler(req))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

function settingsHookWithHttp(httpLayer: Layer.Layer<HttpClient.HttpClient, any>) {
  // Layer.fresh forces a new SettingsHook instance bound to our mock http;
  // the production defaultLayer already memoizes one bound to FetchHttpClient.
  return Layer.fresh(SettingsHook.layer).pipe(
    Layer.provide(MCP.defaultLayer),
    Layer.provide(httpLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(SessionHooks.defaultLayer),
    Layer.provideMerge(infra),
  )
}

async function writeHttpHook(dir: string, url: string) {
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "http", command: url, timeout: 5 }],
        },
      ],
    },
  }
  await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
  await fs.writeFile(path.join(dir, ".opencode", "settings.json"), JSON.stringify(settings))
}

describe("SettingsHook.trigger / WP-4B http handler", () => {
  const itOk = testEffect(
    settingsHookWithHttp(
      mockHttpClient(
        () =>
          new Response(JSON.stringify({ decision: "block", reason: "http-decided" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    ),
  )
  itOk.live("2xx JSON body parsed → decision=block surfaces as result.blocked", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeHttpHook(dir, "https://example.test/hook"))
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: {} },
          ctx,
        )
        expect(result.blocked?.reason).toBe("http-decided")
      }),
    ),
  )

  const it500 = testEffect(
    settingsHookWithHttp(mockHttpClient(() => new Response("internal error", { status: 500 }))),
  )
  it500.live("non-2xx → synthetic exitBlock 'http hook returned status N'", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeHttpHook(dir, "https://example.test/hook"))
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: {} },
          ctx,
        )
        expect(result.blocked?.reason).toBe("http hook returned status 500")
      }),
    ),
  )

  // Network error path: HttpClient.make handler that dies → withTransientReadRetry surfaces
  // failure → outer Effect.exit catches → log.warn + silent allow (settings.ts:712-718).
  const itNetErr = testEffect(
    settingsHookWithHttp(Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => Effect.die("net down")))),
  )
  itNetErr.live("network error / failure → silent allow (result.blocked undefined)", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeHttpHook(dir, "https://example.test/hook"))
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: {} },
          ctx,
        )
        expect(result.blocked).toBeUndefined()
        expect(result.permissionDecision).toBeUndefined()
      }),
    ),
  )
})

// ══════════════════════════════════════════════════════════════════
// WP-4C — prompt handler (Provider/Auth stubs)
// ══════════════════════════════════════════════════════════════════
//
// makePromptHandler (settings.ts:749-802) contract:
//   - OpenAI OAuth provider → silent allow (no API path for generateObject)
//   - generateObject reject → silent allow (`prompt hook failed` log)
//   - setup defect (e.g. getLanguage die) → silent allow (`setup failed` log)
//
// All three failure modes converge on result.blocked === undefined — that's
// the contract the trigger pipeline cares about. We verify behavior, not
// log strings (those are tested implicitly by the lack of crash).

function authOauthLayer() {
  return Layer.succeed(
    Auth.Service,
    Auth.Service.of({
      get: () =>
        Effect.succeed({
          type: "oauth",
          refresh: "r",
          access: "a",
          expires: 0,
        } as unknown as Auth.Info),
      all: () => Effect.succeed({} as Record<string, Auth.Info>),
      set: () => Effect.void,
      remove: () => Effect.void,
    }),
  )
}

function authNoneLayer() {
  return Layer.succeed(
    Auth.Service,
    Auth.Service.of({
      get: () => Effect.succeed(undefined),
      all: () => Effect.succeed({} as Record<string, Auth.Info>),
      set: () => Effect.void,
      remove: () => Effect.void,
    }),
  )
}

function settingsHookWithProviderAuth(
  providerLayer: Layer.Layer<Provider.Service, any>,
  authLayer: Layer.Layer<Auth.Service, any>,
) {
  return Layer.fresh(SettingsHook.layer).pipe(
    Layer.provide(MCP.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(providerLayer),
    Layer.provide(authLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(SessionHooks.defaultLayer),
    Layer.provideMerge(infra),
  )
}

async function writePromptHook(dir: string, prompt: string) {
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "prompt", command: prompt }],
        },
      ],
    },
  }
  await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
  await fs.writeFile(path.join(dir, ".opencode", "settings.json"), JSON.stringify(settings))
}

describe("SettingsHook.trigger / WP-4C prompt handler", () => {
  // OpenAI provider + OAuth auth → settings.ts:766-771 short-circuits before any LLM call.
  const provOpenAI = ProviderTest.fake({
    model: ProviderTest.model({
      id: ModelID.make("gpt-4"),
      providerID: ProviderID.make("openai"),
    }),
  })
  const itOAuth = testEffect(settingsHookWithProviderAuth(provOpenAI.layer, authOauthLayer()))
  itOAuth.live("OpenAI OAuth provider → silent allow (no LLM call)", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writePromptHook(dir, "Decide whether to allow this tool call."))
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: {} },
          ctx,
        )
        expect(result.blocked).toBeUndefined()
      }),
    ),
  )

  // Non-OpenAI provider w/ no auth → reaches generateObject; ProviderTest.fake's default
  // getLanguage Effect.die surfaces as an LLM failure → settings.ts:788-790 silent allow.
  const provGeneric = ProviderTest.fake({
    model: ProviderTest.model({
      id: ModelID.make("test-model"),
      providerID: ProviderID.make("anthropic"),
    }),
  })
  const itLlmFail = testEffect(settingsHookWithProviderAuth(provGeneric.layer, authNoneLayer()))
  itLlmFail.live("generateObject failure (provider getLanguage die) → silent allow", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writePromptHook(dir, "Audit the call."))
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: {} },
          ctx,
        )
        // Whichever path this hits — getLanguage die in setup gen, or generateObject
        // reject — both converge on silent allow. result.blocked must remain undefined.
        expect(result.blocked).toBeUndefined()
      }),
    ),
  )

  // Setup failure: provider whose defaultModel itself dies → caught by outer Effect.exit
  // wrapper at settings.ts:793-798 ("prompt hook setup failed") rather than inner LLM exit.
  const provDeadDefault = {
    layer: Layer.succeed(
      Provider.Service,
      Provider.Service.of({
        list: Effect.fn("DeadProvider.list")(() => Effect.succeed({})),
        getProvider: Effect.fn("DeadProvider.getProvider")(() =>
          Effect.die(new Error("provider unreachable")),
        ),
        getModel: Effect.fn("DeadProvider.getModel")(() =>
          Effect.die(new Error("provider unreachable")),
        ),
        getLanguage: Effect.fn("DeadProvider.getLanguage")(() =>
          Effect.die(new Error("provider unreachable")),
        ),
        closest: Effect.fn("DeadProvider.closest")(() => Effect.succeed(undefined)),
        getSmallModel: Effect.fn("DeadProvider.getSmallModel")(() => Effect.succeed(undefined)),
        defaultModel: Effect.fn("DeadProvider.defaultModel")(() =>
          Effect.die(new Error("provider unreachable")),
        ),
      }),
    ),
  }
  const itSetupDie = testEffect(
    settingsHookWithProviderAuth(provDeadDefault.layer as any, authNoneLayer()),
  )
  itSetupDie.live("provider service die (defaultModel) → silent allow (setup failed branch)", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writePromptHook(dir, "Audit the call."))
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: {} },
          ctx,
        )
        expect(result.blocked).toBeUndefined()
      }),
    ),
  )
})

// ══════════════════════════════════════════════════════════════════
// WP-4D-2 — agent handler (multi-turn LLM + synthetic_output tool)
// ══════════════════════════════════════════════════════════════════
//
// makeAgentHandler (settings.ts:821-924) contract:
//   - synthetic_output captured.value with decision=block → blocked surfaces in result
//   - synthetic_output with hookSpecificOutput.additionalContext → appended
//   - max turns reached without synthetic_output → silent allow (`reached max turns`)
//   - OpenAI OAuth → silent allow short-circuit (settings.ts:836-841)
//   - setup die (defaultModel) → silent allow (`setup failed` outer branch)
//   - generateText reject → silent allow (`generateText failed` branch)
//
// fakeLanguageModel scripts a sequence of turns. The ai SDK consumes
// `doGenerate` which returns content blocks; for tool turns we emit
// `tool-call` content with the synthetic JSON args. The agent loop polls
// `captured.value` after each turn (settings.ts:871) and short-circuits.

function fakeLanguageModel(
  scripted: Array<{
    toolCalls?: Array<{ name: string; args: object }>
    text?: string
    finishReason?: string
  }>,
) {
  let step = 0
  return {
    specificationVersion: "v3" as const,
    provider: "test",
    modelId: "test",
    supportedUrls: () => ({}),
    doGenerate: async (_options: any) => {
      const s = scripted[step++] ?? { finishReason: "stop", text: "" }
      const content: any[] = []
      if (s.text) content.push({ type: "text", text: s.text })
      for (const tc of s.toolCalls ?? []) {
        content.push({
          type: "tool-call",
          toolCallId: `tc-${step}-${tc.name}`,
          toolName: tc.name,
          input: JSON.stringify(tc.args),
        })
      }
      return {
        content,
        finishReason: s.finishReason ?? (s.toolCalls?.length ? "tool-calls" : "stop"),
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        warnings: [],
      }
    },
    doStream: async () => {
      throw new Error("not used")
    },
  }
}

function provWithLanguage(language: unknown) {
  return ProviderTest.fake({
    model: ProviderTest.model({
      id: ModelID.make("test-model"),
      providerID: ProviderID.make("anthropic"),
    }),
    getLanguage: Effect.fn("TestProvider.getLanguage.scripted")(() =>
      Effect.succeed(language as never),
    ),
  })
}

async function writeAgentHook(dir: string, prompt: string, timeoutMs?: number) {
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "agent",
              command: prompt,
              ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
            },
          ],
        },
      ],
    },
  }
  await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
  await fs.writeFile(path.join(dir, ".opencode", "settings.json"), JSON.stringify(settings))
}

describe("SettingsHook.trigger / WP-4D-2 agent handler", () => {
  // ── 1. synthetic_output deny → blocked surfaces in result.
  const provDeny = provWithLanguage(
    fakeLanguageModel([
      {
        toolCalls: [
          {
            name: "synthetic_output",
            args: {
              decision: "block",
              reason: "agent denied",
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: "agent reasoned deny",
              },
            },
          },
        ],
      },
    ]),
  )
  const itDeny = testEffect(settingsHookWithProviderAuth(provDeny.layer, authNoneLayer()))
  itDeny.live("synthetic_output decision=block → result.blocked + permissionDecision deny", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeAgentHook(dir, "Audit this tool call."))
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: { command: "rm -rf /" } },
          ctx,
        )
        expect(result.blocked?.reason).toBe("agent denied")
        expect(result.permissionDecision).toBe("deny")
        expect(result.permissionDecisionReason).toBe("agent reasoned deny")
      }),
    ),
  )

  // ── 2. synthetic_output allow + additionalContext appended.
  const provAllow = provWithLanguage(
    fakeLanguageModel([
      {
        toolCalls: [
          {
            name: "synthetic_output",
            args: {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                additionalContext: "agent suggests caution: review path",
              },
            },
          },
        ],
      },
    ]),
  )
  const itAllow = testEffect(settingsHookWithProviderAuth(provAllow.layer, authNoneLayer()))
  itAllow.live("synthetic_output allow + additionalContext appended (no block)", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeAgentHook(dir, "Audit this tool call."))
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: {} },
          ctx,
        )
        expect(result.blocked).toBeUndefined()
        expect(result.additionalContexts).toContain("agent suggests caution: review path")
      }),
    ),
  )

  // ── 3. Max turns: 250 text-only turns scripted; loop bails after MAX_AGENT_TURNS=200
  //    or after the first pure-text turn with zero tool calls (settings.ts:881). Both
  //    paths converge on silent allow.
  const provMaxTurns = provWithLanguage(
    fakeLanguageModel(Array.from({ length: 250 }, () => ({ text: "thinking" }))),
  )
  const itMaxTurns = testEffect(settingsHookWithProviderAuth(provMaxTurns.layer, authNoneLayer()))
  itMaxTurns.live("max turns / no synthetic_output → silent allow", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeAgentHook(dir, "Think a lot."))
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: {} },
          ctx,
        )
        expect(result.blocked).toBeUndefined()
      }),
    ),
  )

  // ── 4. OpenAI OAuth skip — short-circuits before ever touching getLanguage.
  const provOpenAI4D = ProviderTest.fake({
    model: ProviderTest.model({
      id: ModelID.make("gpt-4"),
      providerID: ProviderID.make("openai"),
    }),
  })
  const itOauth4D = testEffect(settingsHookWithProviderAuth(provOpenAI4D.layer, authOauthLayer()))
  itOauth4D.live("OpenAI OAuth provider → silent allow (no LLM call)", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeAgentHook(dir, "Audit."))
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: {} },
          ctx,
        )
        expect(result.blocked).toBeUndefined()
      }),
    ),
  )

  // ── 5. Setup die: ProviderTest.fake's default getLanguage Effect.die.
  //    We do NOT inject a fake language model — the default die in fake() at
  //    test/fake/provider.ts:64-66 fires inside the inner gen body and is
  //    caught by the outer Effect.exit at settings.ts:917-920 (setup failed).
  const provSetupDie = ProviderTest.fake({
    model: ProviderTest.model({
      id: ModelID.make("test-model"),
      providerID: ProviderID.make("anthropic"),
    }),
  })
  const itSetupDie4D = testEffect(
    settingsHookWithProviderAuth(provSetupDie.layer, authNoneLayer()),
  )
  itSetupDie4D.live("setup die (default getLanguage Effect.die) → silent allow", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeAgentHook(dir, "Audit."))
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: {} },
          ctx,
        )
        expect(result.blocked).toBeUndefined()
      }),
    ),
  )

  // ── 6. generateText reject — language model whose doGenerate throws. The ai SDK
  //    surfaces this as a Promise rejection inside the loop's tryPromise wrapper
  //    (settings.ts:854-889) → log.warn `generateText failed` → silent allow.
  const provGenTextReject = provWithLanguage({
    specificationVersion: "v3" as const,
    provider: "test",
    modelId: "test",
    supportedUrls: () => ({}),
    doGenerate: async () => {
      throw new Error("simulated generateText failure")
    },
    doStream: async () => {
      throw new Error("not used")
    },
  })
  const itGenTextReject = testEffect(
    settingsHookWithProviderAuth(provGenTextReject.layer, authNoneLayer()),
  )
  itGenTextReject.live("generateText reject → silent allow", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeAgentHook(dir, "Audit."))
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: {} },
          ctx,
        )
        expect(result.blocked).toBeUndefined()
      }),
    ),
  )
})

// ══════════════════════════════════════════════════════════════════
// WP-4F/3 — handler × event matrix coverage
// ══════════════════════════════════════════════════════════════════
//
// 8 tests covering the cross-product of {mcp, http, prompt, agent} handlers
// with the 8 lifecycle events (excluding PreToolUse which is exhaustively
// covered above). All tests verify the fail-safe contract: hook errors must
// converge on silent allow (result.blocked undefined) — never crash the host
// or block the main flow on infra failure.
//
// Knowingly accepted spec drift (per WP-4F/3 brief §"灰色地带"):
//   - http 5xx test: spec says "silent allow" but settings.ts:721 surfaces a
//     synthetic exitBlock for non-2xx. Test asserts the actual exitBlock contract.
//   - prompt SessionStart approve: spec says assert blocked=false. The fake
//     provider's getLanguage Effect.die converges on silent allow (blocked
//     undefined) — equivalent to "approve" semantically (no block surfaced).

async function writeHookSettingsForType(
  dir: string,
  event: HookEvent,
  entry: Record<string, unknown>,
) {
  const settings = {
    hooks: {
      [event]: [{ matcher: "*", hooks: [entry] }],
    },
  }
  await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
  await fs.writeFile(path.join(dir, ".opencode", "settings.json"), JSON.stringify(settings))
}

describe("SettingsHook.trigger / WP-4F handler × event matrix", () => {
  // ── 1. PostToolUse + mcp (P0): malformed mcp__ prefix → silent allow.
  it.live("dispatches type:mcp on PostToolUse (malformed prefix → silent allow)", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeHookSettingsForType(dir, "PostToolUse", {
            type: "mcp",
            command: "bad__prefix",
          }),
        )
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger(
          { event: "PostToolUse", toolName: "bash", toolInput: {}, toolResponse: "" },
          ctx,
        )
        expect(result.blocked).toBeUndefined()
      }),
    ),
  )

  // ── 2. UserPromptSubmit + http (P0): 200 empty body → silent allow
  //      (parseStdout treats non-{ start as plain-text → undefined json).
  const itHttpEmpty = testEffect(
    settingsHookWithHttp(
      mockHttpClient(
        () =>
          new Response("", { status: 200, headers: { "content-type": "text/plain" } }),
      ),
    ),
  )
  itHttpEmpty.live("dispatches type:http on UserPromptSubmit (200 empty body → silent allow)", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeHookSettingsForType(dir, "UserPromptSubmit", {
            type: "http",
            command: "https://example.test/ups",
            timeout: 5,
          }),
        )
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger(
          { event: "UserPromptSubmit", prompt: "hello" },
          ctx,
        )
        expect(result.blocked).toBeUndefined()
        expect(result.systemMessages).toEqual([])
      }),
    ),
  )

  // ── 3. SessionStart + prompt (P1): generic provider w/o auth — getLanguage Effect.die
  //      from ProviderTest.fake converges on silent allow (semantically equivalent to approve).
  const provPromptApprove = ProviderTest.fake({
    model: ProviderTest.model({
      id: ModelID.make("test-model"),
      providerID: ProviderID.make("anthropic"),
    }),
  })
  const itPromptSession = testEffect(
    settingsHookWithProviderAuth(provPromptApprove.layer, authNoneLayer()),
  )
  itPromptSession.live(
    "dispatches type:prompt on SessionStart (provider die path → silent allow ≈ approve)",
    () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeHookSettingsForType(dir, "SessionStart", {
              type: "prompt",
              command: "Approve startup.",
            }),
          )
          const svc = yield* SettingsHook.Service
          const result = yield* svc.trigger(
            { event: "SessionStart", source: "startup" },
            ctx,
          )
          expect(result.blocked).toBeUndefined()
        }),
      ),
  )

  // ── 4. SessionEnd + agent (P1): synthetic_output deny → blocked surfaces.
  const provAgentDeny = provWithLanguage(
    fakeLanguageModel([
      {
        toolCalls: [
          {
            name: "synthetic_output",
            args: {
              decision: "block",
              reason: "session-end agent denied",
            },
          },
        ],
      },
    ]),
  )
  const itAgentSessionEnd = testEffect(
    settingsHookWithProviderAuth(provAgentDeny.layer, authNoneLayer()),
  )
  itAgentSessionEnd.live(
    "dispatches type:agent on SessionEnd (synthetic_output deny → blocked true)",
    () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeHookSettingsForType(dir, "SessionEnd", {
              type: "agent",
              command: "Inspect session end.",
            }),
          )
          const svc = yield* SettingsHook.Service
          const result = yield* svc.trigger(
            { event: "SessionEnd", reason: "logout" },
            ctx,
          )
          expect(result.blocked?.reason).toBe("session-end agent denied")
        }),
      ),
  )

  // ── 5. Stop + mcp (P2): tool not registered → silent allow + log.warn.
  it.live("dispatches type:mcp on Stop (mcp tool not found → silent allow)", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeHookSettingsForType(dir, "Stop", {
            type: "mcp",
            command: "mcp__nope__nonexistent",
          }),
        )
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger(
          { event: "Stop", stopHookActive: false },
          ctx,
        )
        expect(result.blocked).toBeUndefined()
      }),
    ),
  )

  // ── 6. SubagentStop + http (P2): 5xx response.
  //      Knowingly accepted: settings.ts:721-723 returns a synthetic exitBlock for
  //      non-2xx (NOT silent allow as the brief speculated). withTransientReadRetry
  //      only retries transient READ failures, not delivered HTTP error statuses.
  const itHttpSubagent = testEffect(
    settingsHookWithHttp(mockHttpClient(() => new Response("oops", { status: 500 }))),
  )
  itHttpSubagent.live(
    "dispatches type:http on SubagentStop (5xx → synthetic exitBlock surfaces)",
    () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeHookSettingsForType(dir, "SubagentStop", {
              type: "http",
              command: "https://example.test/sa",
              timeout: 5,
            }),
          )
          const svc = yield* SettingsHook.Service
          const result = yield* svc.trigger(
            { event: "SubagentStop", stopHookActive: false },
            ctx,
          )
          expect(result.blocked?.reason).toBe("http hook returned status 500")
        }),
      ),
  )

  // ── 7. PreCompact + agent (P2): pure-text turns → loop early-break (settings.ts:881)
  //      → no synthetic_output captured → silent allow (`reached max turns` log path).
  const provAgentMaxTurns = provWithLanguage(
    fakeLanguageModel([{ text: "thinking but no tools" }]),
  )
  const itAgentPreCompact = testEffect(
    settingsHookWithProviderAuth(provAgentMaxTurns.layer, authNoneLayer()),
  )
  itAgentPreCompact.live(
    "dispatches type:agent on PreCompact (no synthetic_output → silent allow)",
    () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeHookSettingsForType(dir, "PreCompact", {
              type: "agent",
              command: "Decide on compaction.",
            }),
          )
          const svc = yield* SettingsHook.Service
          const result = yield* svc.trigger(
            { event: "PreCompact", trigger: "manual" },
            ctx,
          )
          expect(result.blocked).toBeUndefined()
        }),
      ),
  )

  // ── 8. PreCompact + prompt (P2): OpenAI provider + OAuth → settings.ts:766-771
  //      short-circuits before any LLM call (silent allow, OAuth fallback path).
  const provPromptOauth = ProviderTest.fake({
    model: ProviderTest.model({
      id: ModelID.make("gpt-4"),
      providerID: ProviderID.make("openai"),
    }),
  })
  const itPromptOauthPC = testEffect(
    settingsHookWithProviderAuth(provPromptOauth.layer, authOauthLayer()),
  )
  itPromptOauthPC.live(
    "dispatches type:prompt on PreCompact (OpenAI OAuth noKey → silent allow)",
    () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeHookSettingsForType(dir, "PreCompact", {
              type: "prompt",
              command: "Decide on compaction.",
            }),
          )
          const svc = yield* SettingsHook.Service
          const result = yield* svc.trigger(
            { event: "PreCompact", trigger: "auto" },
            ctx,
          )
          expect(result.blocked).toBeUndefined()
        }),
      ),
  )
})

// ──────────────────────────────────────────────────────────────────
// WP-6A: hasHookForEvent short-circuit
// WP-6C: plugin sourceDir liveness pre-check
// ──────────────────────────────────────────────────────────────────

describe("SettingsHook.trigger / WP-6A short-circuit", () => {
  it.live("no hooks configured → returns empty result without touching matchers", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        // Deliberately do NOT write any settings file. trigger should hit the
        // WP-6A short-circuit (hasFile=false, hasSession=false) and bail with
        // an empty TriggerResult — never building an envelope, never running
        // matcher regex, never dispatching to handlers.
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: { command: "ls" } },
          ctx,
        )
        expect(result.blocked).toBeUndefined()
        expect(result.additionalContexts).toEqual([])
        expect(result.systemMessages).toEqual([])
        expect(result.permissionDecision).toBeUndefined()
        expect(result.preventContinuation).toBeUndefined()
      }),
    ),
  )

  it.live("hook configured for a different event → still short-circuits this event", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        // Configure a Stop hook only — a PreToolUse trigger should not fire it
        // and should take the short-circuit path (hasFile probes payload.event,
        // not the union of all events).
        yield* Effect.promise(() => writeHookSettings(dir, "Stop", { matcher: "*" }))
        const svc = yield* SettingsHook.Service
        const result = yield* svc.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: {} },
          ctx,
        )
        expect(result.blocked).toBeUndefined()
        // Sidecar must not have been written — proves no command executed.
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
})

describe("SettingsHook.trigger / WP-6C plugin sourceDir missing", () => {
  it.live("missing __sourceDir → silent allow (not deny / blocked)", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        // Write a hook config under .claude/settings.json so loadChain stamps
        // __sourceDir = <dir>/.claude on the entry. Hook is `exit 2` — under
        // normal conditions that produces blocked={reason:"Hook blocked..."}.
        // After we delete .claude, the cached entry still has the old
        // __sourceDir; WP-6C's existsSync check inside execShell must convert
        // the stale entry into a silent allow (exitCode 0, blocked undefined).
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(dir, ".claude"), { recursive: true })
          await fs.writeFile(
            path.join(dir, ".claude", "settings.json"),
            JSON.stringify({
              hooks: {
                PreToolUse: [
                  { matcher: "*", hooks: [{ type: "command", command: "exit 2" }] },
                ],
              },
            }),
          )
        })

        const svc = yield* SettingsHook.Service
        // Priming call: .claude exists, hook fires `exit 2` → blocked.
        // This populates InstanceState.cache with the loaded settings (incl.
        // __sourceDir stamping). Behavior here isn't under test.
        const primed = yield* svc.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: {} },
          ctx,
        )
        expect(primed.blocked).toBeDefined()

        // Now delete the plugin source dir behind the cache's back.
        yield* Effect.promise(() =>
          fs.rm(path.join(dir, ".claude"), { recursive: true, force: true }),
        )

        // Cache still holds entry with __sourceDir = <dir>/.claude. WP-6C
        // pre-check should fire and short-circuit execShell to silent allow.
        const result = yield* svc.trigger(
          { event: "PreToolUse", toolName: "bash", toolInput: {} },
          ctx,
        )
        expect(result.blocked).toBeUndefined()
        expect(result.permissionDecision).toBeUndefined()
      }),
    ),
  )
})

