/**
 * DAG HttpApi Handlers — Read-only, no state mutation (§9.a).
 */

import type { DAGNodeSession } from "@/dag/session/types"
import { DAGQueryTag } from "@/dag/layer"
import { DAGProbe } from "@/dag/query/dag-probe"
import { DAGSessionService } from "@/dag/session/session-service"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const dagHandlers = HttpApiBuilder.group(InstanceHttpApi, "dag", (handlers) =>
  Effect.gen(function* () {
    const dagQuery = yield* DAGQueryTag
    const dagProbe = new DAGProbe(yield* DAGSessionService.make)

    const listWorkflows = Effect.fn("DagHttpApi.listWorkflows")(
      function* (ctx: { query: { chatSessionId?: string } }) {
        if (ctx.query.chatSessionId) {
          return yield* Effect.promise(() => dagQuery.listWorkflowsByChatSession(ctx.query.chatSessionId!))
        }
        return yield* Effect.promise(() => dagQuery.listWorkflows())
      },
    )

    const getWorkflow = Effect.fn("DagHttpApi.getWorkflow")(
      function* (ctx: { params: { workflowId: string } }) {
        const workflow = yield* Effect.promise(() => dagQuery.getWorkflow(ctx.params.workflowId))
        if (!workflow) return { workflow: null, nodes: [] as DAGNodeSession[] }
        const nodes = yield* Effect.promise(() => dagQuery.getNodes(ctx.params.workflowId))
        return { workflow, nodes }
      },
    )

    const getTimeline = Effect.fn("DagHttpApi.getTimeline")(
      function* (ctx: { params: { workflowId: string } }) {
        return yield* Effect.promise(() => dagQuery.getExecutionTimeline(ctx.params.workflowId))
      },
    )

    const getStats = Effect.fn("DagHttpApi.getStats")(
      function* (ctx: { params: { workflowId: string } }) {
        return yield* Effect.promise(() => dagQuery.getGraphStatistics(ctx.params.workflowId))
      },
    )

    const getViolations = Effect.fn("DagHttpApi.getViolations")(
      function* (ctx: { params: { workflowId: string } }) {
        return yield* Effect.promise(() => dagQuery.listViolations(ctx.params.workflowId))
      },
    )

    const getWorkflowHistory = Effect.fn("DagHttpApi.getWorkflowHistory")(
      function* (ctx: { params: { workflowId: string }; headers: { limit?: number } }) {
        return yield* Effect.promise(() => dagQuery.listHistory(ctx.params.workflowId, ctx.headers.limit))
      },
    )

    const getNodeLogs = Effect.fn("DagHttpApi.getNodeLogs")(
      function* (ctx: { params: { nodeId: string }; headers: { limit?: number } }) {
        return yield* Effect.promise(() => dagQuery.listNodeLogs(ctx.params.nodeId, ctx.headers.limit))
      },
    )

    const diagnoseBlock = Effect.fn("DagHttpApi.diagnoseBlock")(
      function* (ctx: { params: { workflowId: string } }) {
        return yield* Effect.promise(() => dagProbe.explainBlock(ctx.params.workflowId))
      },
    )

    const diagnoseTopology = Effect.fn("DagHttpApi.diagnoseTopology")(
      function* (ctx: { params: { workflowId: string } }) {
        return yield* Effect.promise(() => dagProbe.getTopology(ctx.params.workflowId))
      },
    )

    const diagnoseSnapshot = Effect.fn("DagHttpApi.diagnoseSnapshot")(
      function* (ctx: { params: { workflowId: string } }) {
        return yield* Effect.promise(() => dagProbe.getExecutionSnapshot(ctx.params.workflowId))
      },
    )

    const diagnoseCascade = Effect.fn("DagHttpApi.diagnoseCascade")(
      function* (ctx: { params: { workflowId: string; nodeId: string } }) {
        return yield* Effect.promise(() => dagProbe.predictCascade(ctx.params.workflowId, ctx.params.nodeId))
      },
    )

    return handlers
      .handle("listWorkflows", listWorkflows)
      .handle("getWorkflow", getWorkflow)
      .handle("getTimeline", getTimeline)
      .handle("getStats", getStats)
      .handle("getViolations", getViolations)
      .handle("getWorkflowHistory", getWorkflowHistory)
      .handle("getNodeLogs", getNodeLogs)
      .handle("diagnoseBlock", diagnoseBlock)
      .handle("diagnoseTopology", diagnoseTopology)
      .handle("diagnoseSnapshot", diagnoseSnapshot)
      .handle("diagnoseCascade", diagnoseCascade)
  }),
)
