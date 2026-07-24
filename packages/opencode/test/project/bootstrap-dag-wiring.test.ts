import { describe, expect } from "bun:test"
import { Dag } from "@/dag/dag"
import { InstanceState } from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Layer } from "effect"
import { tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const appLayer = LayerNode.buildLayer(
  LayerNode.group([InstanceStore.node, Dag.node, Project.node, Session.node, SessionProjector.node]),
)
const appIt = testEffect(Layer.mergeAll(appLayer, CrossSpawnSpawner.defaultLayer))

describe("instance bootstrap DAG wiring", () => {
  appIt.live("recovers a persisted workflow when InstanceStore bootstraps the production graph", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const instances = yield* InstanceStore.Service
      const workflowID = yield* instances.provide(
        { directory },
        Effect.gen(function* () {
          const context = yield* InstanceState.context
          const session = yield* Session.Service
          const dag = yield* Dag.Service
          const parent = yield* session.create({ title: "bootstrap DAG wiring" })
          yield* pollWithTimeout(
            session.get(parent.id).pipe(
              Effect.as(true as const),
              Effect.catch(() => Effect.succeed(undefined)),
            ),
            "session projection did not become visible",
          )
          return yield* dag.create({
            projectID: context.project.id,
            sessionID: parent.id,
            title: "condition false",
            config: {
              name: "condition false",
              nodes: [
                {
                  id: "skip",
                  name: "skip without a model call",
                  worker_type: "reviewer",
                  depends_on: [],
                  required: true,
                  prompt_template: { inline: "unused" },
                  condition: "missing == true",
                },
              ],
            },
          })
        }),
      )
      yield* instances.reload({ directory })
      yield* instances.provide(
        { directory },
        Effect.gen(function* () {
          const dag = yield* Dag.Service
          const result = yield* pollWithTimeout(
            Effect.gen(function* () {
              const workflow = yield* dag.store.getWorkflow(workflowID)
              const nodes = yield* dag.store.getNodes(workflowID)
              if (workflow?.status !== "completed" || nodes[0]?.status !== "skipped") return
              return { workflow, node: nodes[0] }
            }),
            "bootstrap did not start the DAG scheduler",
            "1 second",
          )
          expect(result.workflow.status).toBe("completed")
          expect(result.node.status).toBe("skipped")
        }),
      )
    }),
  )
})
