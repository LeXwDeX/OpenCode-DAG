import { describe, expect, it } from "bun:test"
import { Effect, Layer, Fiber, Semaphore } from "effect"
import { computeMergedConfig, type NodeConfig, type WorkflowConfig } from "@/dag/dag"
import { attachNodeCompletionWatcher } from "@/dag/runtime/spawn"
import { Dag } from "@/dag/dag"
import type { DagStore } from "@opencode-ai/core/dag/store"

// ============================================================================
// computeMergedConfig tests (E3: node-def persistence)
// ============================================================================

function makeNode(id: string, overrides: Partial<NodeConfig> = {}): NodeConfig {
  return {
    id,
    name: `Node ${id}`,
    worker_type: "build",
    depends_on: [],
    required: false,
    prompt_template: { inline: `Prompt for ${id}` },
    ...overrides,
  }
}

function makeWorkflowConfig(nodes: NodeConfig[]): WorkflowConfig {
  return { name: "test-wf", max_concurrency: 4, nodes }
}

describe("computeMergedConfig", () => {
  it("adds new nodes from fragment", () => {
    const current = makeWorkflowConfig([makeNode("a"), makeNode("b")])
    const fragment = { nodes: [makeNode("c", { prompt_template: { inline: "New prompt C" } })] }
    const merged = computeMergedConfig(current, fragment, {
      cancel: [], restart: [], replace: [], add: ["c"],
    })
    expect(merged.nodes.map((n) => n.id)).toEqual(["a", "b", "c"])
    expect(merged.nodes.find((n) => n.id === "c")?.prompt_template?.inline).toBe("New prompt C")
  })

  it("removes cancelled nodes", () => {
    const current = makeWorkflowConfig([makeNode("a"), makeNode("b")])
    const merged = computeMergedConfig(current, { nodes: [] }, {
      cancel: ["b"], restart: [], replace: [], add: [],
    })
    expect(merged.nodes.map((n) => n.id)).toEqual(["a"])
  })

  it("replaces nodes with fragment definition", () => {
    const current = makeWorkflowConfig([makeNode("a", { prompt_template: { inline: "Old" } })])
    const fragment = { nodes: [makeNode("a", { prompt_template: { inline: "New" } })] }
    const merged = computeMergedConfig(current, fragment, {
      cancel: [], restart: [], replace: ["a"], add: [],
    })
    expect(merged.nodes.find((n) => n.id === "a")?.prompt_template?.inline).toBe("New")
  })

  it("restart nodes take fragment definition", () => {
    const current = makeWorkflowConfig([makeNode("a", { prompt_template: { inline: "Old" } })])
    const fragment = { nodes: [makeNode("a", { prompt_template: { inline: "Restarted prompt" } })] }
    const merged = computeMergedConfig(current, fragment, {
      cancel: [], restart: ["a"], replace: [], add: [],
    })
    expect(merged.nodes.find((n) => n.id === "a")?.prompt_template?.inline).toBe("Restarted prompt")
  })

  it("preserves surviving nodes unchanged", () => {
    const current = makeWorkflowConfig([
      makeNode("a", { prompt_template: { inline: "Unchanged" } }),
      makeNode("b"),
    ])
    const merged = computeMergedConfig(current, { nodes: [] }, {
      cancel: ["b"], restart: [], replace: [], add: [],
    })
    expect(merged.nodes.find((n) => n.id === "a")?.prompt_template?.inline).toBe("Unchanged")
  })

  it("preserves workflow-level config (name, max_concurrency, etc.)", () => {
    const current: WorkflowConfig = {
      name: "my-workflow", max_concurrency: 8, nodes: [makeNode("a")],
    }
    const merged = computeMergedConfig(current, { nodes: [] }, {
      cancel: [], restart: [], replace: [], add: [],
    })
    expect(merged.name).toBe("my-workflow")
    expect(merged.max_concurrency).toBe(8)
  })
})

// ============================================================================
// attachNodeCompletionWatcher tests (E4: crash recovery fiber re-attachment)
// ============================================================================

type TrackedEvent = { type: string; nodeID: string; reason?: string }

