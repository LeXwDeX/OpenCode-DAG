import { describe, expect, it } from "bun:test"
import { Effect, Layer, Semaphore } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { SessionPrompt } from "@/session/prompt"
import type { TaskPromptOps } from "@/tool/task"
import { MessageID } from "@/session/schema"
import { Dag } from "@/dag/dag"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import type { DagStore } from "@opencode-ai/core/dag/store"
import { spawnNode, type NodeSpawnInput } from "@/dag/runtime/spawn"

// ─── Event tracker ──────────────────────────────────────────────────────────

type TrackedEvent = { type: string; dagID: string; nodeID: string; output?: unknown; reason?: string }

function makeEventTracker() {
  const events: TrackedEvent[] = []
  const dagLayer = Layer.succeed(Dag.Service, Dag.Service.of({
    nodeStarted: Effect.fn("stub.nodeStarted")((dagID: string, nodeID: string) =>
      Effect.sync(() => events.push({ type: "nodeStarted", dagID, nodeID })),
    ),
    nodeCompleted: Effect.fn("stub.nodeCompleted")((dagID: string, nodeID: string, output: unknown) =>
      Effect.sync(() => events.push({ type: "nodeCompleted", dagID, nodeID, output })),
    ),
    nodeFailed: Effect.fn("stub.nodeFailed")((dagID: string, nodeID: string, reason: string) =>
      Effect.sync(() => events.push({ type: "nodeFailed", dagID, nodeID, reason })),
    ),
    create: () => Effect.die("not used"),
    store: {} as DagStore.Interface,
    pause: () => Effect.void,
    resume: () => Effect.void,
    cancel: () => Effect.void,
    complete: () => Effect.void,
    replan: () => Effect.die("not used"),
    nodeSkipped: () => Effect.void,
    nodeCancelled: () => Effect.void,
    nodeRestarted: () => Effect.void,
  }))
  return { events, dagLayer }
}

// ─── Stubs ──────────────────────────────────────────────────────────────────

function makeNodeRow(overrides: Partial<DagStore.NodeRow> = {}): DagStore.NodeRow {
  return {
    id: "node-1",
    workflowId: "wf-1",
    name: "Test Node",
    workerType: "build",
    status: "pending",
    required: true,
    dependsOn: [],
    modelId: null,
    modelProviderId: null,
    childSessionId: null,
    output: undefined,
    errorReason: null,
    retryCount: 0,
    seq: 0,
    startedAt: null,
    completedAt: null,
    ...overrides,
  }
}

const agentLayer = Layer.succeed(Agent.Service, Agent.Service.of({
  get: () => Effect.succeed({
    name: "build",
    mode: "all",
    permission: [],
    options: {},
    description: "",
    prompt: "",
    model: { providerID: "test" as never, modelID: "test-model" as never },
    tools: {},
    hooks: {},
  }),
  list: () => Effect.succeed([]),
  defaultInfo: () => Effect.die("not used"),
  defaultAgent: () => Effect.succeed("build"),
  generate: () => Effect.die("not used"),
}))

const sessionLayer = Layer.succeed(Session.Service, Session.Service.of({
  get: () => Effect.succeed({ id: "ses_parent" as never, permission: [], agent: "build" } as never),
  create: () => Effect.succeed({ id: "ses_child" as never } as never),
  list: () => Effect.succeed([]),
  remove: () => Effect.void,
  update: () => Effect.void,
  abort: () => Effect.void,
  prompt: () => Effect.die("not used"),
  fork: () => Effect.die("not used"),
  messages: () => Effect.succeed([]),
  findMessage: () => Effect.succeed(undefined),
} as never))

function reply(text: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: "ses_child" as never,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model" as never,
      providerID: "test" as never,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: text ? [{ type: "text", text }] as never : [],
  }
}

function makePromptOps(result: SessionV1.WithParts): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: () => Effect.succeed([{ type: "text" as const, text: "" }]),
    prompt: () => Effect.succeed(result),
  }
}

function makeFailingPromptOps(error: string): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: () => Effect.succeed([{ type: "text" as const, text: "" }]),
    prompt: () => Effect.die(new Error(error)),
  }
}

function makeSpawnInput(promptOps: TaskPromptOps): NodeSpawnInput {
  return {
    dagID: "wf-1",
    nodeID: "node-1",
    node: makeNodeRow(),
    parentSessionID: "ses_parent",
    parentModelID: "test-model",
    parentProviderID: "test",
    promptParts: [{ type: "text", text: "do the thing" }] as never,
    promptOps,
  }
}

async function runSpawn(dagLayer: Layer.Layer<never>, ops: TaskPromptOps) {
  const semaphore = Semaphore.makeUnsafe(1)
  const fullLayer = Layer.mergeAll(dagLayer, agentLayer, sessionLayer)
  const provided = spawnNode(semaphore, makeSpawnInput(ops)).pipe(Effect.provide(fullLayer))
  await Effect.runPromise(provided as Effect.Effect<never>)
  // Give the forked fiber time to complete
  await new Promise((resolve) => setTimeout(resolve, 100))
}

function findEvent(events: TrackedEvent[], type: string) {
  return events.find((e) => e.type === type)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("spawnNode completion bridge", () => {
  it("publishes NodeCompleted with output text on success", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptOps(reply("Task completed successfully")))

    const completed = findEvent(events, "nodeCompleted")
    expect(completed).toBeDefined()
    expect(completed!.output).toBe("Task completed successfully")

    const started = findEvent(events, "nodeStarted")
    expect(started).toBeDefined()
  })

  it("publishes NodeCompleted with empty output when no text part", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptOps(reply("")))

    const completed = findEvent(events, "nodeCompleted")
    expect(completed).toBeDefined()
    expect(completed!.output).toBe("")
  })

  it("publishes NodeFailed when prompt fails", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makeFailingPromptOps("LLM exploded"))

    const failed = findEvent(events, "nodeFailed")
    expect(failed).toBeDefined()
    expect(failed!.reason).toContain("LLM exploded")

    expect(findEvent(events, "nodeCompleted")).toBeUndefined()
  })

  it("publishes exactly one terminal event per node", async () => {
    const { events, dagLayer } = makeEventTracker()
    await runSpawn(dagLayer, makePromptOps(reply("done")))

    const terminal = events.filter((e) => e.type === "nodeCompleted" || e.type === "nodeFailed")
    expect(terminal.length).toBe(1)
  })
})
