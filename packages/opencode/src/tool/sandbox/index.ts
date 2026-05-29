import { Effect, Fiber, Schema, Stream } from "effect"
import path from "path"
import { pathToFileURL } from "url"
import { createWriteStream } from "node:fs"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { PositiveInt } from "@opencode-ai/core/schema"
import * as Tool from "../tool"
import * as Truncate from "../truncate"
import { SandboxID } from "./id"
import { SandboxPrompt, type Parameters } from "./prompt"
import { SandboxManager } from "./manager"
import { Config } from "@/config/config"
import { Shell } from "@/shell/shell"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LSP } from "@/lsp/lsp"
import { Diagnostic } from "@/lsp/diagnostic"
import { BackgroundJob } from "@/background/job"
import STATUS_DESCRIPTION from "./sandbox_status.txt"

const MAX_DIAGNOSTICS_PER_FILE = 20
const STATUS_DEFAULT_TIMEOUT = 60_000

type Chunk = {
  text: string
  size: number
}

type ExecResult = {
  output: string
  code: number | null
  expired: boolean
  aborted: boolean
  truncated: boolean
  outputPath?: string
}

// Bound the captured output to the configured tail window, mirroring shell.ts.
// Keeps the most recent `maxLines`/`maxBytes` so an over-cap command's preview
// stays small even though the full log was spilled to a file.
function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return { text, cut: false }
  }
  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return { text: out.join("\n"), cut: true }
}

function makeProc(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }
  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}

