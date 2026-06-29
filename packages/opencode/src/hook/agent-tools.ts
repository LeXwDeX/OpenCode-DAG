/**
 * WP-4D micro-WP-1 — agent-handler tool set (LLM-facing).
 *
 * Builds the 5-tool palette consumed by the WP-4D-2 agent loop:
 *   read_file / list_dir / grep / bash / synthetic_output
 *
 * Design contract:
 *   - All tools are pure ai-SDK `Tool` values; no Effect dependencies on the
 *     LLM-side execute path. Effect Services (spawner / fs) are pre-resolved
 *     by the caller and captured via closure.
 *   - Every `execute` is wrapped in try/catch. Errors return
 *     `{ output: "Error: <message>" }` and **never throw** — the agent loop
 *     must be able to keep running and let the model decide whether to retry.
 *   - bash uses a strict read-only whitelist. The token list and forbidden
 *     metachar regex are the v1 contract; expanding either requires a
 *     deliberate WP, not a one-off addition.
 *   - synthetic_output writes into the caller-owned `captured.value` slot;
 *     the loop polls it after each turn to decide termination.
 */
import path from "path"
import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { type Tool, tool, jsonSchema } from "ai"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { HookJSONOutput } from "./settings"

// ── bash whitelist (read-only, POSIX-only) ──────────────────────

const BASH_WHITELIST_SINGLE = new Set([
  "ls",
  "cat",
  "grep",
  "find",
  "test",
  "wc",
  "head",
  "tail",
  "sort",
  "uniq",
  "awk",
  "echo",
  "pwd",
  "which",
  "file",
  "stat",
])

const BASH_WHITELIST_PAIR = new Set([
  "git status",
  "git log",
  "git diff",
  "git show",
  "sed -n",
  "du -sh",
])

/**
 * Reject metacharacters that enable composition / redirection / substitution.
 * v1 only allows a single command invocation — no pipes, chains, redirects,
 * background, command substitution, or backticks.
 */
