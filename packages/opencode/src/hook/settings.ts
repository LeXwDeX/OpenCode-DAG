/**
 * Settings-based hook system — Claude Code compatible (Phase 3 Step 1).
 *
 * Reads `.opencode/settings.json` and executes shell command hooks at
 * tool execution boundaries. Step 1 supports the two highest-value events
 * (PreToolUse / PostToolUse) and `type: "command"`. Step 2 will extend to
 * the full 9-event Claude Code surface, `type: "mcp"` hooks, and the
 * three-layer `.claude/settings.json` loader.
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         {
 *           "matcher": "Glob|Grep",
 *           "hooks": [{ "type": "command", "command": "..." }]
 *         }
 *       ],
 *       "PostToolUse": [ ... ]
 *     }
 *   }
 *
 * Hook commands receive a JSON object on stdin with tool context and
 * may print a JSON response to stdout. The `additionalContext` field
 * from `hookSpecificOutput` is appended to the tool result.
 */
import path from "path"
import { existsSync, readFileSync } from "fs"
import { spawn } from "child_process"
import { Effect, Layer, Context } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { InstanceState } from "@/effect/instance-state"

const log = Log.create({ service: "hook.settings" })

// ── Types (Claude Code compatible) ──────────────────────────────

/** A single hook command entry */
interface HookCommand {
  type: "command"
  command: string
  timeout?: number
}

/** A matcher group: tool name pattern → list of hooks */
interface HookMatcher {
  matcher?: string
  hooks: HookCommand[]
}

/** The full settings.json shape */
interface Settings {
  hooks?: Partial<Record<HookEvent, HookMatcher[]>>
}

/** Supported hook events (Step 1 scope) */
type HookEvent = "PreToolUse" | "PostToolUse"

/** JSON output from a hook command (subset we care about) */
interface HookJSONOutput {
  continue?: boolean
  decision?: "approve" | "block"
  reason?: string
  hookSpecificOutput?: {
    hookEventName?: string
    additionalContext?: string
    permissionDecision?: "allow" | "deny" | "ask"
    permissionDecisionReason?: string
    updatedInput?: Record<string, unknown>
  }
}

/** Result after processing all matched hooks for one event */
export interface TriggerResult {
  additionalContexts: string[]
  blocked?: { reason: string; command: string }
  preventContinuation?: boolean
}

// ── Matcher logic (compatible with Claude Code) ─────────────────

/**
 * Check if a tool name matches a hook matcher pattern.
 * Supports:
 * - Simple exact match: "Glob"
 * - Pipe-separated list: "Glob|Grep"
 * - Regex pattern: "^(Read|Glob)$"
 * - Wildcard: "*" or empty string (matches all)
 */
function matches(matcher: string | undefined, tool: string): boolean {
  if (!matcher || matcher === "*") return true

  const normalized = tool.toLowerCase()

  // Simple string or pipe-separated list (no regex special chars except |)
  if (/^[a-zA-Z0-9_|]+$/.test(matcher)) {
    if (matcher.includes("|")) {
      return matcher
        .split("|")
        .map((p) => p.trim().toLowerCase())
        .includes(normalized)
    }
    return normalized === matcher.toLowerCase()
  }

  // Regex
  try {
    const regex = new RegExp(matcher, "i")
    return regex.test(tool)
  } catch {
    log.warn("invalid regex in hook matcher", { matcher })
    return false
  }
}

// ── Shell execution ────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Execute a hook command in a shell, pipe JSON input via stdin,
 * parse stdout for JSON response.
 *
 * Never rejects: returns `{ error }` on spawn failure / non-zero exit so the
 * caller can keep main-flow execution unaffected (mirrors fork commit
 * 0f3017f33a — hook crashes must not kill the session).
 */
