/**
 * DAG HttpApi Group — Read-only endpoints for DAG workflow inspection.
 *
 * Architecture: §9.a read-only forwarding, no state mutation.
 */

import { Schema } from "effect"
import { DAG_VIOLATION_TYPES } from "@/dag/session/types"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/dag"

// ============================================================================
// Response Schemas (for OpenAPI / SDK generation)
// ============================================================================

export const DagWorkflowStatus = Schema.Literals(["pending", "running", "completed", "failed", "cancelled", "paused"])

export const DagNodeStatus = Schema.Literals(["pending", "queued", "running", "completed", "failed", "skipped"])

export const DagNodeError = Schema.Struct({
  type: Schema.String,
  message: Schema.String,
  details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  retryable: Schema.Boolean,
}).annotate({ identifier: "DagNodeError" })

export const DagNodeMetrics = Schema.Struct({
  cpu_percent: Schema.optional(Schema.Number),
  memory_mb: Schema.optional(Schema.Number),
  disk_io_mb: Schema.optional(Schema.Number),
  network_io_mb: Schema.optional(Schema.Number),
}).annotate({ identifier: "DagNodeMetrics" })

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
  error_info: Schema.optional(DagNodeError),
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
  logs: Schema.optional(Schema.Array(Schema.String)),
  metrics: Schema.optional(DagNodeMetrics),
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
  type: Schema.Literals(DAG_VIOLATION_TYPES),
  severity: Schema.Literals(["info", "warning", "error", "critical"]),
  message: Schema.String,
  timestamp: Schema.String,
  details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}).annotate({ identifier: "DagViolation" })

export const DagWorkflowHistoryResponse = Schema.Struct({
  history_id: Schema.String,
  workflow_id: Schema.String,
  chat_session_id: Schema.String,
  action: Schema.String,
  old_state: Schema.Unknown,
  new_state: Schema.Unknown,
  change_details: Schema.Unknown,
  changed_by: Schema.NullOr(Schema.String),
  created_at: Schema.String,
}).annotate({ identifier: "DagWorkflowHistoryResponse" })

export const DagNodeLogResponse = Schema.Struct({
  log_id: Schema.String,
  node_id: Schema.String,
  workflow_id: Schema.String,
  chat_session_id: Schema.String,
  log_level: Schema.String,
  log_message: Schema.String,
  log_data: Schema.Unknown,
  execution_phase: Schema.NullOr(Schema.String),
  created_at: Schema.String,
}).annotate({ identifier: "DagNodeLogResponse" })

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
    HttpApiEndpoint.get("getWorkflowHistory", `${root}/workflows/:workflowId/history`, {
      params: { workflowId: Schema.String },
      headers: Schema.Struct({
        limit: Schema.optional(Schema.NumberFromString),
      }),
      success: described(Schema.Array(DagWorkflowHistoryResponse), "DAG workflow history (newest first)"),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "dag.getWorkflowHistory",
        summary: "Get DAG workflow history",
        description: "Retrieve replan audit-trail records for a DAG workflow.",
      }),
    ),
    HttpApiEndpoint.get("getNodeLogs", `${root}/nodes/:nodeId/logs`, {
      params: { nodeId: Schema.String },
      headers: Schema.Struct({
        limit: Schema.optional(Schema.NumberFromString),
      }),
      success: described(Schema.Array(DagNodeLogResponse), "DAG node execution logs (newest first)"),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "dag.getNodeLogs",
        summary: "Get DAG node logs",
        description: "Retrieve structured execution logs for a DAG node.",
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
