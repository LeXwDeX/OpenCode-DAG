/**
 * DAG Mutation HttpApi Group — State-changing endpoints for DAG workflow control.
 *
 * Architecture: §9/§10 read-only vs Mutation route separation.
 */

import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
// Public JSON error contract — domain WorkflowConfigValidationError is translated to
// this explicit Schema.ErrorClass at the create handler boundary (see httpapi/AGENTS.md).
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/dag"

// ============================================================================
// Route Group
// ============================================================================

const WorkflowIdParams = Schema.Struct({
  workflowId: Schema.String,
})

const WorkflowIdQuery = Schema.Struct(WorkspaceRoutingQueryFields)

const PauseResponse = Schema.Struct({
  status: Schema.String,
}).annotate({ identifier: "DagPauseResponse" })

const ResumeResponse = Schema.Struct({
  status: Schema.String,
}).annotate({ identifier: "DagResumeResponse" })

const CancelResponse = Schema.Struct({
  status: Schema.String,
}).annotate({ identifier: "DagCancelResponse" })

const StartResponse = Schema.Struct({
  status: Schema.String,
}).annotate({ identifier: "DagStartResponse" })

// P2-B: Step result — executes a single ready node under a paused workflow.
// Discriminated union on `ok` for type-safe consumption by SDK clients.
const StepResponse = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    node_id: Schema.String,
    status: Schema.Literal("completed"),
    output: Schema.Unknown,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    reason: Schema.String,
    workflow_status: Schema.optional(Schema.String),
    node_id: Schema.optional(Schema.String),
    error: Schema.optional(Schema.String),
  }),
]).annotate({ identifier: "DagStepResponse" })

// Replan patch body. add_nodes/update_nodes are kept permissive (Schema.Unknown elements):
// DAGNodeConfig is structurally rich and the engine re-validates via validateReplanPostConfig.
const ReplanPatchBody = Schema.Struct({
  add_nodes: Schema.optional(Schema.Array(Schema.Unknown)),
  remove_nodes: Schema.optional(Schema.Array(Schema.String)),
  update_nodes: Schema.optional(Schema.Array(Schema.Unknown)),
  new_max_concurrency: Schema.optional(Schema.Number),
  changed_by: Schema.optional(Schema.String),
}).annotate({ identifier: "DagReplanPatchBody" })

// ReplanResult union: {ok:true,...} on success | {ok:false,reason} when refused
// (engine-missing returns {ok:false, reason:"not_running"} without touching atomicReplan).
const ReplanResultResponse = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    workflow_id: Schema.String,
    history_id: Schema.String,
    nodes_added: Schema.Number,
    nodes_removed: Schema.Number,
    nodes_updated: Schema.Number,
    final_total: Schema.Number,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    reason: Schema.String,
    detail: Schema.optional(Schema.Unknown),
  }),
]).annotate({ identifier: "DagReplanResultResponse" })

const ReplanPreviewResponse = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    workflow_id: Schema.String,
    pre: Schema.Struct({
      config: Schema.Unknown,
      node_ids: Schema.Array(Schema.String),
      max_concurrency: Schema.Number,
      total_nodes: Schema.Number,
    }),
    post: Schema.Struct({
      config: Schema.Unknown,
      node_ids: Schema.Array(Schema.String),
      max_concurrency: Schema.Number,
      total_nodes: Schema.Number,
    }),
    delta: Schema.Struct({
      nodes_added: Schema.Number,
      nodes_removed: Schema.Number,
      nodes_updated: Schema.Number,
      final_total: Schema.Number,
      max_concurrency_changed: Schema.Boolean,
    }),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    reason: Schema.String,
    detail: Schema.optional(Schema.Unknown),
  }),
]).annotate({ identifier: "DagReplanPreviewResponse" })

// config is kept permissive — session-service createWorkflow runs
// validateWorkflowConfigLimits + RequiredNodesValidator at the entry point.
const CreateWorkflowBody = Schema.Struct({
  name: Schema.String,
  chatSessionId: Schema.String,
  config: Schema.Unknown,
}).annotate({ identifier: "DagCreateWorkflowBody" })

const CreateWorkflowResponse = Schema.Struct({
  workflowId: Schema.String,
  nodeCount: Schema.Number,
  status: Schema.String,
}).annotate({ identifier: "DagCreateWorkflowResponse" })