function exec(
  command: string,
  input: Record<string, unknown>,
  cwd: string,
  timeout?: number,
): Promise<{ json?: HookJSONOutput; error?: string }> {
  return new Promise((resolve) => {
    const timeoutMs = timeout ? timeout * 1000 : DEFAULT_TIMEOUT_MS
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

    // Prevent EPIPE on stdin from becoming an uncaughtException that kills the process
    child.stdin.on("error", (err) => {
      log.warn("hook stdin error", { command, error: err.message })
    })

    // Write JSON input to stdin
    try {
      child.stdin.write(JSON.stringify(input) + "\n", "utf8")
      child.stdin.end()
    } catch (err) {
      log.warn("hook stdin write failed", { command, error: String(err) })
    }

    child.on("error", (err) => {
      log.error("hook command failed to spawn", { command, error: err.message })
      resolve({ error: err.message })
    })

    child.on("close", (code) => {
      if (code !== 0 && code !== null) {
        log.warn("hook command exited with non-zero code", { command, code, stderr: stderr.trim() })
      }

      const trimmed = stdout.trim()
      if (!trimmed || !trimmed.startsWith("{")) {
        if (trimmed) {
          log.info("hook returned plain text", { command, output: trimmed.slice(0, 200) })
        }
        resolve({})
        return
      }

      try {
        const json = JSON.parse(trimmed) as HookJSONOutput
        resolve({ json })
      } catch {
        log.warn("hook returned invalid JSON", { command, output: trimmed.slice(0, 200) })
        resolve({})
      }
    })
  })
}

// ── Settings loading ───────────────────────────────────────────

function load(directory: string, worktree: string): Settings {
  const candidates = [
    path.join(directory, ".opencode", "settings.json"),
    path.join(worktree, ".opencode", "settings.json"),
  ]

  for (const filepath of candidates) {
    if (!existsSync(filepath)) continue
    try {
      const text = readFileSync(filepath, "utf8")
      const data = JSON.parse(text)
      log.info("loaded settings hooks", { path: filepath, events: Object.keys(data.hooks ?? {}) })
      return data as Settings
    } catch (err) {
      log.error("failed to parse settings.json", { path: filepath, error: String(err) })
    }
  }

  return {}
}

// ── Effect service ─────────────────────────────────────────────

interface State {
  settings: Settings
  cwd: string
  seen: Set<string>
}

export interface Interface {
  readonly trigger: (
    event: HookEvent,
    tool: string,
    input: Record<string, unknown>,
  ) => Effect.Effect<TriggerResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SettingsHook") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make(
      Effect.fn("SettingsHook.state")(function* (ctx) {
        const settings = load(ctx.directory, ctx.worktree)
        return { settings, cwd: ctx.directory, seen: new Set<string>() } satisfies State
      }),
    )

    const trigger = Effect.fn("SettingsHook.trigger")(function* (
      event: HookEvent,
      tool: string,
      input: Record<string, unknown>,
    ) {
      const s = yield* InstanceState.get(state)
      const result: TriggerResult = { additionalContexts: [] }

      const matchers = s.settings.hooks?.[event]
      if (!matchers?.length) return result

      for (const group of matchers) {
        if (!matches(group.matcher, tool)) continue

        for (const hook of group.hooks) {
          if (hook.type !== "command") continue

          const hookInput = {
            hook_event_name: event,
            tool_name: tool,
            tool_input: input,
            cwd: s.cwd,
          }

          const { json, error } = yield* Effect.promise(() => exec(hook.command, hookInput, s.cwd, hook.timeout))

          if (error) {
            log.warn("hook execution error", { command: hook.command, error })
            continue
          }

          if (!json) continue

          if (json.decision === "block") {
            result.blocked = {
              reason: json.reason || "Blocked by hook",
              command: hook.command,
            }
          }

          if (json.continue === false) {
            result.preventContinuation = true
          }

          if (json.hookSpecificOutput?.additionalContext) {
            const ctx = json.hookSpecificOutput.additionalContext
            if (!s.seen.has(ctx)) {
              s.seen.add(ctx)
              result.additionalContexts.push(ctx)
            }
          }
        }
      }

      return result
    })

    return Service.of({ trigger })
  }),
)

export const defaultLayer = layer

export * as SettingsHook from "./settings"