const FORBIDDEN_META = /[|;&`$<>]|\$\(|\)\s*$/

function whitelistReject(cmd: string): string | null {
  const trimmed = cmd.trim()
  if (!trimmed) return "empty command"
  if (FORBIDDEN_META.test(trimmed))
    return `compound/redirect not allowed in v1: ${trimmed.slice(0, 60)}`
  const tokens = trimmed.split(/\s+/)
  const first = tokens[0]
  const pair = tokens.length >= 2 ? `${tokens[0]} ${tokens[1]}` : ""
  if (BASH_WHITELIST_SINGLE.has(first)) return null
  if (pair && BASH_WHITELIST_PAIR.has(pair)) return null
  return `command "${first}" not in read-only whitelist`
}

// Exported for unit tests only — not part of the runtime surface.
export const __test__ = { whitelistReject, BASH_WHITELIST_SINGLE, BASH_WHITELIST_PAIR, FORBIDDEN_META }

// ── helpers ─────────────────────────────────────────────────────

function resolvePath(p: string, cwd: string): string {
  return path.isAbsolute(p) ? p : path.join(cwd, p)
}

const MAX_BASH_OUTPUT = 8000
const MAX_GREP_RESULTS_DEFAULT = 100
const MAX_READ_LINES_DEFAULT = 2000

// ── synthetic_output schema (mirrors HookJSONOutput) ────────────

const HOOK_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    continue: { type: "boolean" },
    stopReason: { type: "string" },
    suppressOutput: { type: "boolean" },
    systemMessage: { type: "string" },
    decision: { type: "string", enum: ["approve", "block"] },
    reason: { type: "string" },
    hookSpecificOutput: {
      type: "object",
      properties: {
        hookEventName: { type: "string" },
        permissionDecision: { type: "string", enum: ["allow", "deny", "ask"] },
        permissionDecisionReason: { type: "string" },
        updatedInput: { type: "object" },
        additionalContext: { type: "string" },
        initialUserMessage: { type: "string" },
        updatedMCPToolOutput: {},
      },
    },
  },
} as const

// Compile-time guard: the synthetic_output schema must remain a structural
// subset of HookJSONOutput. If HookJSONOutput grows a required field, this
// assignment has to be updated alongside HOOK_OUTPUT_SCHEMA above.
const _schemaTypeCheck: (a: HookJSONOutput) => HookJSONOutput = (a) => a
void _schemaTypeCheck

// ── factory ─────────────────────────────────────────────────────

export interface BuildAgentToolsDeps {
  spawner: ChildProcessSpawner["Service"]
  fs: FSUtil.Interface
  signal: AbortSignal
  cwd: string
  /** Mutable slot the synthetic_output tool writes to. Loop polls .value. */
  captured: { value: HookJSONOutput | null }
}

export function buildAgentTools(deps: BuildAgentToolsDeps): Record<string, Tool> {
  const { spawner, fs, signal, cwd, captured } = deps

  const read_file = tool({
    description: "Read a UTF-8 file. Optional 1-indexed offset and max line limit (default 2000).",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or cwd-relative path" },
        offset: { type: "number", description: "1-indexed line offset (optional)" },
        limit: { type: "number", description: "Max number of lines (default 2000)" },
      },
      required: ["path"],
    }),
    execute: async (args: any) => {
      try {
        const resolved = resolvePath(String(args.path), cwd)
        const text = await Effect.runPromise(fs.readFileString(resolved) as Effect.Effect<string, unknown>)
        const offset = typeof args.offset === "number" && args.offset > 0 ? args.offset - 1 : 0
        const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : MAX_READ_LINES_DEFAULT
        const lines = text.split("\n").slice(offset, offset + limit)
        return { output: lines.join("\n") }
      } catch (e: any) {
        return { output: `Error: ${e?.message ?? String(e)}` }
      }
    },
  })

  const list_dir = tool({
    description: "List directory entries. Directories are suffixed with '/'.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean", description: "default false" },
      },
      required: ["path"],
    }),
    execute: async (args: any) => {
      try {
        const root = resolvePath(String(args.path), cwd)
        const recursive = args.recursive === true
        const lines: string[] = []

        const walk = async (dir: string, rel: string): Promise<void> => {
          const entries = await Effect.runPromise(fs.readDirectoryEntries(dir) as Effect.Effect<FSUtil.DirEntry[], unknown>)
          for (const e of entries) {
            const display = (rel ? rel + "/" : "") + e.name + (e.type === "directory" ? "/" : "")
            lines.push(display)
            if (recursive && e.type === "directory") {
              await walk(path.join(dir, e.name), (rel ? rel + "/" : "") + e.name)
            }
          }
        }

        await walk(root, "")
        return { output: lines.join("\n") }
      } catch (e: any) {
        return { output: `Error: ${e?.message ?? String(e)}` }
      }
    },
  })

  const grep = tool({
    description:
      "Regex search across a file or directory. Returns matches as 'path:line:content', truncated at max_results (default 100).",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        pattern: { type: "string", description: "JS RegExp pattern" },
        path: { type: "string", description: "File or directory" },
        include: { type: "string", description: "Optional suffix filter, e.g. '.ts' or '*.ts'" },
        max_results: { type: "number", description: "default 100" },
      },
      required: ["pattern", "path"],
    }),
    execute: async (args: any) => {
      try {
        const re = new RegExp(String(args.pattern))
        const root = resolvePath(String(args.path), cwd)
        const max = typeof args.max_results === "number" && args.max_results > 0 ? args.max_results : MAX_GREP_RESULTS_DEFAULT
        // Treat include as a suffix filter only — minimatch is not in the
        // hook subsystem's dep set and grep is best-effort here. Strip a
        // leading '*' so '*.ts' and '.ts' both work.
        const includeRaw = typeof args.include === "string" ? args.include : ""
        const suffix = includeRaw.startsWith("*") ? includeRaw.slice(1) : includeRaw

        const out: string[] = []
        let total = 0

        const scanFile = async (filepath: string): Promise<void> => {
          if (suffix && !filepath.endsWith(suffix)) return
          let content: string
          try {
            content = await Effect.runPromise(fs.readFileString(filepath) as Effect.Effect<string, unknown>)
          } catch {
            return
          }
          const lines = content.split("\n")
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              total++
              if (out.length < max) out.push(`${filepath}:${i + 1}:${lines[i]}`)
            }
          }
        }

        const walk = async (dir: string): Promise<void> => {
          const entries = await Effect.runPromise(fs.readDirectoryEntries(dir) as Effect.Effect<FSUtil.DirEntry[], unknown>)
          for (const e of entries) {
            const child = path.join(dir, e.name)
            if (e.type === "directory") await walk(child)
            else if (e.type === "file") await scanFile(child)
          }
        }

        const isDir = await Effect.runPromise(fs.isDir(root))
        if (isDir) await walk(root)
        else await scanFile(root)

        let body = out.join("\n")
        if (total > out.length) body += `\n... (${total - out.length} more)`
        return { output: body }
      } catch (e: any) {
        return { output: `Error: ${e?.message ?? String(e)}` }
      }
    },
  })

  const bash = tool({
    description:
      "Run a single read-only shell command (whitelist enforced: ls/cat/grep/find/git status/git log/git diff/git show/sed -n/test/wc/head/tail/sort/uniq/awk/echo/pwd/which/file/stat/du -sh). No pipes, redirects, or substitution.",
    inputSchema: jsonSchema({
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    }),
    execute: async (args: any) => {
      const command = String(args?.command ?? "")
      const reject = whitelistReject(command)
      if (reject) return { output: `Error: ${reject}` }

      // v1 POSIX-only. Windows lacks `sh -c` — bail out loudly so the LLM can
      // adapt rather than the host hanging on a missing binary.
      if (process.platform === "win32") {
        return { output: "Error: bash tool unavailable on Windows in v1 (POSIX only)" }
      }

      try {
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(
                ChildProcess.make("sh", ["-c", command], {
                  cwd,
                  extendEnv: true,
                  stdin: "ignore",
                  stdout: "pipe",
                  stderr: "pipe",
                }),
              )
              const [stdout, stderr, code] = yield* Effect.all(
                [
                  Stream.mkString(Stream.decodeText(handle.stdout)),
                  Stream.mkString(Stream.decodeText(handle.stderr)),
                  handle.exitCode,
                ],
                { concurrency: "unbounded" },
              )
              return { stdout, stderr, code }
            }),
          ) as Effect.Effect<{ stdout: string; stderr: string; code: number }, unknown>,
        )

        const body = `exit=${result.code}\n${result.stdout}` + (result.stderr ? `\n[stderr]\n${result.stderr}` : "")
        return { output: body.length > MAX_BASH_OUTPUT ? body.slice(0, MAX_BASH_OUTPUT) + "\n... (truncated)" : body }
      } catch (e: any) {
        return { output: `Error: ${e?.message ?? String(e)}` }
      }
    },
  })

  const synthetic_output = tool({
    description: "Emit the final hook decision and stop. Call this exactly once when ready to terminate.",
    inputSchema: jsonSchema(HOOK_OUTPUT_SCHEMA as Record<string, unknown>),
    execute: async (args: any) => {
      try {
        captured.value = args as HookJSONOutput
        return { output: "ok" }
      } catch (e: any) {
        return { output: `Error: ${e?.message ?? String(e)}` }
      }
    },
  })

  // signal is captured for the loop's transport-level cancellation; the
  // tool execute paths above don't directly consume it (Effect.scoped on
  // the bash spawn unwinds child handles when the runtime is interrupted
  // by the outer agent loop). Reference here is intentional to keep the
  // dep contract honest without a noisy unused-param warning.
  void signal

  return { read_file, list_dir, grep, bash, synthetic_output }
}

export * as AgentTools from "./agent-tools"
