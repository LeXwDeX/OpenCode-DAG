// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

// Type-safe schema definition using drizzle-orm
import { sqliteTable, text, integer, blob } from "drizzle-orm/sqlite-core"

// ============================================================================
// DAG Workflow Table
// ============================================================================
export const dagWorkflows = sqliteTable("dag_workflow", {
  workflow_id: text().primaryKey(),
  chat_session_id: text().notNull(),
  name: text().notNull(),
  config: text({ mode: "json" }),
  status: text().notNull().default("pending"),
  current_progress: text({ mode: "json" }),
  metadata: text({ mode: "json" }),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
  started_at: integer(),
  completed_at: integer(),
  paused_at: integer(),
  resumed_at: integer(),
})

// ============================================================================
// DAG Node Table
// ============================================================================
export const dagNodes = sqliteTable("dag_node", {
  node_id: text().primaryKey(),
  workflow_id: text().notNull(),
  config: text({ mode: "json" }).notNull(),
  status: text().notNull().default("pending"),
  output: text({ mode: "json" }),
  error_info: text({ mode: "json" }),
  retry_count: integer().notNull().default(0),
  max_retries: integer().notNull().default(3),
  timeout_ms: integer(),
  required_nodes: text({ mode: "json" }),
  dependencies: text({ mode: "json" }),
  metadata: text({ mode: "json" }),
  start_time: integer(),
  end_time: integer(),
  parent_node: text(),
  duration_ms: integer(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
  completed_at: integer(),
})

// ============================================================================
// DAG Violation Table
// ============================================================================
export const dagViolations = sqliteTable("dag_violation", {
  violation_id: text().primaryKey(),
  workflow_id: text().notNull(),
  chat_session_id: text(),
  node_id: text(),
  violation_type: text().notNull(),
  severity: text().notNull(),
  message: text().notNull(),
  details: text({ mode: "json" }),
  created_at: integer().notNull(),
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
