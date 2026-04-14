/**
 * Settings-based hook system — Claude Code compatible.
 *
 * Reads `.opencode/settings.json` and executes shell command hooks at
 * tool execution boundaries, injecting `additionalContext` into tool
 * output so the model sees it.
 *
 * Format is intentionally compatible with Claude Code's settings.json:
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
 * should print a JSON response to stdout. The `additionalContext` field
 * from `hookSpecificOutput` is appended to the tool result.
 */
import path from "path"
import { existsSync, readFileSync } from "fs"
import { spawn } from "child_process"
import { Log } from "@/util/log"
import { Effect, Layer, Context } from "effect"
import { InstanceState } from "@/effect/instance-state"

export namespace SettingsHook {
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

  /** Supported hook events */
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

    // Normalize tool name to lowercase for case-insensitive matching
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
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: timeoutMs,
      })

      let stdout = ""
      let stderr = ""

      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      child.stdout.on("data", (d: string) => (stdout += d))
      child.stderr.on("data", (d: string) => (stderr += d))

      // Write JSON input to stdin
      child.stdin.write(JSON.stringify(input) + "\n", "utf8")
      child.stdin.end()

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
          // Plain text output or empty — no JSON to parse
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
    // Search for settings.json in .opencode/ directories
    const candidates = [path.join(directory, ".opencode", "settings.json"), path.join(worktree, ".opencode", "settings.json")]

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

  type State = {
    settings: Settings
    cwd: string
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
      const state = yield* InstanceState.make<State>(
        Effect.fn("SettingsHook.state")(function* (ctx) {
          const settings = load(ctx.directory, ctx.worktree)
          return { settings, cwd: ctx.directory }
        }),
      )

      const trigger = Effect.fn("SettingsHook.trigger")(function* (event: HookEvent, tool: string, input: Record<string, unknown>) {
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
            }

            const { json, error } = yield* Effect.promise(() => exec(hook.command, hookInput, s.cwd, hook.timeout))

            if (error) {
              log.warn("hook execution error", { command: hook.command, error })
              continue
            }

            if (!json) continue

            // Handle blocking decision
            if (json.decision === "block") {
              result.blocked = {
                reason: json.reason || "Blocked by hook",
                command: hook.command,
              }
            }

            // Handle continue=false
            if (json.continue === false) {
              result.preventContinuation = true
            }

            // Extract additionalContext from hookSpecificOutput
            if (json.hookSpecificOutput?.additionalContext) {
              result.additionalContexts.push(json.hookSpecificOutput.additionalContext)
            }
          }
        }

        return result
      })

      return Service.of({ trigger })
    }),
  )
}
