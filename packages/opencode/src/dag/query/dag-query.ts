import type {
  IDAGQuery,
  ExecutionTimeline,
  TimelineEvent,
  NodeExecutionTime,
  GraphStatistics,
  NodeDependency,
  WorkflowStatistics
} from './query-types';
import type { DAGWorkflowSession, DAGNodeStatus, DAGNodeSession } from '../session/types';
import { DAGSessionService } from '../session/session-service';
import { Effect } from 'effect';

/**
 * DAG Query 实现
 * 
 * 提供灵活的 DAG 图查询能力
 */
export class DAGQuery implements IDAGQuery {
  constructor(private sessionService: DAGSessionService) {}

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
   * 获取工作流的执行时间线
   */
  async getExecutionTimeline(workflowId: string): Promise<ExecutionTimeline> {
    const workflow = await this.getWorkflow(workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    const nodesProgram = this.sessionService.listNodes(workflowId);
    const nodes = await Effect.runPromise(nodesProgram);

    const events: TimelineEvent[] = [];
    const nodeExecutionTimes: Record<string, NodeExecutionTime> = {};

    // 构建时间线事件
    for (const node of nodes) {
      if (node.started_at) {
        events.push({
          type: 'node_start',
          nodeId: node.node_id,
          timestamp: node.started_at,
          metadata: { nodeName: node.config.name }
        });
      }

      if (node.completed_at) {
        events.push({
          type: 'node_complete',
          nodeId: node.node_id,
          timestamp: node.completed_at,
          duration: node.duration_ms,
          metadata: { nodeName: node.config.name, status: node.status }
        });

        nodeExecutionTimes[node.node_id] = {
          nodeId: node.node_id,
          nodeName: node.config.name,
          startTime: node.started_at || 0,
          endTime: node.completed_at,
          duration: (node.duration_ms || 0) / 1000,
          status: node.status as any
        };
      }
    }

    // 按时间排序
    events.sort((a, b) => a.timestamp - b.timestamp);

    const startTime = events.length > 0 ? events[0].timestamp : Date.now();
    const endTime = workflow.completed_at;
    const totalDuration = endTime ? (endTime - startTime) / 1000 : 0;

    return {
      workflowId,
      startTime,
      endTime,
      events,
      totalDuration,
      nodeExecutionTimes
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
   * 搜索工作流
   */
  async searchWorkflows(query: string): Promise<DAGWorkflowSession[]> {
    const workflows = await this.listWorkflows();
    const lowerQuery = query.toLowerCase();
    
    return workflows.filter(w => 
      w.name.toLowerCase().includes(lowerQuery) ||
      (w.description && w.description.toLowerCase().includes(lowerQuery))
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

    const nodesProgram = this.sessionService.listNodes(workflowId);
    const nodes = await Effect.runPromise(nodesProgram);

    const totalNodes = nodes.length;
    const totalEdges = nodes.reduce((acc, node) => acc + node.dependencies.length, 0);
    
    // 计算关键路径长度
    const criticalPathLength = this.calculateCriticalPathLength(nodes);
    
    // 计算并行度
    const parallelismDegree = Math.min(
      workflow.maxConcurrency,
      nodes.filter(n => n.status === 'running' || n.status === 'pending').length
    );

    // 估算完成时间（基于已完成节点的平均时间）
    const completedNodes = nodes.filter(n => n.completed_at);
    const avgNodeTime = completedNodes.length > 0
      ? completedNodes.reduce((acc, n) => acc + (n.completed_at! - (n.started_at || 0)), 0) / completedNodes.length
      : 0;
    
    const pendingNodes = nodes.filter(n => n.status === 'pending' || n.status === 'running').length;
    const estimatedCompletionTime = (avgNodeTime * pendingNodes) / parallelismDegree;

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
    const nodesProgram = this.sessionService.listNodes(workflowId);
    const nodes = await Effect.runPromise(nodesProgram);

    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const dependencies: NodeDependency[] = [];

    for (const node of nodes) {
      const dependents = nodes.filter(n => n.dependencies.includes(node.id));
      
      dependencies.push({
        nodeId: node.id,
        nodeName: node.config.name,
        dependencies: node.dependencies,
        dependents: dependents.map(d => d.id),
        status: node.status,
        completedAt: node.completed_at
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

    const nodesProgram = this.sessionService.listNodes(workflowId);
    const nodes = await Effect.runPromise(nodesProgram);

    const totalNodes = nodes.length;
    const completedNodes = nodes.filter(n => n.status === 'completed').length;
    const pendingNodes = nodes.filter(n => n.status === 'pending').length;
    const failedNodes = nodes.filter(n => n.status === 'failed').length;
    const currentRunning = nodes.filter(n => n.status === 'running').length;

    // 计算平均节点执行时间
    const completedNodesWithTime = nodes.filter(n => n.completed_at && n.completed_at > 0);
    const averageNodeDuration = completedNodesWithTime.length > 0
      ? completedNodesWithTime.reduce((acc, n) => acc + (n.completed_at! - (n.started_at || 0)), 0) / completedNodesWithTime.length
      : 0;

    // 计算总经过时间
    const startTime = workflow.started_at;
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
   * 计算图的关键路径长度（最长路径）
   */
  private calculateCriticalPathLength(nodes: DAGNodeSession[]): number {
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const memo = new Map<string, number>();

    const getLongestPath = (nodeId: string): number => {
      if (memo.has(nodeId)) {
        return memo.get(nodeId)!;
      }

      const node = nodeMap.get(nodeId);
      if (!node) return 0;

      if (node.dependencies.length === 0) {
        const duration = node.completed_at ? (node.completed_at - (node.started_at || 0)) : 0;
        memo.set(nodeId, duration);
        return duration;
      }

      let maxLength = 0;
      for (const depId of node.dependencies) {
        const depLength = getLongestPath(depId);
        maxLength = Math.max(maxLength, depLength);
      }

      const nodeDuration = node.completed_at ? (node.completed_at - (node.started_at || 0)) : 0;
      const totalLength = maxLength + nodeDuration;
      
      memo.set(nodeId, totalLength);
      return totalLength;
    };

    let maxPathLength = 0;
    for (const node of nodes) {
      const pathLength = getLongestPath(node.id);
      maxPathLength = Math.max(maxPathLength, pathLength);
    }

    return maxPathLength / 1000; // 转换为秒
  }
}