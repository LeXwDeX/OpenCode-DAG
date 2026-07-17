import { describe, expect, it } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceRef } from "@/effect/instance-ref"
import { DagSummaryPublisher } from "@/dag/runtime/summary-publisher"
import { GlobalBus } from "@/bus/global"

const ts = (n: number) => DateTime.makeUnsafe(n)
const dagID = "dag_pub" as never
const nodeID = "node-pub-1" as never
const sessionID = "ses_pub" as never

const baseLayer = Layer.mergeAll(
  Database.defaultLayer,
  EventV2.defaultLayer,
  DagProjector.defaultLayer,
  DagStore.defaultLayer,
  EventV2Bridge.defaultLayer,
)

// Publisher layer sits on top of baseLayer; provide them together so the test
// body (which also needs Database/EventV2 for setup) shares the same runtime.
const runtimeLayer = Layer.provideMerge(DagSummaryPublisher.layer, baseLayer)

const ctx = {
  directory: "/project" as never,
  worktree: "/project" as never,
  project: { id: Project.ID.global, worktree: AbsolutePath.make("/project"), directory: AbsolutePath.make("/project"), config: {} } as never,
}

function setup() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run().pipe(Effect.orDie)
    yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, slug: "pub", directory: "/project", title: "pub", version: "test" }).run().pipe(Effect.orDie)
  })
}

interface SummaryEmission {
  sessionID: string
  summaries: unknown[]
}

function startCollector(): { emissions: SummaryEmission[]; stop: () => void } {
  const emissions: SummaryEmission[] = []
  const handler = (e: { payload?: { type?: string; properties?: { sessionID?: string; summaries?: unknown[] } } }) => {
    if (e.payload?.type === "dag.workflow.summary.updated") {
      emissions.push({ sessionID: e.payload.properties!.sessionID!, summaries: e.payload.properties!.summaries! })
    }
  }
  GlobalBus.on("event", handler)
  return { emissions, stop: () => GlobalBus.off("event", handler) }
}

describe("DagSummaryPublisher behavior (integration)", () => {
  it("a dag.node.completed event triggers a summary emission with aggregated counts", async () => {
    const collector = startCollector()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          // Start the publisher subscriptions first (init drives InstanceState).
          const publisher = yield* DagSummaryPublisher.Service
          yield* publisher.init()
          // init() forks the subscribe fibers; give the EventV2 PubSub subscriptions
          // a tick to register before publishing, otherwise events published before
          // the stream is drained are dropped (PubSub does not buffer history).
          yield* Effect.sleep("20 millis")
          yield* setup()
          const events = yield* EventV2.Service
          yield* events.publish(DagEvent.WorkflowCreated, { dagID, projectID: Project.ID.global as never, sessionID, title: "pub-test", config: "", status: "pending", timestamp: ts(0) })
          yield* events.publish(DagEvent.NodeRegistered, { dagID, nodeID, name: "Build", workerType: "build", dependsOn: [], required: true, timestamp: ts(1) })
          yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID, childSessionID: "ses_child" as never, timestamp: ts(2) })
          yield* events.publish(DagEvent.NodeCompleted, { dagID, nodeID, output: { ok: true }, durationMs: 5, timestamp: ts(3) })
          // Give the burst-coalesced publish fiber a chance to run.
          yield* Effect.sleep("150 millis")
        }).pipe(
          Effect.scoped,
          Effect.provideService(InstanceRef, ctx),
          Effect.provide(runtimeLayer),
        ) as Effect.Effect<never>,
      )

      expect(collector.emissions.length).toBeGreaterThanOrEqual(1)
      const last = collector.emissions.at(-1)!
      expect(last.sessionID).toBe(sessionID)
      expect(last.summaries).toHaveLength(1)
      expect(last.summaries[0]).toMatchObject({
        id: "dag_pub",
        nodeCount: 1,
        completedNodes: 1,
        runningNodes: 0,
        failedNodes: 0,
      })
    } finally {
      collector.stop()
    }
  })

  it("coalesces a burst of node events (fewer emissions than events, final state aggregated)", async () => {
    const collector = startCollector()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const publisher = yield* DagSummaryPublisher.Service
          yield* publisher.init()
          yield* Effect.sleep("20 millis")
          yield* setup()
          const events = yield* EventV2.Service
          yield* events.publish(DagEvent.WorkflowCreated, { dagID, projectID: Project.ID.global as never, sessionID, title: "burst", config: "", status: "pending", timestamp: ts(0) })
          yield* events.publish(DagEvent.WorkflowStarted, { dagID, timestamp: ts(1) })
          for (let i = 1; i <= 5; i++) {
            yield* events.publish(DagEvent.NodeRegistered, { dagID, nodeID: `n-${i}` as never, name: `N${i}`, workerType: "build", dependsOn: [], required: false, timestamp: ts(2 + i) })
          }
          // Fire 5 completed events in a tight burst for the same session.
          for (let i = 1; i <= 5; i++) {
            yield* events.publish(DagEvent.NodeStarted, { dagID, nodeID: `n-${i}` as never, childSessionID: `ses_child_${i}` as never, timestamp: ts(10 + i) })
            yield* events.publish(DagEvent.NodeCompleted, { dagID, nodeID: `n-${i}` as never, output: { ok: true }, durationMs: 1, timestamp: ts(20 + i) })
          }
          // Yield window for the burst-coalesced publish fibers to settle.
          yield* Effect.sleep("200 millis")
        }).pipe(
          Effect.scoped,
          Effect.provideService(InstanceRef, ctx),
          Effect.provide(runtimeLayer),
        ) as Effect.Effect<never>,
      )

      // Coalescing collapses a burst of 10 synchronous node events into far fewer
      // emissions than the event count. The strict count is scheduler-dependent,
      // so assert the invariant: the publisher never emitted one-per-event, and
      // the final emission reflects the fully-aggregated state.
      const emissions = collector.emissions
      const triggeredNodeEvents = 10
      expect(emissions.length).toBeLessThan(triggeredNodeEvents)
      expect(emissions.length).toBeGreaterThanOrEqual(1)
      const last = emissions.at(-1)!
      expect(last.summaries[0]).toMatchObject({ nodeCount: 5, completedNodes: 5, runningNodes: 0 })
    } finally {
      collector.stop()
    }
  })
})