export const SandboxTool = Tool.define(
  SandboxID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* AppFileSystem.Service
    const flags = yield* RuntimeFlags.Service
    const lsp = yield* LSP.Service
    const manager = yield* SandboxManager.Service
    const jobs = yield* BackgroundJob.Service
    const trunc = yield* Truncate.Service
    const defaultTimeout = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000

    // Run one command inside a workspace, capturing combined stdout+stderr.
    // `signal` is wired only for foreground runs; background runs rely on Effect
    // interruption (scope close kills the child) so they outlive the tool call.
    //
    // Output is bounded exactly like shell.ts: an in-memory rolling window keeps
    // only the most recent ~maxBytes*2, and once the running total crosses the
    // limit the full log is spilled to a Truncate file via a streaming sink. A
    // high-output command (verbose build, `yes`, log floods) therefore cannot
    // grow host memory without bound — critical because the model may fan out
    // many concurrent sandbox workers.
    const exec = Effect.fn("SandboxTool.exec")(function* (input: {
      shell: string
      command: string
      cwd: string
      env: NodeJS.ProcessEnv
      timeout: number
      signal?: AbortSignal
    }) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      const list: Chunk[] = []
      let used = 0
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(closeSink)
          const handle = yield* spawner.spawn(makeProc(input.shell, input.command, input.cwd, input.env))

          const reader = yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              const size = Buffer.byteLength(chunk, "utf-8")
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                cut = true
              }

              if (file) {
                sink?.write(chunk)
                return Effect.void
              }
              full += chunk
              if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                return trunc.write(full).pipe(
                  Effect.andThen((next) =>
                    Effect.sync(() => {
                      file = next
                      cut = true
                      sink = createWriteStream(next, { flags: "a" })
                      full = ""
                    }),
                  ),
                )
              }
              return Effect.void
            }),
          )

          const races: Effect.Effect<{ kind: "exit" | "timeout" | "abort"; code: number | null }, unknown>[] = [
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            Effect.sleep(`${input.timeout + 100} millis`).pipe(
              Effect.map(() => ({ kind: "timeout" as const, code: null })),
            ),
          ]
          if (input.signal) {
            const signal = input.signal
            const abort = Effect.callback<void>((resume) => {
              if (signal.aborted) return resume(Effect.void)
              const handler = () => resume(Effect.void)
              signal.addEventListener("abort", handler, { once: true })
              return Effect.sync(() => signal.removeEventListener("abort", handler))
            })
            races.push(abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))))
          }

          const exit = yield* Effect.raceAll(races)

          if (exit.kind === "abort") {
            aborted = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (exit.kind === "exit") {
            yield* Fiber.await(reader)
          } else {
            yield* Fiber.await(reader).pipe(
              Effect.timeout("2 seconds"),
              Effect.catch(() => Fiber.interrupt(reader)),
            )
          }

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      const raw = list.map((item) => item.text).join("")
      const end = tail(raw, limits.maxLines, limits.maxBytes)
      if (end.cut) cut = true
      if (!file && end.cut) file = yield* trunc.write(raw)

      let output = end.text
      if (cut && file) output = `...output truncated...\nFull output saved to: ${file}\n\n` + output

      return {
        output,
        code,
        expired,
        aborted,
        truncated: cut,
        ...(cut && file ? { outputPath: file } : {}),
      } satisfies ExecResult
    })

    // Write LLM-authored files into the workspace, rejecting any path that would
    // escape the sandbox. Returns the absolute paths that were written.
    const writeFiles = Effect.fn("SandboxTool.writeFiles")(function* (workspace: string, files: Record<string, string>) {
      const written: string[] = []
      for (const [rel, content] of Object.entries(files)) {
        const abs = path.resolve(workspace, rel)
        if (abs !== workspace && !abs.startsWith(workspace + path.sep)) {
          return yield* Effect.fail(new Error(`File path escapes sandbox workspace: ${rel}`))
        }
        yield* fs.writeWithDirs(abs, content).pipe(Effect.orDie)
        written.push(abs)
      }
      return written
    })

    const collectDiagnostics = Effect.fn("SandboxTool.diagnostics")(function* (workspace: string, written: string[]) {
      if (written.length === 0) return ""
      yield* Effect.forEach(written, (file) => lsp.touchFile(file, "full").pipe(Effect.ignore), {
        concurrency: "unbounded",
      })
      const all = yield* lsp.diagnostics().pipe(Effect.catch(() => Effect.succeed({} as Record<string, any[]>)))
      const blocks: string[] = []
      for (const file of written) {
        const diags = all[file] ?? all[pathToFileURL(file).href] ?? []
        if (diags.length === 0) continue
        const limited = diags.slice(0, MAX_DIAGNOSTICS_PER_FILE)
        const more = diags.length - limited.length
        const suffix = more > 0 ? `\n... and ${more} more` : ""
        blocks.push(
          `<diagnostics file="${path.relative(workspace, file)}">\n` +
            limited.map(Diagnostic.pretty).join("\n") +
            `${suffix}\n</diagnostics>`,
        )
      }
      if (blocks.length === 0) return ""
      return "\n\n<lsp_diagnostics>\n" + blocks.join("\n") + "\n</lsp_diagnostics>"
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)

        return {
          description: SandboxPrompt.description,
          parameters: SandboxPrompt.Parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              if (!flags.experimentalSandbox) {
                return yield* Effect.fail(new Error("sandbox requires OPENCODE_EXPERIMENTAL_SANDBOX=true"))
              }

              yield* ctx.ask({
                permission: SandboxID.Permission,
                patterns: [params.language, params.command],
                always: [`${params.language} *`],
                metadata: {
                  language: params.language,
                  command: params.command,
                  ...(params.setup ? { setup: params.setup } : {}),
                  ...(params.sandbox_id ? { sandbox_id: params.sandbox_id } : {}),
                },
              })

              const sb = yield* manager.ensure({ id: params.sandbox_id, language: params.language })
              const env = { ...process.env }
              const timeout = params.timeout ?? defaultTimeout
              const background = params.background === true

              const compute = Effect.gen(function* () {
                const written = params.files ? yield* writeFiles(sb.workspace, params.files) : []

                let setupOut = ""
                if (params.setup && !sb.initialized) {
                  const r = yield* exec({
                    shell,
                    command: params.setup,
                    cwd: sb.workspace,
                    env,
                    timeout,
                    signal: background ? undefined : ctx.abort,
                  })
                  setupOut = `<setup exit="${r.code}">\n${r.output || "(no output)"}\n</setup>\n\n`
                  if (r.code === 0) yield* manager.markInitialized(sb.id)
                }

                const result = yield* exec({
                  shell,
                  command: params.command,
                  cwd: sb.workspace,
                  env,
                  timeout,
                  signal: background ? undefined : ctx.abort,
                })

                const diag =
                  params.diagnostics === false ? "" : yield* collectDiagnostics(sb.workspace, written)

                yield* manager.touch(sb.id)
                if (params.ephemeral) yield* manager.destroy(sb.id)

                const meta: string[] = []
                if (result.expired)
                  meta.push(
                    `sandbox terminated command after exceeding timeout ${timeout} ms. Retry with a larger timeout if the command legitimately needs longer.`,
                  )
                if (result.aborted) meta.push("User aborted the command")

                const head = `sandbox_id: ${sb.id}\nworkspace: ${sb.workspace}\nexit: ${result.code}\n\n`
                const body = setupOut + (result.output || "(no output)") + diag
                const tail = meta.length > 0 ? "\n\n<sandbox_metadata>\n" + meta.join("\n") + "\n</sandbox_metadata>" : ""

                return {
                  title: `sandbox ${sb.id} (${params.language})`,
                  metadata: {
                    sandbox_id: sb.id,
                    workspace: sb.workspace,
                    language: params.language as string,
                    exit: result.code,
                    expired: result.expired,
                    aborted: result.aborted,
                    ephemeral: params.ephemeral === true,
                    background: false,
                    truncated: result.truncated,
                    outputPath: result.outputPath as string | undefined,
                  },
                  output: head + body + tail,
                }
              })

              if (background) {
                // Background runs key the job by sandbox_id so sandbox_status can
                // poll by that id. BackgroundJob.start silently aliases an
                // already-running job with the same id, so reject up front instead
                // of falsely reporting that a new run started.
                const running = yield* jobs.get(sb.id)
                if (running && running.status === "running") {
                  return yield* Effect.fail(
                    new Error(
                      `A background run is already in progress for sandbox ${sb.id}. Wait for it with sandbox_status(sandbox_id="${sb.id}", wait=true) before starting another, or use a different sandbox_id.`,
                    ),
                  )
                }
                yield* jobs.start({
                  id: sb.id,
                  type: "sandbox",
                  title: `sandbox ${sb.id} (${params.language})`,
                  metadata: { sandbox_id: sb.id, workspace: sb.workspace, language: params.language },
                  run: compute.pipe(Effect.map((r) => r.output)),
                })
                return {
                  title: `sandbox ${sb.id} (${params.language})`,
                  metadata: {
                    sandbox_id: sb.id,
                    workspace: sb.workspace,
                    language: params.language as string,
                    exit: null as number | null,
                    expired: false as boolean,
                    aborted: false as boolean,
                    ephemeral: false,
                    background: true,
                    truncated: false as boolean,
                    outputPath: undefined as string | undefined,
                  },
                  output: `Started background run in sandbox ${sb.id}.\nPoll completion with sandbox_status(sandbox_id="${sb.id}", wait=true).`,
                }
              }

              return yield* compute
            }).pipe(Effect.orDie),
        }
      })
  }),
)

