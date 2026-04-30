/**
 * Settings-based hook system — Claude Code protocol-level 1:1 compatible.
 *
 * Reads hooks from a six-layer settings chain (later layers concat on top of
 * earlier ones, mirroring Claude Code's merge behavior):
 *
 *   1. ~/.claude/settings.json                       (CC global, shared)
 *   2. <opencode-global-config>/settings.json        (OpenCode global, optional)
 *   3. <project>/.claude/settings.json
 *   4. <project>/.opencode/settings.json             (OpenCode project, optional)
 *   5. <project>/.claude/settings.local.json         (CC project local)
 *   6. <project>/.opencode/settings.local.json       (OpenCode project local)
 *
 * Supports the full 9-event Claude Code hook surface:
 *   PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStop,
 *   Notification, PreCompact, SessionStart, SessionEnd
 *
 * Hook entry types:
 *   - { type: "command", command: "<shell>", timeout?: <seconds> }
 *   - { type: "mcp",     command: "mcp__<server>__<tool>", timeout?: <seconds> }
 *
 * stdin JSON envelope per Claude Code spec:
 *   { hook_event_name, session_id, transcript_path, cwd, ...event-specific }
 *
 * stdout control JSON (any subset):
 *   { continue, stopReason, suppressOutput, systemMessage,
 *     decision: "approve"|"block", reason,
 *     hookSpecificOutput: { hookEventName, permissionDecision,
 *                            permissionDecisionReason, additionalContext,
 *                            updatedInput } }
 *
 * Exit code semantics (CC spec):
 *   0  → allow, parse stdout
 *   2  → block, stderr → reason
 *   *  → log warning, do NOT abort main flow (mirrors fork commit 0f3017f33a)
 */
import path from "path"
import os from "os"
import { existsSync, readFileSync } from "fs"
import { spawn } from "child_process"
import { Effect, Layer, Context } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { InstanceState } from "@/effect/instance-state"
import { MCP } from "@/mcp"

const log = Log.create({ service: "hook.settings" })

// ── Types (Claude Code 1:1) ─────────────────────────────────────

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop"
  | "SubagentStop"
  | "Notification"
  | "PreCompact"
  | "SessionStart"
  | "SessionEnd"

interface HookCommand {
  type: "command" | "mcp"
  command: string
  timeout?: number
}

interface HookMatcher {
  matcher?: string
  hooks: HookCommand[]
}

interface Settings {
  hooks?: Partial<Record<HookEvent, HookMatcher[]>>
}

interface HookJSONOutput {
  continue?: boolean
  stopReason?: string
  suppressOutput?: boolean
  systemMessage?: string
  decision?: "approve" | "block"
  reason?: string
  hookSpecificOutput?: {
    hookEventName?: string
    permissionDecision?: "allow" | "deny" | "ask"
    permissionDecisionReason?: string
    additionalContext?: string
    updatedInput?: Record<string, unknown>
  }
}

/** Per-event payload — discriminated union, TS narrows automatically. */
export type HookPayload =
  | { event: "PreToolUse"; toolName: string; toolInput: Record<string, unknown> }
  | {
      event: "PostToolUse"
      toolName: string
      toolInput: Record<string, unknown>
      toolResponse: unknown
    }
  | { event: "UserPromptSubmit"; prompt: string }
  | { event: "Stop"; stopHookActive: boolean }
  | { event: "SubagentStop"; stopHookActive: boolean }
  | { event: "Notification"; message: string }
  | {
      event: "PreCompact"
      trigger: "manual" | "auto"
      customInstructions?: string
    }
  | {
      event: "SessionStart"
      source: "startup" | "resume" | "clear" | "compact"
    }
  | {
      event: "SessionEnd"
      reason: "clear" | "logout" | "prompt_input_exit" | "other"
    }

export interface TriggerContext {
  sessionID: string
  /** Absolute path to a transcript file (may not yet exist). Empty string if N/A. */
  transcriptPath: string
}

export interface TriggerResult {
  /** additionalContext strings appended (deduplicated per instance) */
  additionalContexts: string[]
  /** systemMessage strings emitted by hooks */
  systemMessages: string[]
  /** Block decision — non-undefined means main flow must short-circuit */
  blocked?: { reason: string; command: string }
  /** continue=false from any hook */
  preventContinuation?: boolean
  /** stopReason aggregated from hooks that requested non-continuation */
  stopReason?: string
  /** Permission verdict (PreToolUse only meaningful) */
  permissionDecision?: "allow" | "deny" | "ask"
  permissionDecisionReason?: string
  /** Last hook's updatedInput wins (CC behavior) */
  updatedInput?: Record<string, unknown>
}

