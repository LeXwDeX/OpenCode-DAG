// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * DAG Query Types
 * 
 * 定义 DAG 查询相关的类型接口
 */

import type { DAGWorkflowSession, DAGNodeStatus, DAGViolation } from '../session/types'

/**
 * DAG 查询接口
 */
export interface IDAGQuery {
  /**
   * 列出所有工作流
   */
  listWorkflows(): Promise<DAGWorkflowSession[]>
  
  /**
   * 获取工作流详情
   */
  getWorkflow(id: string): Promise<DAGWorkflowSession | null>
  
  /**
   * 获取节点的执行状态
   */
  getNodeStatus(nodeId: string): Promise<DAGNodeStatus | null>
  
  /**
   * 获取工作流的执行时间线
   */
  getExecutionTimeline(workflowId: string): Promise<ExecutionTimeline>
  
  /**
   * 按状态过滤工作流
   */
  listWorkflowsByStatus(status: 'pending' | 'running' | 'completed' | 'failed'): Promise<DAGWorkflowSession[]>
  
  /**
   * 搜索工作流（通过名称或描述）
   */
  searchWorkflows(query: string): Promise<DAGWorkflowSession[]>

  /**
   * 按 chat_session_id 列出工作流
   *
   * 用于在平台 Chat Session 上下文中查找关联的 DAG 工作流。
   */
  listWorkflowsByChatSession(chatSessionId: string): Promise<DAGWorkflowSession[]>

  /**
   * 列出指定工作流的所有违规记录
   */
  listViolations(workflowId: string): Promise<DAGViolation[]>

  /**
   * 列出工作流的历史变更记录（replan 审计链）
   */
  listHistory(workflowId: string, limit?: number): Promise<DAGWorkflowHistoryResponse[]>

  /**
   * 列出节点的执行日志
   */
  listNodeLogs(nodeId: string, limit?: number): Promise<DAGNodeLogResponse[]>
}

/**
 * Workflow history response — formatted DB row with ISO timestamps
 */
export interface DAGWorkflowHistoryResponse {
  history_id: string
  workflow_id: string
  chat_session_id: string
  action: string
  old_state: unknown
  new_state: unknown
  change_details: unknown
  changed_by: string | null
  created_at: string
}

/**
 * Node log response — formatted DB row with ISO timestamps
 */
export interface DAGNodeLogResponse {
  log_id: string
  node_id: string
  workflow_id: string
  chat_session_id: string
  log_level: string
  log_message: string
  log_data: unknown
  execution_phase: string | null
  created_at: string
}

/**
 * 执行时间线事件
 */
export interface TimelineEvent {
  type: 'node_start' | 'node_complete' | 'node_failed' | 'edge_traversal'
  nodeId: string
  timestamp: number
  duration?: number
  metadata?: Record<string, unknown>
}

/**
 * 执行时间线
 */
export interface ExecutionTimeline {
  workflowId: string
  startTime: number
  endTime: number | null
  events: TimelineEvent[]
  totalDuration: number
  nodeExecutionTimes: Record<string, NodeExecutionTime>
}

/**
 * 节点执行时间统计
 */
export interface NodeExecutionTime {
  nodeId: string
  nodeName: string
  startTime: number
  endTime: number
  duration: number
  status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'recoverable'
}

/**
 * 图结构统计
 */
export interface GraphStatistics {
  totalNodes: number
  totalEdges: number
  criticalPathLength: number
  parallelismDegree: number
  estimatedCompletionTime: number
}

/**
 * 节点依赖关系
 */
export interface NodeDependency {
  nodeId: string
  nodeName: string
  dependencies: string[]
  dependents: string[]
  status: DAGNodeStatus
  completedAt?: number
}

/**
 * 工作流执行统计
 */
export interface WorkflowStatistics {
  workflowId: string
  totalNodes: number
  completedNodes: number
  pendingNodes: number
  failedNodes: number
  recoverable: number
  currentRunning: number
  averageNodeDuration: number
  totalElapsedTime: number
}

// RESERVED INTERNAL PROBE surface (D-PROBE-RESERVE) — re-exported so probe-types
// is anchored into the query barrel (防孤儿：使 probe-types 非零引用). 不对外暴露给 AGENT。
export type { IDAGProbe, NodeBlockReason, TopologyLayer, TopologySnapshot, ExecutionSnapshot, CascadeImpact } from './probe-types'