export class DagValidationError extends Schema.ErrorClass<DagValidationError>("DagValidationError")(
  {
    name: Schema.Literal("DagValidationError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 400 },
) {}

const dagMutationGroup = HttpApiGroup.make("dag-mutation")
  .add(
    HttpApiEndpoint.post("pause", `${root}/workflows/:workflowId/pause`, {
      params: WorkflowIdParams,
      query: WorkflowIdQuery,
      success: described(PauseResponse, "Workflow pause confirmation"),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "dag-mutation.pause",
        summary: "Pause a running DAG workflow",
        description: "Pauses the DAG workflow. In-flight nodes continue; new nodes are not spawned until resumed.",
      }),
    ),
    HttpApiEndpoint.post("resume", `${root}/workflows/:workflowId/resume`, {
      params: WorkflowIdParams,
      query: WorkflowIdQuery,
      success: described(ResumeResponse, "Workflow resume confirmation"),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "dag-mutation.resume",
        summary: "Resume a paused DAG workflow",
        description: "Resumes the DAG workflow from paused state, triggering scheduleReadyNodes for pending nodes.",
      }),
    ),
    HttpApiEndpoint.post("cancel", `${root}/workflows/:workflowId/cancel`, {
      params: WorkflowIdParams,
      query: WorkflowIdQuery,
      success: described(CancelResponse, "Workflow cancel confirmation"),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "dag-mutation.cancel",
        summary: "Cancel a DAG workflow",
        description:
          "Cancels the DAG workflow. When no in-memory engine exists, the status is downgraded via sessionService.updateWorkflowStatus(cancelled); an already-terminal workflow returns its current status idempotently (no 500).",
      }),
    ),
    HttpApiEndpoint.post("step", `${root}/workflows/:workflowId/step`, {
      params: WorkflowIdParams,
      query: WorkflowIdQuery,
      success: described(StepResponse, "Workflow step result — one node executed to completion or failure"),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "dag-mutation.step",
        summary: "Step a paused DAG workflow (execute 1 ready node)",
        description:
          "Executes exactly one ready node to completion or failure while the workflow remains paused. Returns not_paused if the workflow isn't paused, or no_ready_nodes if no pending nodes with satisfied dependencies exist.",
      }),
    ),
    HttpApiEndpoint.post("start", `${root}/workflows/:workflowId/start`, {
      params: WorkflowIdParams,
      query: WorkflowIdQuery,
      success: described(StartResponse, "Workflow start confirmation"),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "dag-mutation.start",
        summary: "Start an existing pending DAG workflow",
        description:
          "Starts an existing pending workflow without creating workflow or node rows. Non-pending workflows return their current status.",
      }),
    ),
    HttpApiEndpoint.post("replan", `${root}/workflows/:workflowId/replan`, {
      params: WorkflowIdParams,
      query: WorkflowIdQuery,
      payload: ReplanPatchBody,
      success: described(ReplanResultResponse, "Workflow replan result"),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "dag-mutation.replan",
        summary: "Replan a running DAG workflow",
        description:
          "Mutates a running DAG workflow's node set. When no in-memory engine exists, returns {ok:false, reason:'not_running'} without touching persistence.",
      }),
    ),
    HttpApiEndpoint.post("replanPreview", `${root}/workflows/:workflowId/replan/preview`, {
      params: WorkflowIdParams,
      query: WorkflowIdQuery,
      payload: ReplanPatchBody,
      success: described(ReplanPreviewResponse, "Workflow replan preview result"),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "dag-mutation.replanPreview",
        summary: "Preview a DAG workflow replan",
        description:
          "Dry-runs a running DAG workflow replan and returns pre/post/delta without touching persistence, history, runtime registries, or events.",
      }),
    ),
    HttpApiEndpoint.post("create", `${root}/workflows/create`, {
      query: WorkflowIdQuery,
      payload: CreateWorkflowBody,
      success: described(CreateWorkflowResponse, "Workflow created"),
      error: DagValidationError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "dag-mutation.create",
        summary: "Create a DAG workflow",
        description:
          "Creates a DAG workflow and persists its nodes. Status stays pending — no engine is made, no daemon is forked. Config-limit violations are translated to a 400 DagValidationError.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "dag-mutation",
      description: "State-changing DAG workflow control routes.",
    }),
  )
  .middleware(InstanceContextMiddleware)
  .middleware(WorkspaceRoutingMiddleware)
  .middleware(Authorization)

export const DagMutationApi = HttpApi.make("dag-mutation")
  .add(dagMutationGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode DAG Mutation HttpApi",
      version: "0.0.1",
      description: "Mutation HttpApi surface for DAG workflow control routes.",
    }),
  )
