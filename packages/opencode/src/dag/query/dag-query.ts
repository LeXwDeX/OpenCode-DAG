// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

import type {
  IDAGQuery,
  ExecutionTimeline,
  TimelineEvent,
  NodeExecutionTime,
  GraphStatistics,
  NodeDependency,
  WorkflowStatistics,
  DAGWorkflowHistoryResponse,
  DAGNodeLogResponse,
} from './query-types';
import type { DAGWorkflowSession, DAGNodeStatus, DAGNodeSession, DAGViolation } from '../session/types';
import type { IDAGSessionService } from '../session/session-service';
import type { DagWorkflowHistory, DagNodeLog } from '../persistence/schema';
import { Effect } from 'effect';

/**
 * DAG Query 实现
 *
 * 提供灵活的 DAG 图查询能力
 */
export class DAGQuery implements IDAGQuery {
  constructor(private sessionService: IDAGSessionService) {}

  /**
   * 列出所有工作流
   */
  async listWorkflows(): Promise<DAGWorkflowSession[]> {
    const program = this.sessionService.listAllWorkflows();
    const result = await Effect.runPromise(program);
    return result;
  }

  /**
   * 获取工作流详情
   */
  async getWorkflow(id: string): Promise<DAGWorkflowSession | null> {
    const program = this.sessionService.getWorkflow(id);
    const result = await Effect.runPromise(program);
    return result ?? null;
  }

  /**
   * 获取节点的执行状态
   */
  async getNodeStatus(nodeId: string): Promise<DAGNodeStatus | null> {
    const program = this.sessionService.getNode(nodeId);
    const result = await Effect.runPromise(program);
    return result?.status ?? null;
  }

  /**
   * 获取工作流下所有节点
   */
  async getNodes(workflowId: string): Promise<DAGNodeSession[]> {
    const program = this.sessionService.listNodes(workflowId);
    return Effect.runPromise(program);
  }

