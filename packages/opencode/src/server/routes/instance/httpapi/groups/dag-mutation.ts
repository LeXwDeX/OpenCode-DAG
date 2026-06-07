/**
 * DAG Mutation HttpApi Group — State-changing endpoints for DAG workflow control.
 *
 * Architecture: §9/§10 read-only vs Mutation route separation.
 */

import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
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
