/**
 * DAG Mutation HttpApi Handlers — State-changing endpoints (§10).
 */

import { registerEngine, unregisterEngine, WorkflowEngine } from "@/dag/session/workflow-engine"
import { createWorkflowExecutor } from "@/dag/session/workflow-executor"
import { DAGQueryTag } from "@/dag/layer"
import { DAGSessionService, WorkflowConfigValidationError } from "@/dag/session/session-service"
import type { ReplanPatch } from "@/dag/session/types"
import { SessionPrompt } from "@/session/prompt"
import type { PromptOps } from "@/session/prompt-ops"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { DagValidationError } from "../groups/dag-mutation"

export const dagMutationHandlers = HttpApiBuilder.group(InstanceHttpApi, "dag-mutation", (handlers) =>
  Effect.gen(function* () {
    const dagQuery = yield* DAGQueryTag
    const sessionService = yield* DAGSessionService.make
    const promptSvc = yield* SessionPrompt.Service

    const promptOps: PromptOps = {
      cancel: promptSvc.cancel,
      resolvePromptParts: promptSvc.resolvePromptParts,
      prompt: promptSvc.prompt as PromptOps["prompt"],
      loop: promptSvc.loop,
    }

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

    const cancel = Effect.fn("DagMutationHttpApi.cancel")(
      function* (ctx: { params: { workflowId: string } }) {
        const engine = WorkflowEngine.get(ctx.params.workflowId)
        if (engine) {
          // Engine present but the DB may already be terminal (executor breaks on a terminal
          // status before `ensuring(unregisterEngine)` runs, leaving a window where the engine
          // is still registered). engine.cancelWorkflow → updateWorkflowStatus(cancelled) then
          // throws an Effect.sync defect (not a typed failure), so mirror the engine-missing
          // branch: catch the whole Cause and reply idempotently with the current status —
          // never a 500.
          return yield* Effect.gen(function* () {
            yield* engine.cancelWorkflow(ctx.params.workflowId)
            const workflow = yield* Effect.promise(() => dagQuery.getWorkflow(ctx.params.workflowId))
            return { status: workflow?.status ?? "cancelled" }
          }).pipe(
            Effect.catchCause(() =>
              Effect.gen(function* () {
                const workflow = yield* Effect.promise(() => dagQuery.getWorkflow(ctx.params.workflowId))
                return { status: workflow?.status ?? "pending" }
              }),
            ),
          )
        }
        // Engine missing → downgrade via the session status transition. A terminal→cancelled
        // transition throws inside updateWorkflowStatus (an Effect.sync defect, not a typed
        // failure), so catch the whole Cause and reply idempotently with the current status —
        // never a 500.
        return yield* sessionService.updateWorkflowStatus(ctx.params.workflowId, "cancelled").pipe(
          Effect.as({ status: "cancelled" }),
          Effect.catchCause(() =>
            Effect.gen(function* () {
              const workflow = yield* Effect.promise(() => dagQuery.getWorkflow(ctx.params.workflowId))
              return { status: workflow?.status ?? "pending" }
            }),
          ),
        )
      },
    )

    // P2-B: step handler — executes one ready node under a paused workflow.
    // Engine-missing → status gate returns {ok:false, reason:"not_paused"} (no live engine,
    // so no paused workflow to step). Matches the pause/resume pattern of reading through
    // dagQuery as a fallback.
    const step = Effect.fn("DagMutationHttpApi.step")(
      function* (ctx: { params: { workflowId: string } }) {
        const engine = WorkflowEngine.get(ctx.params.workflowId)
        if (!engine) {
          const workflow = yield* Effect.promise(() => dagQuery.getWorkflow(ctx.params.workflowId))
          return {
            ok: false as const,
            reason: "not_paused",
            workflow_status: workflow?.status ?? "pending",
          }
        }
        return yield* engine.stepWorkflow(ctx.params.workflowId)
      },
    )

    const start = Effect.fn("DagMutationHttpApi.start")(
      function* (ctx: { params: { workflowId: string } }) {
        const workflow = yield* sessionService.getWorkflow(ctx.params.workflowId)
        if (!workflow) return { status: "missing" }
        if (workflow.status !== "pending") return { status: workflow.status }
        const existing = WorkflowEngine.get(ctx.params.workflowId)
        if (existing) return { status: workflow.status }

        const engine = yield* WorkflowEngine.make
        ;(engine as typeof engine & { setPromptOps(ops: PromptOps): void }).setPromptOps(promptOps)
        registerEngine(workflow.id, engine)
        return yield* Effect.gen(function* () {
          yield* engine.startWorkflow(workflow.id, workflow.config)
          yield* createWorkflowExecutor(engine, workflow.config).start(workflow.id).pipe(Effect.forkDetach)
          return { status: "running" }
        }).pipe(Effect.catchCause((cause) => Effect.sync(() => unregisterEngine(workflow.id)).pipe(Effect.andThen(Effect.failCause(cause)))))
      },
    )

    const replan = Effect.fn("DagMutationHttpApi.replan")(
      function* (ctx: {
        params: { workflowId: string }
        payload: {
          add_nodes?: ReadonlyArray<unknown>
          remove_nodes?: ReadonlyArray<string>
          update_nodes?: ReadonlyArray<unknown>
          new_max_concurrency?: number
          changed_by?: string
        }
      }) {
        const engine = WorkflowEngine.get(ctx.params.workflowId)
        // Engine missing → no downgrade: refuse without touching atomicReplan.
        if (!engine) return { ok: false as const, reason: "not_running" }
        const patch: ReplanPatch = {
          workflow_id: ctx.params.workflowId,
          add_nodes: ctx.payload.add_nodes as ReplanPatch["add_nodes"],
          remove_nodes: ctx.payload.remove_nodes as ReplanPatch["remove_nodes"],
          update_nodes: ctx.payload.update_nodes as ReplanPatch["update_nodes"],
          new_max_concurrency: ctx.payload.new_max_concurrency,
          changed_by: ctx.payload.changed_by,
        }
        return yield* engine.replanWorkflow(ctx.params.workflowId, patch)
      },
    )

    const replanPreview = Effect.fn("DagMutationHttpApi.replanPreview")(
      function* (ctx: {
        params: { workflowId: string }
        payload: {
          add_nodes?: ReadonlyArray<unknown>
          remove_nodes?: ReadonlyArray<string>
          update_nodes?: ReadonlyArray<unknown>
          new_max_concurrency?: number
          changed_by?: string
        }
      }) {
        const engine = WorkflowEngine.get(ctx.params.workflowId)
        if (!engine?.previewReplanWorkflow) return { ok: false as const, reason: "not_running" }
        const patch: ReplanPatch = {
          workflow_id: ctx.params.workflowId,
          add_nodes: ctx.payload.add_nodes as ReplanPatch["add_nodes"],
          remove_nodes: ctx.payload.remove_nodes as ReplanPatch["remove_nodes"],
          update_nodes: ctx.payload.update_nodes as ReplanPatch["update_nodes"],
          new_max_concurrency: ctx.payload.new_max_concurrency,
          changed_by: ctx.payload.changed_by,
        }
        return yield* engine.previewReplanWorkflow(ctx.params.workflowId, patch)
      },
    )

    const create = Effect.fn("DagMutationHttpApi.create")(
      function* (ctx: { payload: { name: string; chatSessionId: string; config: unknown } }) {
        const config = ctx.payload.config as {
          nodes: ReadonlyArray<{
            id: string
            name: string
            worker_type: string
            dependencies: string[]
            timeout_ms?: number
            retry?: { max_attempts: number }
          }>
        }
        // createWorkflow runs validateWorkflowConfigLimits; translate its domain error to a
        // public 400 at this boundary. No engine is made, no daemon is forked.
        const workflow = yield* sessionService
          .createWorkflow({
            name: ctx.payload.name,
            chatSessionId: ctx.payload.chatSessionId,
            config,
          })
          .pipe(
            Effect.catchIf(
              (error): error is WorkflowConfigValidationError => error instanceof WorkflowConfigValidationError,
              (error) => new DagValidationError({ name: "DagValidationError", data: { message: error.message } }),
            ),
          )
        for (const cfg of config.nodes) {
          yield* sessionService.createNode({
            workflowId: workflow.id,
            nodeId: `${workflow.id}::${cfg.id}`,
            name: cfg.name,
            nodeName: cfg.name,
            nodeType: cfg.worker_type,
            config: cfg,
            dependencyNodes: cfg.dependencies.map((d) => `${workflow.id}::${d}`),
            timeoutMs: cfg.timeout_ms,
            maxRetries: cfg.retry?.max_attempts ?? 0,
          })
        }
        return { workflowId: workflow.id, nodeCount: config.nodes.length, status: "pending" }
      },
    )

    return handlers
      .handle("pause", pause)
      .handle("resume", resume)
      .handle("cancel", cancel)
      .handle("step", step)
      .handle("start", start)
      .handle("replan", replan)
      .handle("replanPreview", replanPreview)
      .handle("create", create)
  }),
)