  /**
   * 获取工作流的执行时间线
   */
  async getExecutionTimeline(workflowId: string): Promise<ExecutionTimeline> {
    const workflow = await this.getWorkflow(workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    const nodes = await this.getNodes(workflowId);
    const events: TimelineEvent[] = [];
    const nodeExecutionTimes: Record<string, NodeExecutionTime> = {};

    for (const node of nodes) {
      const startTime = node.start_time;
      const endTime = node.end_time ?? (node.completed_at ?? null);

      if (startTime != null) {
        events.push({
          type: 'node_start',
          nodeId: node.node_id,
          timestamp: startTime,
        });
      }

      if (endTime != null) {
        const eventType: TimelineEvent['type'] = node.status === 'failed' ? 'node_failed' : 'node_complete';
        events.push({
          type: eventType,
          nodeId: node.node_id,
          timestamp: endTime,
          duration: startTime != null ? endTime - startTime : undefined,
        });
      }

      nodeExecutionTimes[node.node_id] = {
        nodeId: node.node_id,
        nodeName: node.config.name,
        startTime: startTime ?? 0,
        endTime: endTime ?? 0,
        duration: startTime != null && endTime != null ? endTime - startTime : 0,
        status: node.status === 'queued' ? 'running' : node.status as NodeExecutionTime['status'],
      };
    }

    events.sort((a, b) => a.timestamp - b.timestamp);

    const startTime = workflow.start_time;
    const endTime = workflow.end_time;
    const totalDuration = endTime != null ? endTime - startTime : Date.now() - startTime;

    return {
      workflowId,
      startTime,
      endTime,
      events,
      totalDuration,
      nodeExecutionTimes,
    };
  }

  /**
   * 按状态过滤工作流
   */
  async listWorkflowsByStatus(status: 'pending' | 'running' | 'completed' | 'failed'): Promise<DAGWorkflowSession[]> {
    const workflows = await this.listWorkflows();
    return workflows.filter(w => w.status === status);
  }

  /**
   * 按 chat_session_id 列出工作流
   */
  async listWorkflowsByChatSession(chatSessionId: string): Promise<DAGWorkflowSession[]> {
    return Effect.runPromise(this.sessionService.listWorkflowsByChatSession(chatSessionId))
  }

  /**
   * 列出指定工作流的所有违规记录
   */
  async listViolations(workflowId: string): Promise<DAGViolation[]> {
    return Effect.runPromise(this.sessionService.listViolations(workflowId))
  }

  /**
   * 搜索工作流
   */
  async searchWorkflows(query: string): Promise<DAGWorkflowSession[]> {
    const workflows = await this.listWorkflows();
    const lowerQuery = query.toLowerCase();

    return workflows.filter(w =>
      w.config.name.toLowerCase().includes(lowerQuery) ||
      (w.config.description && w.config.description.toLowerCase().includes(lowerQuery))
    );
  }

  /**
   * 获取图结构统计
   */
  async getGraphStatistics(workflowId: string): Promise<GraphStatistics> {
    const workflow = await this.getWorkflow(workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    const nodes = await this.getNodes(workflowId);

    const totalNodes = nodes.length;
    const totalEdges = nodes.reduce((acc, node) => acc + node.dependencies.length, 0);

    const criticalPathLength = this.calculateCriticalPathLength(nodes);

    const parallelismDegree = Math.min(
      workflow.config.max_concurrency,
      nodes.filter(n => n.status === 'running' || n.status === 'pending').length
    );

    const completedNodes = nodes.filter(n => n.completed_at != null);
    const avgNodeTime = completedNodes.length > 0
      ? completedNodes.reduce((acc, n) => {
          const start = n.start_time ?? 0;
          const end = n.completed_at ?? 0;
          return acc + (end - start);
        }, 0) / completedNodes.length
      : 0;

    const pendingNodes = nodes.filter(n => n.status === 'pending' || n.status === 'running').length;
    const estimatedCompletionTime = parallelismDegree > 0 ? (avgNodeTime * pendingNodes) / parallelismDegree : 0;

    return {
      totalNodes,
      totalEdges,
      criticalPathLength,
      parallelismDegree,
      estimatedCompletionTime
    };
  }

  /**
   * 获取节点依赖关系
   */
  async getNodeDependencies(workflowId: string): Promise<NodeDependency[]> {
    const nodes = await this.getNodes(workflowId);

    const dependencies: NodeDependency[] = [];

    for (const node of nodes) {
      const dependents = nodes.filter(n => n.dependencies.includes(node.node_id));

      dependencies.push({
        nodeId: node.node_id,
        nodeName: node.config.name,
        dependencies: node.dependencies,
        dependents: dependents.map(d => d.node_id),
        status: node.status,
        completedAt: node.completed_at ?? undefined
      });
    }

    return dependencies;
  }

  /**
   * 获取工作流执行统计
   */
  async getWorkflowStatistics(workflowId: string): Promise<WorkflowStatistics> {
    const workflow = await this.getWorkflow(workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    const nodes = await this.getNodes(workflowId);

    const totalNodes = nodes.length;
    const completedNodes = nodes.filter(n => n.status === 'completed').length;
    const pendingNodes = nodes.filter(n => n.status === 'pending').length;
    const failedNodes = nodes.filter(n => n.status === 'failed').length;
    const currentRunning = nodes.filter(n => n.status === 'running').length;

    const completedNodesWithTime = nodes.filter(n => n.completed_at != null && n.completed_at > 0);
    const averageNodeDuration = completedNodesWithTime.length > 0
      ? completedNodesWithTime.reduce((acc, n) => {
          const start = n.start_time ?? 0;
          const end = n.completed_at ?? 0;
          return acc + (end - start);
        }, 0) / completedNodesWithTime.length
      : 0;

    const startTime = workflow.start_time;
    const currentTime = Date.now();
    const totalElapsedTime = startTime ? (currentTime - startTime) / 1000 : 0;

    return {
      workflowId,
      totalNodes,
      completedNodes,
      pendingNodes,
      failedNodes,
      currentRunning,
      averageNodeDuration,
      totalElapsedTime
    };
  }

  /**
   * 列出工作流的历史变更记录
   */
  async listHistory(workflowId: string, limit?: number): Promise<DAGWorkflowHistoryResponse[]> {
    const rows = await Effect.runPromise(this.sessionService.listHistory(workflowId, limit))
    return rows.map(toHistoryResponse)
  }

  /**
   * 列出节点的执行日志
   */
  async listNodeLogs(nodeId: string, limit?: number): Promise<DAGNodeLogResponse[]> {
    const rows = await Effect.runPromise(this.sessionService.listNodeLogs(nodeId, limit))
    return rows.map(toLogResponse)
  }

  /**
   * 计算图的关键路径长度（最长路径）
   */
  private calculateCriticalPathLength(nodes: DAGNodeSession[]): number {
    const nodeMap = new Map(nodes.map(n => [n.node_id, n]));
    const memo = new Map<string, number>();

    const getLongestPath = (nodeId: string): number => {
      if (memo.has(nodeId)) {
        return memo.get(nodeId)!;
      }

      const node = nodeMap.get(nodeId);
      if (!node) return 0;

      if (node.dependencies.length === 0) {
        const start = node.start_time ?? 0;
        const end = node.completed_at ?? 0;
        const duration = node.completed_at ? end - start : 0;
        memo.set(nodeId, duration);
        return duration;
      }

      let maxLength = 0;
      for (const depId of node.dependencies) {
        const depLength = getLongestPath(depId);
        maxLength = Math.max(maxLength, depLength);
      }

      const start = node.start_time ?? 0;
      const end = node.completed_at ?? 0;
      const nodeDuration = node.completed_at ? end - start : 0;
      const totalLength = maxLength + nodeDuration;

      memo.set(nodeId, totalLength);
      return totalLength;
    };

    let maxPathLength = 0;
    for (const node of nodes) {
      const pathLength = getLongestPath(node.node_id);
      maxPathLength = Math.max(maxPathLength, pathLength);
    }

    return maxPathLength / 1000;
  }
}

// ============================================================================
// Helpers: DB row → response mapping
// ============================================================================

function toHistoryResponse(row: DagWorkflowHistory): DAGWorkflowHistoryResponse {
  return {
    history_id: row.history_id,
    workflow_id: row.workflow_id,
    chat_session_id: row.chat_session_id,
    action: row.action,
    old_state: row.old_state,
    new_state: row.new_state,
    change_details: row.change_details,
    changed_by: row.changed_by,
    created_at: new Date(row.created_at).toISOString(),
  }
}

function toLogResponse(row: DagNodeLog): DAGNodeLogResponse {
  return {
    log_id: row.log_id,
    node_id: row.node_id,
    workflow_id: row.workflow_id,
    chat_session_id: row.chat_session_id,
    log_level: row.log_level,
    log_message: row.log_message,
    log_data: row.log_data,
    execution_phase: row.execution_phase,
    created_at: new Date(row.created_at).toISOString(),
  }
}
