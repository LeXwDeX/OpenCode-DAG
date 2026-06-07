// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * DAG Platform Bus 事件定义
 *
 * 将 DAG 内部 IEventBus 的 workflow / node 事件单向、只读翻译为平台 Bus 事件。
 *
 * 架构约束：
 * - §9.a 只读转发，禁止回写
 * - §9.b 事件命名翻译规则（dag.workflow.updated / dag.node.updated / dag.node.progress / dag.node.ask_main）
 * - §10 字段名固定 chat_session_id
 */

import { Schema } from "effect"
import { BusEvent } from "@/bus/bus-event"

// ============================================================================
// DAG Workflow/Node Status (string literal union for platform event payload)
// ============================================================================

export const DAGWorkflowStatusSchema = Schema.Literals([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "paused",
])

export const DAGNodeStatusSchema = Schema.Literals([
  "pending",
  "queued",
  "running",
  "completed",
  "failed",
  "skipped",
])

export const DAGStatusSchema = Schema.Union([DAGWorkflowStatusSchema, DAGNodeStatusSchema])

// ============================================================================
// Platform Bus Events
// ============================================================================

/**
 * DAG 工作流状态更新事件
 *
 * 翻译自 workflow.created / workflow.started / workflow.completed / workflow.failed / workflow.cancelled
 */
export const DagWorkflowUpdated = BusEvent.define(
  "dag.workflow.updated",
  Schema.Struct({
    workflowID: Schema.String,
    chatSessionID: Schema.optional(Schema.String),
    status: DAGWorkflowStatusSchema,
    timestamp: Schema.Number,
  }),
)

/**
 * DAG 节点状态更新事件
 *
 * 翻译自 node.started / node.completed / node.failed / node.paused / node.resumed / node.skipped / node.aborted
 */
export const DagNodeUpdated = BusEvent.define(
  "dag.node.updated",
  Schema.Struct({
    workflowID: Schema.String,
    nodeID: Schema.String,
    chatSessionID: Schema.optional(Schema.String),
    status: DAGNodeStatusSchema,
    timestamp: Schema.Number,
  }),
)

/**
 * DAG 节点进度事件
 *
 * 翻译自 node.progress
 */
export const DagNodeProgress = BusEvent.define(
  "dag.node.progress",
  Schema.Struct({
    workflowID: Schema.String,
    nodeID: Schema.String,
    chatSessionID: Schema.optional(Schema.String),
    progress: Schema.Unknown,
    timestamp: Schema.Number,
  }),
)

/**
 * DAG 节点向主会话提问事件
 *
 * 翻译自 node.ask_main
 */
export const DagNodeAskMain = BusEvent.define(
  "dag.node.ask_main",
  Schema.Struct({
    workflowID: Schema.String,
    nodeID: Schema.String,
    chatSessionID: Schema.optional(Schema.String),
    question: Schema.String,
    context: Schema.optional(Schema.String),
    timestamp: Schema.Number,
  }),
)

/**
 * DAG 工作流 replan 审计事件
 *
 * 翻译自 workflow.replanned — signals DAG topology was mutably changed
 * via atomicReplan. Independent event type (not routed through
 * dag.workflow.updated) so platform consumers can subscribe selectively.
 */
export const DagWorkflowReplanned = BusEvent.define(
  "dag.workflow.replanned",
  Schema.Struct({
    workflowID: Schema.String,
    chatSessionID: Schema.optional(Schema.String),
    patchSummary: Schema.Struct({
      added: Schema.Number,
      removed: Schema.Number,
      updated: Schema.Number,
      final_total: Schema.Number,
    }),
    timestamp: Schema.String,
  }),
)
