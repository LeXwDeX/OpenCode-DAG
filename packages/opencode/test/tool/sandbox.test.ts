import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { existsSync } from "node:fs"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { LSP } from "@/lsp/lsp"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { SandboxTool } from "../../src/tool/sandbox"
import { SandboxManager } from "../../src/tool/sandbox/manager"
import { MessageID, SessionID } from "../../src/session/schema"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const lspMock = Layer.mock(LSP.Service, {
  touchFile: () => Effect.void,
  diagnostics: () => Effect.succeed({}),
})

const sandboxManager = SandboxManager.defaultLayer.pipe(Layer.provide(AppFileSystem.defaultLayer))

const base = Layer.mergeAll(
  Config.defaultLayer,
  Agent.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  AppFileSystem.defaultLayer,
  BackgroundJob.defaultLayer,
  Truncate.defaultLayer,
  lspMock,
  sandboxManager,
)

const layerWith = (flags: Parameters<typeof RuntimeFlags.layer>[0]) =>
  Layer.mergeAll(base, RuntimeFlags.layer(flags))

const it = testEffect(layerWith({ experimentalSandbox: true }))
const itDisabled = testEffect(layerWith({ experimentalSandbox: false }))

const initTool = Effect.fn("SandboxToolTest.init")(function* () {
  const tool = yield* SandboxTool
  return yield* tool.init()
})

const run = (args: Tool.InferParameters<typeof SandboxTool>, next: Tool.Context = ctx) =>
  Effect.gen(function* () {
    const tool = yield* initTool()
    return yield* tool.execute(args, next)
  })

const runExit = (args: Tool.InferParameters<typeof SandboxTool>, next: Tool.Context = ctx) =>
  run(args, next).pipe(Effect.exit)

describe("sandbox.tool", () => {
  itDisabled.instance("fails when the experimental flag is disabled", () =>
    Effect.gen(function* () {
      const exit = yield* runExit({ language: "bash", command: "echo hi" })
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(String(Cause.squash(exit.cause))).toContain("OPENCODE_EXPERIMENTAL_SANDBOX")
      }
    }),
  )

  it.instance("executes a command and captures stdout with the exit code", () =>
    Effect.gen(function* () {
      const result = yield* run({ language: "bash", command: "echo sandbox-hello", diagnostics: false })
      expect(result.output).toContain("sandbox-hello")
      expect(result.metadata.exit).toBe(0)
      expect(result.metadata.background).toBe(false)
    }),
  )

  it.instance("writes provided files into the workspace before running", () =>
    Effect.gen(function* () {
      const result = yield* run({
        language: "bash",
        command: "cat note.txt",
        files: { "note.txt": "file-body" },
        diagnostics: false,
      })
      expect(result.output).toContain("file-body")
      expect(result.metadata.exit).toBe(0)
    }),
  )

  it.instance("rejects file paths that escape the workspace", () =>
    Effect.gen(function* () {
      const exit = yield* runExit({
        language: "bash",
        command: "true",
        files: { "../escape.txt": "nope" },
        diagnostics: false,
      })
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(String(Cause.squash(exit.cause))).toContain("escapes sandbox workspace")
      }
    }),
  )

  it.instance("reuses a workspace across calls with the same sandbox_id", () =>
    Effect.gen(function* () {
      const manager = yield* SandboxManager.Service
      const first = yield* run({
        language: "bash",
        sandbox_id: "reuse-1",
        command: "echo one > state.txt",
        diagnostics: false,
      })
      expect(first.metadata.sandbox_id).toBe("reuse-1")

      const second = yield* run({
        language: "bash",
        sandbox_id: "reuse-1",
        command: "cat state.txt",
        diagnostics: false,
      })
      expect(second.output).toContain("one")
      expect((yield* manager.list()).length).toBe(1)
    }),
  )

  it.instance("bounds high-volume output in memory and spills the full log to a file", () =>
    Effect.gen(function* () {
      // Emit far more than the 50KB default cap so the rolling window + spill
      // path is exercised. The returned output must stay small (bounded tail +
      // truncation marker), not the full multi-hundred-KB stream.
      const result = yield* run({
        language: "bash",
        command: "for i in $(seq 1 20000); do echo \"line-$i-padding-padding-padding-padding\"; done",
        diagnostics: false,
      })
      expect(result.metadata.exit).toBe(0)
      expect(result.metadata.truncated).toBe(true)
      expect(typeof result.metadata.outputPath).toBe("string")
      expect(result.output).toContain("output truncated")
      expect(result.output).toContain("Full output saved to:")
      // Bounded: the preview must be a small fraction of the ~800KB produced.
      expect(result.output.length).toBeLessThan(200_000)
      // The spilled file holds the complete stream.
      expect(existsSync(result.metadata.outputPath as string)).toBe(true)
      const saved = yield* Effect.promise(() => Bun.file(result.metadata.outputPath as string).text())
      expect(saved).toContain("line-1-padding")
      expect(saved).toContain("line-20000-padding")
      expect(saved.length).toBeGreaterThan(result.output.length)
    }),
  )

  it.instance("destroys an ephemeral sandbox after the run", () =>
    Effect.gen(function* () {
      const manager = yield* SandboxManager.Service
      const result = yield* run({
        language: "bash",
        sandbox_id: "eph-1",
        command: "echo bye",
        ephemeral: true,
        diagnostics: false,
      })
      expect(result.metadata.ephemeral).toBe(true)
      expect(yield* manager.get("eph-1")).toBeUndefined()
      expect(existsSync(result.metadata.workspace)).toBe(false)
    }),
  )

  it.instance("starts a background run keyed by sandbox_id and completes it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const started = yield* run({
        language: "bash",
        sandbox_id: "bg-1",
        command: "echo bg-done",
        background: true,
        diagnostics: false,
      })
      expect(started.metadata.background).toBe(true)
      expect(started.metadata.exit).toBeNull()
      expect(started.output).toContain("sandbox_status")

      const done = yield* jobs.wait({ id: "bg-1", timeout: 10_000 })
      expect(done.timedOut).toBe(false)
      expect(done.info?.status).toBe("completed")
      expect(done.info?.output).toContain("bg-done")
    }),
  )

  it.instance("rejects a second background run while one is still in progress for the same sandbox_id", () =>
    Effect.gen(function* () {
      yield* run({
        language: "bash",
        sandbox_id: "bg-busy",
        command: "sleep 5",
        background: true,
        diagnostics: false,
      })

      const exit = yield* runExit({
        language: "bash",
        sandbox_id: "bg-busy",
        command: "echo second",
        background: true,
        diagnostics: false,
      })
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(String(Cause.squash(exit.cause))).toContain("already in progress")
      }
    }),
  )
})