// ── Matcher ─────────────────────────────────────────────────────

/**
 * Match a string (typically tool name) against a CC matcher pattern.
 * Supports: exact, pipe list, regex, wildcard "*"/empty.
 *
 * For non-tool events (Stop, Notification, etc.) callers pass empty target;
 * matcher should usually be undefined/"*" in those configs.
 */
function matches(matcher: string | undefined, target: string): boolean {
  if (!matcher || matcher === "*") return true
  const normalized = target.toLowerCase()

  if (/^[a-zA-Z0-9_|]+$/.test(matcher)) {
    if (matcher.includes("|")) {
      return matcher
        .split("|")
        .map((p) => p.trim().toLowerCase())
        .includes(normalized)
    }
    return normalized === matcher.toLowerCase()
  }

  try {
    return new RegExp(matcher, "i").test(target)
  } catch {
    log.warn("invalid regex in hook matcher", { matcher })
    return false
  }
}

// ── Settings loader (six-layer chain) ───────────────────────────

function readJSON(filepath: string): Settings | null {
  if (!existsSync(filepath)) return null
  try {
    const data = JSON.parse(readFileSync(filepath, "utf8")) as Settings
    log.info("loaded hook settings", {
      path: filepath,
      events: Object.keys(data.hooks ?? {}),
    })
    return data
  } catch (err) {
    log.error("failed to parse settings.json", { path: filepath, error: String(err) })
    return null
  }
}

/**
 * Concat-merge hook matchers across layers. Later layers append after earlier
 * ones (matches CC's merge semantics — does NOT replace by matcher key).
 */
function mergeSettings(layers: Settings[]): Settings {
  const out: Settings = { hooks: {} }
  for (const layer of layers) {
    if (!layer.hooks) continue
    for (const [event, matchers] of Object.entries(layer.hooks)) {
      const ev = event as HookEvent
      const acc = (out.hooks![ev] ??= [])
      acc.push(...(matchers ?? []))
    }
  }
  return out
}

function loadChain(directory: string, worktree: string): Settings {
  const home = os.homedir()
  // Best-effort OpenCode global path; falls back to ~/.config/opencode
  const opencodeGlobal = (() => {
    try {
      return Global.Path.config
    } catch {
      return path.join(home, ".config", "opencode")
    }
  })()

  const candidates = [
    path.join(home, ".claude", "settings.json"),
    path.join(opencodeGlobal, "settings.json"),
    path.join(directory, ".claude", "settings.json"),
    path.join(directory, ".opencode", "settings.json"),
    path.join(directory, ".claude", "settings.local.json"),
    path.join(directory, ".opencode", "settings.local.json"),
  ]

  // If worktree differs from directory (e.g. git worktree), also check it
  if (worktree && worktree !== directory) {
    candidates.push(
      path.join(worktree, ".claude", "settings.json"),
      path.join(worktree, ".opencode", "settings.json"),
      path.join(worktree, ".claude", "settings.local.json"),
      path.join(worktree, ".opencode", "settings.local.json"),
    )
  }

  const layers = candidates.map(readJSON).filter((s): s is Settings => s !== null)
  return mergeSettings(layers)
}

// ── Shell command runner ────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60_000 // CC default

function execShell(
  command: string,
  stdinJSON: string,
  cwd: string,
  timeoutSec?: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; spawnError?: string }> {
  return new Promise((resolve) => {
    const timeoutMs = timeoutSec ? timeoutSec * 1000 : DEFAULT_TIMEOUT_MS
    const shell = process.platform === "win32" ? true : "/bin/sh"

    const child = spawn(command, [], {
      cwd,
      shell,
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
    })

    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (d: string) => (stdout += d))
    child.stderr.on("data", (d: string) => (stderr += d))

    // EPIPE on stdin must not crash the host process (fork commit 0f3017f33a)
    child.stdin.on("error", (err) => {
      log.warn("hook stdin error", { command, error: err.message })
    })

    try {
      child.stdin.write(stdinJSON + "\n", "utf8")
      child.stdin.end()
    } catch (err) {
      log.warn("hook stdin write failed", { command, error: String(err) })
    }

    child.on("error", (err) => {
      log.error("hook command failed to spawn", { command, error: err.message })
      resolve({ exitCode: null, stdout, stderr, spawnError: err.message })
    })

    child.on("close", (code) => resolve({ exitCode: code, stdout, stderr }))
  })
}

