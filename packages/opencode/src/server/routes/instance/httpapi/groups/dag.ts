/**
 * DAG HttpApi Group — Read-only endpoints for DAG workflow inspection.
 *
 * Architecture: §9.a read-only forwarding, no state mutation.
 */

import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/dag"

// ============================================================================
// Response Schemas (for OpenAPI / SDK generation)
// ============================================================================

export const DagWorkflowStatus = Schema.Literals(["pending", "running", "completed", "failed", "cancelled"])

export const DagNodeStatus = Schema.Literals(["pending", "queued", "running", "completed", "failed", "skipped"])

export const DagWorkflow = Schema.Struct({
  id: Schema.String,
  chat_session_id: Schema.String,
  config: Schema.Unknown,
  status: DagWorkflowStatus,
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  start_time: Schema.Number,
  end_time: Schema.NullOr(Schema.Number),
  current_node: Schema.NullOr(Schema.String),
  created_at: Schema.Number,
  updated_at: Schema.Number,
  completed_at: Schema.NullOr(Schema.Number),
  duration_ms: Schema.NullOr(Schema.Number),
}).annotate({ identifier: "DagWorkflow" })

export const DagNode = Schema.Struct({
  node_id: Schema.String,
  workflow_id: Schema.String,
  config: Schema.Unknown,
  status: DagNodeStatus,
  output: Schema.NullOr(Schema.Unknown),
  retry_count: Schema.Number,
  max_retries: Schema.Number,
  timeout_ms: Schema.Number,
  required_nodes: Schema.Array(Schema.String),
  dependencies: Schema.Array(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  start_time: Schema.NullOr(Schema.Number),
  completed_at: Schema.NullOr(Schema.String),
  end_time: Schema.NullOr(Schema.Number),
  duration_ms: Schema.NullOr(Schema.Number),
  parent_node: Schema.NullOr(Schema.String),
  created_at: Schema.Number,
  updated_at: Schema.Number,
}).annotate({ identifier: "DagNode" })

export const DagWorkflowDetail = Schema.Struct({
  workflow: Schema.NullOr(DagWorkflow),
  nodes: Schema.Array(DagNode),
}).annotate({ identifier: "DagWorkflowDetail" })

export const DagTimelineEvent = Schema.Struct({
  type: Schema.Literals(["node_start", "node_complete", "node_failed", "edge_traversal"]),
  nodeId: Schema.String,
  timestamp: Schema.Number,
  duration: Schema.optional(Schema.Number),
}).annotate({ identifier: "DagTimelineEvent" })

export const DagNodeExecutionTime = Schema.Struct({
  nodeId: Schema.String,
  nodeName: Schema.String,
  startTime: Schema.Number,
  endTime: Schema.Number,
  duration: Schema.Number,
  status: DagNodeStatus,
}).annotate({ identifier: "DagNodeExecutionTime" })

export const DagTimeline = Schema.Struct({
  workflowId: Schema.String,
  startTime: Schema.Number,
  endTime: Schema.NullOr(Schema.Number),
  events: Schema.Array(DagTimelineEvent),
  totalDuration: Schema.Number,
  nodeExecutionTimes: Schema.Record(Schema.String, DagNodeExecutionTime),
}).annotate({ identifier: "DagTimeline" })

export const DagGraphStatistics = Schema.Struct({
  totalNodes: Schema.Number,
  totalEdges: Schema.Number,
  criticalPathLength: Schema.Number,
  parallelismDegree: Schema.Number,
  estimatedCompletionTime: Schema.Number,
}).annotate({ identifier: "DagGraphStatistics" })

export const DagViolation = Schema.Struct({
  id: Schema.String,
  workflowId: Schema.String,
  nodeId: Schema.optional(Schema.String),
  type: Schema.Literals([
    "required_node_skipped",
    "required_node_failed",
    "max_nodes_exceeded",
    "max_concurrency_exceeded",
    "timeout_exceeded",
  ]),
  severity: Schema.Literals(["info", "warning", "error", "critical"]),
  message: Schema.String,
  timestamp: Schema.String,
  details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}).annotate({ identifier: "DagViolation" })

// ============================================================================
// Queries
// ============================================================================

const ListWorkflowsQuery = Schema.Struct({
  chatSessionId: Schema.optional(Schema.String),
  ...WorkspaceRoutingQueryFields,
})

const WorkflowIdQuery = Schema.Struct(WorkspaceRoutingQueryFields)

// ============================================================================
// Route Group
// ============================================================================

const dagGroup = HttpApiGroup.make("dag")
  .add(
    HttpApiEndpoint.get("listWorkflows", `${root}/workflows`, {
      query: ListWorkflowsQuery,
      success: described(Schema.Array(DagWorkflow), "List of DAG workflows"),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "dag.listWorkflows",
        summary: "List DAG workflows",
        description: "List all DAG workflows, optionally filtered by chat session ID.",
      }),
    ),
    HttpApiEndpoint.get("getWorkflow", `${root}/workflows/:workflowId`, {
      params: { workflowId: Schema.String },
      query: WorkflowIdQuery,
      success: described(DagWorkflowDetail, "DAG workflow with its nodes"),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "dag.getWorkflow",
        summary: "Get DAG workflow detail",
        description: "Retrieve a single DAG workflow along with all its node sessions.",
      }),
    ),
    HttpApiEndpoint.get("getTimeline", `${root}/workflows/:workflowId/timeline`, {
      params: { workflowId: Schema.String },
      query: WorkflowIdQuery,
      success: described(DagTimeline, "DAG workflow execution timeline"),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "dag.getTimeline",
        summary: "Get DAG execution timeline",
        description: "Retrieve the execution timeline for a DAG workflow, including node start/end times.",
      }),
    ),
    HttpApiEndpoint.get("getStats", `${root}/workflows/:workflowId/stats`, {
      params: { workflowId: Schema.String },
      query: WorkflowIdQuery,
      success: described(DagGraphStatistics, "DAG workflow graph statistics"),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "dag.getStats",
        summary: "Get DAG graph statistics",
        description: "Retrieve graph-level statistics for a DAG workflow (node count, edges, critical path, parallelism).",
      }),
    ),
    HttpApiEndpoint.get("getViolations", `${root}/workflows/:workflowId/violations`, {
      params: { workflowId: Schema.String },
      query: WorkflowIdQuery,
      success: described(Schema.Array(DagViolation), "DAG workflow violations"),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "dag.getViolations",
        summary: "Get DAG violations",
        description: "Retrieve all recorded violations for a DAG workflow.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "dag",
      description: "Read-only DAG workflow inspection routes.",
    }),
  )
  .middleware(InstanceContextMiddleware)
  .middleware(WorkspaceRoutingMiddleware)
  .middleware(Authorization)

export const DagApi = HttpApi.make("dag")
  .add(dagGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for DAG workflow routes.",
    }),
  )
