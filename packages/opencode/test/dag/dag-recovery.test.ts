import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { reconcileWorkflow } from "@/dag/runtime/recovery"
import { Dag } from "@/dag/dag"
import type { DagStore } from "@opencode-ai/core/dag/store"
import { WorkflowRuntime } from "@opencode-ai/core/dag/core/scheduling"
import { SUCCESS_TERMINAL, toSchedulingNodes } from "@/dag/runtime/loop"
import { makeNodeRow } from "./fixtures"

function makeDagLayer(nodes: DagStore.NodeRow[], trackedEvents: { type: string; nodeID: string }[]) {
  return Layer.mock(Dag.Service, {
    store: {
      getNodes: () => Effect.succeed(nodes),
      getNode: (id: string) => Effect.succeed(nodes.find((n) => n.id === id)),
    } as unknown as DagStore.Interface,
    nodeCompleted: Effect.fn("stub.nodeCompleted")((dagID: string, nodeID: string) =>
      Effect.sync(() => trackedEvents.push({ type: "nodeCompleted", nodeID })),
    ),
    nodeFailed: Effect.fn("stub.nodeFailed")((dagID: string, nodeID: string) =>
      Effect.sync(() => trackedEvents.push({ type: "nodeFailed", nodeID })),
    ),
    nodeStarted: Effect.fn("stub.nodeStarted")((dagID: string, nodeID: string) =>
      Effect.sync(() => trackedEvents.push({ type: "nodeStarted", nodeID })),
    ),
  })
}

describe("reconcileWorkflow", () => {
  it("publishes NodeCompleted for running node with completed child session", async () => {
    const events: { type: string; nodeID: string }[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("completed" as const)

    await Effect.runPromise(reconcileWorkflow("wf-1", checkStatus).pipe(Effect.provide(dagLayer)))

    expect(events).toContainEqual({ type: "nodeCompleted", nodeID: "n1" })
    expect(events).not.toContainEqual({ type: "nodeFailed", nodeID: "n1" })
  })

  it("publishes NodeFailed for running node with failed child session", async () => {
    const events: { type: string; nodeID: string }[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("failed" as const)

    await Effect.runPromise(reconcileWorkflow("wf-1", checkStatus).pipe(Effect.provide(dagLayer)))

    expect(events).toContainEqual({ type: "nodeFailed", nodeID: "n1" })
  })

  it("publishes NodeFailed for running node with no child session", async () => {
    const events: { type: string; nodeID: string }[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: null })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("active" as const)

    await Effect.runPromise(reconcileWorkflow("wf-1", checkStatus).pipe(Effect.provide(dagLayer)))

    expect(events).toContainEqual({ type: "nodeFailed", nodeID: "n1" })
  })

  it("leaves running node active when child session is still active", async () => {
    const events: { type: string; nodeID: string }[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("active" as const)

    const result = await Effect.runPromise(reconcileWorkflow("wf-1", checkStatus).pipe(Effect.provide(dagLayer)))

    expect(events).toEqual([])
    expect(result.leftRunning).toBe(1)
    expect(result.reconciled).toBe(0)
  })

  it("publishes NodeFailed for pending node with no child session", async () => {
    const events: { type: string; nodeID: string }[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "pending", childSessionId: null })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("active" as const)

    await Effect.runPromise(reconcileWorkflow("wf-1", checkStatus).pipe(Effect.provide(dagLayer)))

    expect(events).toContainEqual({ type: "nodeFailed", nodeID: "n1" })
  })

  it("publishes NodeStarted retroactively for pending node with active child session", async () => {
    const events: { type: string; nodeID: string }[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "pending", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("active" as const)

    const result = await Effect.runPromise(reconcileWorkflow("wf-1", checkStatus).pipe(Effect.provide(dagLayer)))

    expect(events).toContainEqual({ type: "nodeStarted", nodeID: "n1" })
    expect(result.leftRunning).toBe(1)
  })

  it("skips non-running, non-pending nodes", async () => {
    const events: { type: string; nodeID: string }[] = []
    const nodes = [
      makeNodeRow({ id: "n1", status: "completed", childSessionId: "ses_1" }),
      makeNodeRow({ id: "n2", status: "skipped", childSessionId: null }),
    ]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("completed" as const)

    const result = await Effect.runPromise(reconcileWorkflow("wf-1", checkStatus).pipe(Effect.provide(dagLayer)))

    expect(events).toEqual([])
    expect(result.reconciled).toBe(0)
  })

  it("handles unknown session status gracefully", async () => {
    const events: { type: string; nodeID: string }[] = []
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const dagLayer = makeDagLayer(nodes, events)
    const checkStatus = () => Effect.succeed("unknown" as const)

    const result = await Effect.runPromise(reconcileWorkflow("wf-1", checkStatus).pipe(Effect.provide(dagLayer)))

    expect(events).toEqual([])
    expect(result.leftRunning).toBe(1)
  })
})

describe("rehydration via toSchedulingNodes", () => {
  it("running nodes are seeded as running in WorkflowRuntime", () => {
    const nodes = [makeNodeRow({ id: "n1", status: "running", childSessionId: "ses_1" })]
    const rt = new WorkflowRuntime(toSchedulingNodes(nodes), 4)
    expect(rt.getReadyNodes()).toEqual([])
    expect(rt.isComplete()).toBe(false)
  })

  it("completed nodes after reconciliation are seeded as satisfied", () => {
    const nodes = [
      makeNodeRow({ id: "n1", status: "completed" }),
      makeNodeRow({ id: "n2", status: "pending", dependsOn: ["n1"] }),
    ]
    const rt = new WorkflowRuntime(toSchedulingNodes(nodes), 4)
    expect(rt.getReadyNodes()).toEqual(["n2"])
  })

  it("failed nodes after reconciliation are seeded as unsatisfied with cascade", () => {
    const nodes = [
      makeNodeRow({ id: "n1", status: "failed", required: true }),
      makeNodeRow({ id: "n2", status: "pending", dependsOn: ["n1"] }),
    ]
    const rt = new WorkflowRuntime(toSchedulingNodes(nodes), 4)
    expect(rt.getReadyNodes()).toEqual([])
    expect(rt.isComplete()).toBe(true)
    expect(rt.hasRequiredFailure()).toBe(true)
  })

  it("paused workflow rehydrates with setPaused(true)", () => {
    const nodes = [makeNodeRow({ id: "n1", status: "pending" })]
    const rt = new WorkflowRuntime(toSchedulingNodes(nodes), 4)
    rt.setPaused(true)
    expect(rt.isPaused()).toBe(true)
    expect(rt.getReadyNodes()).toEqual([])
  })
})
