import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError, notFound } from "../errors"
import { Dag } from "@/dag/dag"
import type { DagStore } from "@opencode-ai/core/dag/store"

/**
 * DAG HTTP handlers — read-only queries delegate to DagStore; control mutations
 * delegate to Dag.Service. Same code path as the agent tool surface.
 */
export const dagHandlers = HttpApiBuilder.group(InstanceHttpApi, "dag", (handlers) =>
  Effect.gen(function* () {
    const dag = yield* Dag.Service

    const wf = (r: DagStore.WorkflowRow) => ({
      id: r.id,
      project_id: r.projectId,
      session_id: r.sessionId,
      title: r.title,
      status: r.status,
      config: r.config,
      seq: r.seq,
      time_created: r.timeCreated,
      time_updated: r.timeUpdated,
      ...(r.startedAt !== null ? { started_at: r.startedAt } : {}),
      ...(r.completedAt !== null ? { completed_at: r.completedAt } : {}),
    })

    const node = (r: DagStore.NodeRow) => ({
      id: r.id,
      workflow_id: r.workflowId,
      name: r.name,
      worker_type: r.workerType,
      status: r.status,
      required: r.required,
      depends_on: r.dependsOn,
      ...(r.modelId !== null ? { model_id: r.modelId } : {}),
      ...(r.modelProviderId !== null ? { model_provider_id: r.modelProviderId } : {}),
      ...(r.childSessionId !== null ? { child_session_id: r.childSessionId } : {}),
      ...(r.output !== null ? { output: r.output } : {}),
      ...(r.errorReason !== null ? { error_reason: r.errorReason } : {}),
      ...(r.startedAt !== null ? { started_at: r.startedAt } : {}),
      ...(r.completedAt !== null ? { completed_at: r.completedAt } : {}),
    })

    const list = Effect.fn("DagHttpApi.list")(function* () {
      const rows = yield* dag.store.listWorkflows().pipe(Effect.orDie)
      return rows.map(wf)
    })

    const bySession = Effect.fn("DagHttpApi.bySession")(function* (ctx: { params: { sessionID: string } }) {
      const rows = yield* dag.store.listBySession(ctx.params.sessionID).pipe(Effect.orDie)
      return rows.map(wf)
    })

    const detail = Effect.fn("DagHttpApi.detail")(function* (ctx: { params: { dagID: string } }) {
      const row = yield* dag.store.getWorkflow(ctx.params.dagID).pipe(Effect.orDie)
      if (!row) return yield* Effect.fail(notFound(`Workflow not found: ${ctx.params.dagID}`))
      return wf(row)
    })

    const nodes = Effect.fn("DagHttpApi.nodes")(function* (ctx: { params: { dagID: string } }) {
      const rows = yield* dag.store.getNodes(ctx.params.dagID).pipe(Effect.orDie)
      return rows.map(node)
    })

    const nodeDetail = Effect.fn("DagHttpApi.nodeDetail")(function* (ctx: { params: { dagID: string; nodeID: string } }) {
      const row = yield* dag.store.getNode(ctx.params.nodeID).pipe(Effect.orDie)
      if (!row) return yield* Effect.fail(notFound(`Node not found: ${ctx.params.nodeID}`))
      return node(row)
    })

    const control = Effect.fn("DagHttpApi.control")(function* (ctx: { params: { dagID: string }; payload: { operation: string; fragment?: unknown } }) {
      const { dagID } = ctx.params
      const op = ctx.payload.operation

      if (op === "pause" || op === "step") {
        yield* dag.pause(dagID).pipe(Effect.orDie)
        return { status: "ok" }
      }
      if (op === "resume") {
        yield* dag.resume(dagID).pipe(Effect.orDie)
        return { status: "ok" }
      }
      if (op === "cancel") {
        yield* dag.cancel(dagID).pipe(Effect.orDie)
        return { status: "ok" }
      }
      if (op === "complete") {
        yield* dag.complete(dagID).pipe(Effect.orDie)
        return { status: "ok" }
      }
      if (op === "replan") {
        const fragment = ctx.payload.fragment
        if (!fragment || typeof fragment !== "object" || !Array.isArray((fragment as Record<string, unknown>).nodes)) {
          return yield* Effect.fail(new InvalidRequestError({ message: "replan requires 'fragment' with a 'nodes' array" }))
        }
        const result = yield* dag.replan(dagID, fragment as { nodes: Dag.NodeConfig[] }).pipe(Effect.orDie)
        return { status: "ok", ...result } as never
      }
      return yield* Effect.fail(new InvalidRequestError({ message: `Unknown operation: ${op}` }))
    })

    return handlers
      .handle("list", list)
      .handle("bySession", bySession as never)
      .handle("detail", detail as never)
      .handle("nodes", nodes as never)
      .handle("nodeDetail", nodeDetail as never)
      .handle("control", control as never)
  }),
)