const StatusParameters = Schema.Struct({
  sandbox_id: Schema.String.annotate({ description: "The sandbox_id returned by the sandbox tool" }),
  wait: Schema.optional(Schema.Boolean).annotate({
    description: "When true, wait until the background run reaches a terminal state or timeout",
  }),
  timeout_ms: Schema.optional(PositiveInt).annotate({
    description: "Maximum milliseconds to wait when wait=true (default: 60000)",
  }),
})

function formatStatus(input: { id: string; state: BackgroundJob.Status; text: string }) {
  const tag = input.state === "completed" || input.state === "running" ? "sandbox_result" : "sandbox_error"
  return [`sandbox_id: ${input.id}`, `state: ${input.state}`, "", `<${tag}>`, input.text, `</${tag}>`].join("\n")
}

export const SandboxStatusTool = Tool.define(
  SandboxID.StatusToolID,
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    const flags = yield* RuntimeFlags.Service

    return {
      description: STATUS_DESCRIPTION,
      parameters: StatusParameters,
      execute: (params: Schema.Schema.Type<typeof StatusParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!flags.experimentalSandbox) {
            return yield* Effect.fail(new Error("sandbox_status requires OPENCODE_EXPERIMENTAL_SANDBOX=true"))
          }

          const waited =
            params.wait === true
              ? yield* jobs.wait({ id: params.sandbox_id, timeout: params.timeout_ms ?? STATUS_DEFAULT_TIMEOUT })
              : { info: yield* jobs.get(params.sandbox_id), timedOut: false }

          if (!waited.info) {
            return {
              title: "Sandbox status",
              metadata: { sandbox_id: params.sandbox_id, state: "error" as const, timed_out: false },
              output: formatStatus({
                id: params.sandbox_id,
                state: "error",
                text: `No background run found for sandbox ${params.sandbox_id}. It may have finished synchronously or never been started with background=true.`,
              }),
            }
          }

          const info = waited.info
          const text = waited.timedOut
            ? `Timed out after ${params.timeout_ms ?? STATUS_DEFAULT_TIMEOUT}ms while waiting for the sandbox run.`
            : (info.output ??
              info.error ??
              (info.status === "running" ? "Sandbox run is still in progress." : "(no output)"))

          return {
            title: "Sandbox status",
            metadata: { sandbox_id: params.sandbox_id, state: info.status, timed_out: waited.timedOut },
            output: formatStatus({ id: params.sandbox_id, state: info.status, text }),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
