/**
 * DAG Mutation HttpApi Handlers — State-changing endpoints (§10).
 */

import { WorkflowEngine } from "@/dag/session/workflow-engine"
import { DAGQueryTag } from "@/dag/layer"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const dagMutationHandlers = HttpApiBuilder.group(InstanceHttpApi, "dag-mutation", (handlers) =>
  Effect.gen(function* () {
    const dagQuery = yield* DAGQueryTag

    const pause = Effect.fn("DagMutationHttpApi.pause")(
      function* (ctx: { params: { workflowId: string } }) {
        const engine = WorkflowEngine.get(ctx.params.workflowId)
        if (!engine) {
          const workflow = yield* Effect.promise(() => dagQuery.getWorkflow(ctx.params.workflowId))
          return { status: workflow?.status ?? "pending" }
        }
        const status = yield* engine.pauseWorkflow(ctx.params.workflowId)
        return { status }
      },
    )

    const resume = Effect.fn("DagMutationHttpApi.resume")(
      function* (ctx: { params: { workflowId: string } }) {
        const engine = WorkflowEngine.get(ctx.params.workflowId)
        if (!engine) {
          const workflow = yield* Effect.promise(() => dagQuery.getWorkflow(ctx.params.workflowId))
          return { status: workflow?.status ?? "pending" }
        }
        const status = yield* engine.resumeWorkflow(ctx.params.workflowId)
        return { status }
      },
    )

    return handlers
      .handle("pause", pause)
      .handle("resume", resume)
  }),
)
