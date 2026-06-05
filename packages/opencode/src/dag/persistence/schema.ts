// Type-safe schema definition using drizzle-orm
import { sqliteTable, text, integer, blob } from "drizzle-orm/sqlite-core"

// ============================================================================
// DAG Workflow Table
// ============================================================================
export const dagWorkflows = sqliteTable("dag_workflow", {
  workflow_id: text("workflow_id").primaryKey(),
  chat_session_id: text("chat_session_id").notNull(),
  name: text("name").notNull(),
  config: text("config", { mode: "json" }),
  status: text("status").notNull().default("pending"),
  current_progress: text("current_progress", { mode: "json" }),
  metadata: text("metadata", { mode: "json" }),
  created_at: integer("created_at").notNull(),
  updated_at: integer("updated_at").notNull(),
  started_at: integer("started_at"),
  completed_at: integer("completed_at"),
})

// ============================================================================
// DAG Node Table
// ============================================================================
export const dagNodes = sqliteTable("dag_node", {
  node_id: text("node_id").primaryKey(),
  workflow_id: text("workflow_id").notNull(),
  config: text("config", { mode: "json" }).notNull(),
  status: text("status").notNull().default("pending"),
  output: text("output", { mode: "json" }),
  error_info: text("error_info", { mode: "json" }),
  retry_count: integer("retry_count").notNull().default(0),
  max_retries: integer("max_retries").notNull().default(3),
  timeout_ms: integer("timeout_ms"),
  required_nodes: text("required_nodes", { mode: "json" }),
  dependencies: text("dependencies", { mode: "json" }),
  metadata: text("metadata", { mode: "json" }),
  start_time: integer("start_time"),
  end_time: integer("end_time"),
  parent_node: text("parent_node"),
  duration_ms: integer("duration_ms"),
  created_at: integer("created_at").notNull(),
  updated_at: integer("updated_at").notNull(),
  completed_at: integer("completed_at"),
})

// ============================================================================
// DAG Violation Table
// ============================================================================
export const dagViolations = sqliteTable("dag_violation", {
  violation_id: text("violation_id").primaryKey(),
  workflow_id: text("workflow_id").notNull(),
  chat_session_id: text("chat_session_id"),
  node_id: text("node_id"),
  violation_type: text("violation_type").notNull(),
  severity: text("severity").notNull(),
  message: text("message").notNull(),
  details: text("details", { mode: "json" }),
  created_at: integer("created_at").notNull(),
})

// ============================================================================
// DAG Workflow History Table
// ============================================================================
export const dagWorkflowHistory = sqliteTable("dag_workflow_history", {
  history_id: text().primaryKey(),
  workflow_id: text().notNull(),
  chat_session_id: text().notNull(),
  action: text().notNull(),
  old_state: text({ mode: "json" }),
  new_state: text({ mode: "json" }),
  change_details: text({ mode: "json" }),
  changed_by: text(),
  created_at: integer().notNull(),
})

// ============================================================================
// DAG Node Execution Log Table
// ============================================================================
export const dagNodeLogs = sqliteTable("dag_node_log", {
  log_id: text().primaryKey(),
  node_id: text().notNull(),
  workflow_id: text().notNull(),
  chat_session_id: text().notNull(),
  log_level: text().notNull(),
  log_message: text().notNull(),
  log_data: text({ mode: "json" }),
  execution_phase: text(),
  created_at: integer().notNull(),
})

// ============================================================================
// Schema Version Table
// ============================================================================
export const dagSchemaVersions = sqliteTable("dag_schema_version", {
  version: integer().primaryKey(),
  applied_at: integer().notNull(),
  description: text(),
})

// ============================================================================
// Table Relations
// (Relations are handled via JOIN queries, not ORM relations config)
// ============================================================================

// ============================================================================
// Type Exports
// ============================================================================
export type DagWorkflow = typeof dagWorkflows.$inferSelect
export type NewDagWorkflow = typeof dagWorkflows.$inferInsert

export type DagNode = typeof dagNodes.$inferSelect
export type NewDagNode = typeof dagNodes.$inferInsert

export type DagViolation = typeof dagViolations.$inferSelect
export type NewDagViolation = typeof dagViolations.$inferInsert

export type DagWorkflowHistory = typeof dagWorkflowHistory.$inferSelect
export type NewDagWorkflowHistory = typeof dagWorkflowHistory.$inferInsert

export type DagNodeLog = typeof dagNodeLogs.$inferSelect
export type NewDagNodeLog = typeof dagNodeLogs.$inferInsert

export type DagSchemaVersion = typeof dagSchemaVersions.$inferSelect
export type NewDagSchemaVersion = typeof dagSchemaVersions.$inferInsert