function makeWatcherEventTracker() {
  const events: TrackedEvent[] = []
  const dagLayer = Layer.mock(Dag.Service, {
    store: {} as DagStore.Interface,
    create: () => Effect.die("not implemented"),
    pause: () => Effect.die("not implemented"),
    resume: () => Effect.die("not implemented"),
    cancel: () => Effect.die("not implemented"),
    complete: () => Effect.die("not implemented"),
    replan: () => Effect.die("not implemented"),
    nodeStarted: () => Effect.die("not implemented"),
    nodeCompleted: Effect.fn("stub.nodeCompleted")((_dagID: string, nodeID: string) =>
      Effect.sync(() => events.push({ type: "nodeCompleted", nodeID })),
    ),
    nodeFailed: Effect.fn("stub.nodeFailed")((_dagID: string, nodeID: string, reason: string) =>
      Effect.sync(() => events.push({ type: "nodeFailed", nodeID, reason })),
    ),
    nodeSkipped: () => Effect.die("not implemented"),
    nodeCancelled: () => Effect.die("not implemented"),
    nodeRestarted: () => Effect.die("not implemented"),
  })
  return { events, dagLayer }
}

describe("attachNodeCompletionWatcher", () => {
  it("publishes NodeCompleted when child session completes", async () => {
    const { events, dagLayer } = makeWatcherEventTracker()
    let callCount = 0
    const checkStatus = () =>
      Effect.succeed((++callCount > 1 ? "completed" : "active") as "active" | "completed")

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* attachNodeCompletionWatcher("dag-1", "node-1", "child-1", checkStatus, Semaphore.makeUnsafe(1))
          yield* Fiber.await(fiber)
        }),
      ).pipe(Effect.provide(dagLayer)) as Effect.Effect<never>,
    )

    const completed = events.find((e) => e.type === "nodeCompleted")
    expect(completed).toBeDefined()
    expect(completed!.nodeID).toBe("node-1")
  })

  it("publishes NodeFailed when child session fails", async () => {
    const { events, dagLayer } = makeWatcherEventTracker()
    const checkStatus = () => Effect.succeed("failed" as const)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* attachNodeCompletionWatcher("dag-1", "node-1", "child-1", checkStatus, Semaphore.makeUnsafe(1))
          yield* Fiber.await(fiber)
        }),
      ).pipe(Effect.provide(dagLayer)) as Effect.Effect<never>,
    )

    const failed = events.find((e) => e.type === "nodeFailed")
    expect(failed).toBeDefined()
    expect(failed!.reason).toContain("failed")
  })

  it("treats unknown status as active (continues polling, does not fail)", async () => {
    const { events, dagLayer } = makeWatcherEventTracker()
    let callCount = 0
    // First poll: unknown (0 messages), second poll: completed
    const checkStatus = () =>
      Effect.succeed((++callCount === 1 ? "unknown" : "completed") as "unknown" | "completed")

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* attachNodeCompletionWatcher("dag-1", "node-1", "child-1", checkStatus, Semaphore.makeUnsafe(1))
          yield* Fiber.await(fiber)
        }),
      ).pipe(Effect.provide(dagLayer)) as Effect.Effect<never>,
    )

    // Unknown on first poll did NOT cause nodeFailed — the watcher continued
    const failed = events.find((e) => e.type === "nodeFailed")
    expect(failed).toBeUndefined()

    // Second poll saw completed → nodeCompleted published
    const completed = events.find((e) => e.type === "nodeCompleted")
    expect(completed).toBeDefined()
  })
})

// ============================================================================
// Template fail-loud tests (E5: template resolution failure)
// ============================================================================

describe("template fail-loud (integration via resolveTemplate)", () => {
  it("resolveTemplate fails on missing template id", async () => {
    const { resolveTemplate } = await import("@/dag/templates/resolve")
    const result = await Effect.runPromiseExit(
      resolveTemplate({ id: "nonexistent-template-xyz" }, "/tmp"),
    )
    // resolveTemplate should fail (not silently return node.name)
    expect(result._tag).toBe("Failure")
  })

  it("resolveTemplate succeeds on inline template", async () => {
    const { resolveTemplate } = await import("@/dag/templates/resolve")
    const result = await Effect.runPromise(
      resolveTemplate({ inline: "Hello {{name}}", input: { name: "World" } }, "/tmp"),
    )
    expect(result).toBe("Hello World")
  })
})
