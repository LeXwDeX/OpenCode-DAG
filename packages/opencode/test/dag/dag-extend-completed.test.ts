import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { TerminalViolationError } from "@opencode-ai/core/dag/core/types"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { Dag, type NodeConfig } from "@/dag/dag"
import { EventV2Bridge } from "@/event-v2-bridge"

const dagID = "dag_extend_completed"

function checkpoint(): NodeConfig {
  return {
    id: "checkpoint",
    name: "Checkpoint",
    worker_type: "review",
    depends_on: [],
    required: true,
    report_to_parent: true,
    prompt_template: { inline: "review" },
  }
}

function harness() {
  const workflow: DagStore.WorkflowRow = {
    id: dagID,
    projectId: "project",
    sessionId: "session",
    title: "adaptive-checkpoint",
    status: "completed",
    config: JSON.stringify({ name: "adaptive-checkpoint", nodes: [checkpoint()] }),
    seq: 5,
    wakeReported: true,
    startedAt: 1,
    completedAt: 5,
    timeCreated: 0,
    timeUpdated: 5,
  }
  const nodes: DagStore.NodeRow[] = [{
    id: "checkpoint",
    workflowId: dagID,
    name: "Checkpoint",
    workerType: "review",
    status: "completed",
    required: true,
    dependsOn: [],
    modelId: null,
    modelProviderId: null,
    childSessionId: "ses_checkpoint",
    output: { verdict: "REVISE" },
    capturedOutput: { verdict: "REVISE" },
    errorReason: null,
    deadlineMs: null,
    wakeEligible: true,
    wakeReported: true,
    replanAttempts: 0,
    seq: 4,
    startedAt: 2,
    completedAt: 4,
  }]
  const published: string[] = []
  const store = Layer.mock(DagStore.Service, {
    getWorkflow: () => Effect.succeed(workflow),
    getNodes: () => Effect.succeed(nodes),
    getNode: (_workflowID: string, nodeID: string) =>
      Effect.succeed(nodes.find((node) => node.id === nodeID)),
  })
  const publish: EventV2.Interface["publish"] = (definition, data) =>
    Effect.sync(() => {
      published.push(definition.type)
      if (definition.type === DagEvent.NodeRegistered.type) {
        const event = data as unknown as {
          nodeID: string
          dagID: string
          name: string
          workerType: string
          required: boolean
          dependsOn: string[]
          model?: { modelID: string; providerID: string }
        }
        nodes.push({
          id: event.nodeID,
          workflowId: event.dagID,
          name: event.name,
          workerType: event.workerType,
          status: "pending",
          required: event.required,
          dependsOn: [...event.dependsOn],
          modelId: event.model?.modelID ?? null,
          modelProviderId: event.model?.providerID ?? null,
          childSessionId: null,
          output: null,
          capturedOutput: null,
          errorReason: null,
          deadlineMs: null,
          wakeEligible: false,
          wakeReported: false,
          replanAttempts: 0,
          seq: 6,
          startedAt: null,
          completedAt: null,
        })
      }
      if (definition.type === DagEvent.WorkflowConfigUpdated.type) {
        workflow.config = (data as unknown as { config: string }).config
      }
      if (definition.type === DagEvent.WorkflowReplanned.type) {
        workflow.status = "running"
        workflow.completedAt = null
        workflow.wakeReported = false
      }
      return { type: definition.type, data } as never
    })
  const events = Layer.succeed(
    EventV2Bridge.Service,
    EventV2Bridge.Service.of({
      publish,
    } as never),
  )
  return {
    layer: Dag.layer.pipe(Layer.provide(events), Layer.provide(store)),
    nodes,
    published,
    workflow,
  }
}

describe("Dag.extend completed checkpoint", () => {
  it("reopens a completed workflow when additive nodes are supplied", async () => {
    const test = harness()
    await Effect.runPromise(
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        const result = yield* dag.extend(dagID, [{
          id: "repair",
          name: "Repair",
          worker_type: "build",
          depends_on: ["checkpoint"],
          required: true,
          prompt_template: { inline: "repair" },
        }])

        expect(result.add).toEqual(["repair"])
        expect(test.workflow).toEqual(expect.objectContaining({
          status: "running",
          completedAt: null,
          wakeReported: false,
        }))
        expect(test.nodes.find((node) => node.id === "repair")).toEqual(expect.objectContaining({
          status: "pending",
          dependsOn: ["checkpoint"],
        }))
        expect(JSON.parse(test.workflow.config).nodes.map((item: { id: string }) => item.id))
          .toEqual(["checkpoint", "repair"])
        expect(test.published).toContain(DagEvent.WorkflowReplanned.type)
      }).pipe(Effect.provide(test.layer)) as Effect.Effect<never>,
    )
  })

  it("does not reopen a completed workflow without an additive node", async () => {
    const test = harness()
    await Effect.runPromise(
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        const error = yield* dag.extend(dagID, [checkpoint()]).pipe(
          Effect.catch((cause: Error) => Effect.succeed(cause)),
        )

        expect(error).toBeInstanceOf(TerminalViolationError)
        expect(test.workflow.status).toBe("completed")
        expect(test.published).toEqual([])
      }).pipe(Effect.provide(test.layer)) as Effect.Effect<never>,
    )
  })

  it("continues to reject ordinary replans on completed workflows", async () => {
    const test = harness()
    await Effect.runPromise(
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        const error = yield* dag.replan(dagID, { nodes: [] }).pipe(
          Effect.catch((cause: Error) => Effect.succeed(cause)),
        )

        expect(error).toBeInstanceOf(TerminalViolationError)
        expect(test.published).toEqual([])
      }).pipe(Effect.provide(test.layer)) as Effect.Effect<never>,
    )
  })
})