function parseStdout(stdout: string, command: string): HookJSONOutput | undefined {
  const trimmed = stdout.trim()
  if (!trimmed || !trimmed.startsWith("{")) {
    if (trimmed) log.info("hook returned plain text", { command, output: trimmed.slice(0, 200) })
    return undefined
  }
  try {
    return JSON.parse(trimmed) as HookJSONOutput
  } catch {
    log.warn("hook returned invalid JSON", { command, output: trimmed.slice(0, 200) })
    return undefined
  }
}

// ── Payload → stdin envelope ────────────────────────────────────

function buildStdinEnvelope(payload: HookPayload, ctx: TriggerContext, cwd: string): Record<string, unknown> {
  const base = {
    hook_event_name: payload.event,
    session_id: ctx.sessionID,
    transcript_path: ctx.transcriptPath,
    cwd,
  }
  switch (payload.event) {
    case "PreToolUse":
      return { ...base, tool_name: payload.toolName, tool_input: payload.toolInput }
    case "PostToolUse":
      return {
        ...base,
        tool_name: payload.toolName,
        tool_input: payload.toolInput,
        tool_response: payload.toolResponse,
      }
    case "UserPromptSubmit":
      return { ...base, prompt: payload.prompt }
    case "Stop":
    case "SubagentStop":
      return { ...base, stop_hook_active: payload.stopHookActive }
    case "Notification":
      return { ...base, message: payload.message }
    case "PreCompact":
      return {
        ...base,
        trigger: payload.trigger,
        custom_instructions: payload.customInstructions ?? "",
      }
    case "SessionStart":
      return { ...base, source: payload.source }
    case "SessionEnd":
      return { ...base, reason: payload.reason }
  }
}

/**
 * Decide which target string to feed the matcher for a given event.
 * Tool-bound events match against `tool_name`; others match all matchers
 * (CC behavior — non-tool events typically have empty matcher).
 */
function matcherTarget(payload: HookPayload): string {
  if (payload.event === "PreToolUse" || payload.event === "PostToolUse") {
    return payload.toolName
  }
  return ""
}

// ── Effect service ──────────────────────────────────────────────

interface State {
  settings: Settings
  cwd: string
  /** Deduplicated additionalContext strings already surfaced in this instance. */
  seen: Set<string>
}

export interface Interface {
  readonly trigger: (
    payload: HookPayload,
    ctx: TriggerContext,
  ) => Effect.Effect<TriggerResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SettingsHook") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const mcpSvc = yield* MCP.Service

    const state = yield* InstanceState.make(
      Effect.fn("SettingsHook.state")(function* (instCtx) {
        const settings = loadChain(instCtx.directory, instCtx.worktree)
        return { settings, cwd: instCtx.directory, seen: new Set<string>() } satisfies State
      }),
    )

    /**
     * Execute a single hook entry. Never throws. Returns the parsed JSON
     * output + a synthetic blocking signal for exit-code-2 protocol.
     */
    const runEntry = Effect.fn("SettingsHook.runEntry")(function* (
      entry: HookCommand,
      envelope: Record<string, unknown>,
      cwd: string,
      inHook: boolean,
    ) {
      const stdinJSON = JSON.stringify(envelope)

      if (entry.type === "mcp") {
        if (inHook) {
          log.warn("nested mcp hook skipped (re-entry guard)", { command: entry.command })
          return { json: undefined as HookJSONOutput | undefined, exitBlock: undefined as string | undefined }
        }
        const json = yield* invokeMcpHook(mcpSvc, entry.command, envelope)
        return { json, exitBlock: undefined as string | undefined }
      }

      const { exitCode, stdout, stderr, spawnError } = yield* Effect.promise(() =>
        execShell(entry.command, stdinJSON, cwd, entry.timeout),
      )

      if (spawnError) {
        return { json: undefined, exitBlock: undefined }
      }

      // Exit-code 2: block + stderr-as-reason (CC contract)
      if (exitCode === 2) {
        const reason = stderr.trim() || "Hook blocked execution"
        return { json: parseStdout(stdout, entry.command), exitBlock: reason }
      }

      // Other non-zero exits: log and continue (do not abort main flow)
      if (exitCode !== 0 && exitCode !== null) {
        log.warn("hook command exited non-zero (non-blocking)", {
          command: entry.command,
          exitCode,
          stderr: stderr.trim().slice(0, 200),
        })
      }

      return { json: parseStdout(stdout, entry.command), exitBlock: undefined }
    })

