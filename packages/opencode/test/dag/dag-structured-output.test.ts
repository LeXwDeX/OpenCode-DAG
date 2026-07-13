import { describe, expect, it } from "bun:test"
import { Effect, Layer, Semaphore, Fiber } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import { Dag } from "@/dag/dag"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { spawnNode, type NodeSpawnInput } from "@/dag/runtime/spawn"
import { evaluateCondition, resolveInputMapping } from "@/dag/runtime/eval"
import { makeNodeRow } from "./fixtures"
import type { DagStore } from "@opencode-ai/core/dag/store"

type TrackedEvent = { type: string; nodeID: string; output?: unknown }

function makeEventTracker() {
  const events: TrackedEvent[] = []
  const dagLayer = Layer.mock(Dag.Service, {
    store: {} as DagStore.Interface,
    nodeStarted: Effect.fn("s")((dagID: string, nodeID: string) =>
      Effect.sync(() => events.push({ type: "nodeStarted", nodeID }))),
    nodeCompleted: Effect.fn("s")((dagID: string, nodeID: string, output: unknown) =>
      Effect.sync(() => events.push({ type: "nodeCompleted", nodeID, output }))),
    nodeFailed: Effect.fn("s")((dagID: string, nodeID: string, reason: string) =>
      Effect.sync(() => events.push({ type: "nodeFailed", nodeID }))),
    nodeSkipped: Effect.fn("s")((dagID: string, nodeID: string) =>
      Effect.sync(() => events.push({ type: "nodeSkipped", nodeID }))),
  })
  return { events, dagLayer }
}

const agentLayer = Layer.mock(Agent.Service, {
  get: () => Effect.succeed({
    name: "build", mode: "all", permission: [], options: {}, description: "", prompt: "",
    model: { providerID: "test" as never, modelID: "test-model" as never },
    tools: {}, hooks: {},
  }),
  list: () => Effect.succeed([]),
  defaultAgent: () => Effect.succeed("build"),
})

const sessionLayer = Layer.mock(Session.Service, {
  get: () => Effect.succeed({ id: "ses_parent" as never, permission: [], agent: "build" } as never),
  create: () => Effect.succeed({ id: "ses_child" as never } as never),
  list: () => Effect.succeed([]),
  messages: () => Effect.succeed([]),
})

function reply(text: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(), role: "assistant", parentID: MessageID.ascending(),
      sessionID: "ses_child" as never, mode: "build", agent: "build", cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model" as never, providerID: "test" as never,
      time: { created: Date.now() }, finish: "stop",
    },
    parts: text ? [{ type: "text", text }] as never : [],
  }
}

function makePromptLayer(result: SessionV1.WithParts): Layer.Layer<never> {
  return Layer.mock(SessionPrompt.Service, {
    prompt: () => Effect.succeed(result),
  })
}

function makeSpawnInput(outputSchema?: Record<string, unknown>): NodeSpawnInput {
  return {
    dagID: "wf-1", nodeID: "node-1", node: makeNodeRow(),
    parentSessionID: "ses_parent",
    promptParts: [{ type: "text", text: "do the thing" }],
    outputSchema,
  }
}

async function runSpawn(dagLayer: Layer.Layer<never>, promptLayer: Layer.Layer<never>, outputSchema?: Record<string, unknown>) {
  const semaphore = Semaphore.makeUnsafe(1)
  const fullLayer = Layer.mergeAll(dagLayer, agentLayer, sessionLayer, promptLayer)
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* spawnNode(semaphore, makeSpawnInput(outputSchema))
        yield* Fiber.await(result.fiber)
      }),
    ).pipe(Effect.provide(fullLayer)) as Effect.Effect<never>,
  )
}

// --- Unit tests for eval.ts ---

describe("evaluateCondition", () => {
  it("returns true for empty/undefined condition (fail-open)", () => {
    expect(evaluateCondition(undefined, {})).toBe(true)
    expect(evaluateCondition("", {})).toBe(true)
  })

  it("evaluates numeric comparison with structured output", () => {
    const outputs = { "explore": { output: { findings_count: 5 } } }
    expect(evaluateCondition("explore.output.findings_count > 0", outputs)).toBe(true)
    expect(evaluateCondition("explore.output.findings_count > 10", outputs)).toBe(false)
  })

  it("evaluates equality with structured output", () => {
    const outputs = { "check": { output: { status: "ok" } } }
    expect(evaluateCondition('check.output.status == "ok"', outputs)).toBe(true)
    expect(evaluateCondition('check.output.status == "fail"', outputs)).toBe(false)
  })

  it("returns false when path is missing (comparison with undefined)", () => {
    expect(evaluateCondition("missing.output.field > 0", {})).toBe(false)
  })
})

describe("resolveInputMapping", () => {
  it("resolves full output reference", () => {
    const getOutput = (id: string) => (id === "refactor" ? { diff: "abc" } : undefined)
    const result = resolveInputMapping({ diff: "refactor.output" }, getOutput)
    expect(result).toEqual({ diff: { diff: "abc" } })
  })

  it("resolves nested field from output", () => {
    const getOutput = (id: string) => (id === "plan" ? { steps: ["a", "b"] } : undefined)
    const result = resolveInputMapping({ steps: "plan.output.steps" }, getOutput)
    expect(result).toEqual({ steps: ["a", "b"] })
  })

  it("returns empty for undefined mapping", () => {
    expect(resolveInputMapping(undefined, () => null)).toEqual({})
  })

  it("resolves to null for missing node", () => {
    const result = resolveInputMapping({ x: "ghost.output" }, () => null)
    expect(result).toEqual({ x: null })
  })
})

// --- Integration tests for structured output ---

describe("spawnNode structured output", () => {
  it("parses JSON output when outputSchema is declared", async () => {
    const { events, dagLayer } = makeEventTracker()
    const jsonText = JSON.stringify({ tests_passed: 10, diff: "abc" })
    await runSpawn(dagLayer, makePromptLayer(reply(jsonText)), { type: "object" })

    const completed = events.find((e) => e.type === "nodeCompleted")
    expect(completed).toBeDefined()
    expect(completed!.output).toEqual({ tests_passed: 10, diff: "abc" })
  })

  it("falls back to text when JSON is malformed", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply("not valid json")), { type: "object" })

    const completed = events.find((e) => e.type === "nodeCompleted")
    expect(completed).toBeDefined()
    expect(completed!.output).toBe("not valid json")
  })

  it("stores plain text when no outputSchema declared", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptLayer(reply("Task completed")))

    const completed = events.find((e) => e.type === "nodeCompleted")
    expect(completed).toBeDefined()
    expect(completed!.output).toBe("Task completed")
  })
})
