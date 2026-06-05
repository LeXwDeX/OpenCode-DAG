/**
 * DAG Query Types
 * 
 * 定义 DAG 查询相关的类型接口
 */

import type { DAGWorkflowSession, DAGNodeStatus } from '../session/types'

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
  status: 'pending' | 'running' | 'completed' | 'failed'
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
  currentRunning: number
  averageNodeDuration: number
  totalElapsedTime: number
}