    const trigger = Effect.fn("SettingsHook.trigger")(function* (
      payload: HookPayload,
      ctx: TriggerContext,
    ) {
      const s = yield* InstanceState.get(state)
      const result: TriggerResult = { additionalContexts: [], systemMessages: [] }

      const matchers = s.settings.hooks?.[payload.event]
      if (!matchers?.length) return result

      const target = matcherTarget(payload)
      const envelope = buildStdinEnvelope(payload, ctx, s.cwd)

      for (const group of matchers) {
        if (!matches(group.matcher, target)) continue

        for (const entry of group.hooks) {
          if (entry.type !== "command" && entry.type !== "mcp") continue

          const { json, exitBlock } = yield* runEntry(entry, envelope, s.cwd, false)

          // Exit-code-2 block beats stdout decision
          if (exitBlock) {
            result.blocked = { reason: exitBlock, command: entry.command }
          }

          if (!json) continue

          if (json.decision === "block" && !result.blocked) {
            result.blocked = { reason: json.reason ?? "Blocked by hook", command: entry.command }
          }

          if (json.continue === false) {
            result.preventContinuation = true
            if (json.stopReason && !result.stopReason) result.stopReason = json.stopReason
          }

          if (json.systemMessage) result.systemMessages.push(json.systemMessage)

          const hso = json.hookSpecificOutput
          if (hso?.additionalContext && !s.seen.has(hso.additionalContext)) {
            s.seen.add(hso.additionalContext)
            result.additionalContexts.push(hso.additionalContext)
          }
          if (hso?.permissionDecision) {
            result.permissionDecision = hso.permissionDecision
            result.permissionDecisionReason = hso.permissionDecisionReason
          }
          if (hso?.updatedInput) {
            result.updatedInput = hso.updatedInput
          }
        }
      }

      return result
    })

    return Service.of({ trigger })
  }),
)

// defaultLayer provides MCP via MCP.defaultLayer; the shared memoMap in
// makeRuntime deduplicates instances across services that all depend on MCP.
export const defaultLayer = layer.pipe(Layer.provide(MCP.defaultLayer))

// ── type:"mcp" hook execution ───────────────────────────────────

/**
 * Resolve and invoke an MCP tool registered as a hook. Format:
 *   "mcp__<server>__<tool>"
 *
 * Calls MCP.Service.tools() to get the tool registry and invokes the matching
 * tool with the hook envelope as `arguments`. Parses the first text content
 * item as JSON to obtain the standard hook control output.
 */
function invokeMcpHook(
  mcpSvc: MCP.Interface,
  command: string,
  envelope: Record<string, unknown>,
) {
  return Effect.gen(function* () {
    if (!command.startsWith("mcp__")) {
      log.warn("mcp hook command must start with mcp__", { command })
      return undefined
    }

    const tools = yield* mcpSvc.tools()
    const tool = tools[command]
    if (!tool) {
      log.warn("mcp hook tool not found", { command, available: Object.keys(tools).length })
      return undefined
    }

    if (!tool.execute) {
      log.warn("mcp hook tool has no execute()", { command })
      return undefined
    }

    const result = yield* Effect.promise(() =>
      Promise.resolve(
        tool.execute!(envelope as never, {
          toolCallId: `hook-${Date.now()}`,
          messages: [],
          abortSignal: new AbortController().signal,
        } as never),
      ).catch((err) => {
        log.warn("mcp hook execution threw", { command, error: String(err) })
        return undefined
      }),
    )

    if (!result || typeof result !== "object" || !("content" in result)) return undefined

    const content = (result as { content: Array<{ type: string; text?: string }> }).content
    const firstText = content.find((c) => c.type === "text" && typeof c.text === "string")?.text
    if (!firstText) return undefined

    return parseStdout(firstText, command)
  })
}

export * as SettingsHook from "./settings"
