import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { SandboxStatusTool } from "../../src/tool/sandbox"
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

const base = Layer.mergeAll(Agent.defaultLayer, BackgroundJob.defaultLayer, Truncate.defaultLayer)

const layerWith = (flags: Parameters<typeof RuntimeFlags.layer>[0]) => Layer.mergeAll(base, RuntimeFlags.layer(flags))

const it = testEffect(layerWith({ experimentalSandbox: true }))
const itDisabled = testEffect(layerWith({ experimentalSandbox: false }))

const run = (args: Tool.InferParameters<typeof SandboxStatusTool>) =>
  Effect.gen(function* () {
    const tool = yield* SandboxStatusTool
    const def = yield* tool.init()
    return yield* def.execute(args, ctx)
  })

describe("sandbox.status", () => {
  itDisabled.instance("fails when the experimental flag is disabled", () =>
    Effect.gen(function* () {
      const exit = yield* run({ sandbox_id: "whatever" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("reports an error state when no background run exists", () =>
    Effect.gen(function* () {
      const result = yield* run({ sandbox_id: "ghost" })
      expect(result.metadata.state).toBe("error")
      expect(result.output).toContain("state: error")
      expect(result.output).toContain("No background run found")
      expect(result.output).toContain("<sandbox_error>")
    }),
  )

  it.instance("reports a completed run result when waiting", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      yield* jobs.start({
        id: "done-1",
        type: "sandbox",
        title: "sandbox done-1",
        run: Deferred.await(latch).pipe(Effect.as("sandbox-output")),
      })
      yield* Deferred.succeed(latch, undefined)

      const result = yield* run({ sandbox_id: "done-1", wait: true })
      expect(result.metadata.state).toBe("completed")
      expect(result.metadata.timed_out).toBe(false)
      expect(result.output).toContain("state: completed")
      expect(result.output).toContain("<sandbox_result>")
      expect(result.output).toContain("sandbox-output")
    }),
  )

  it.instance("reports timed_out when the run does not finish in time", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      yield* jobs.start({ id: "slow-1", type: "sandbox", run: Effect.never })

      const result = yield* run({ sandbox_id: "slow-1", wait: true, timeout_ms: 1 })
      expect(result.metadata.timed_out).toBe(true)
      expect(result.output).toContain("Timed out")
    }),
  )
})
