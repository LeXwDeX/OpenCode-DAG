import { Effect } from "effect"
import { DAGSessionService } from "./session-service"
import { ViolationQueryAPI } from "./violation-query"
import type { DAGConfig, DAGNodeSession, DAGViolation, DAGWorkflowStatus } from "./types"

/**
 * Workflow Status 接口
 */
export interface WorkflowStatus {
  workflowId: string
  status: DAGWorkflowStatus
  totalNodes: number
  completedNodes: number
  failedNodes: number
  runningNodes: number
  readyNodes: number
  violations: DAGViolation[]
  violations_count: number
  timestamp: number
}

/**
 * DAG 工作流引擎接口
 */
export interface WorkflowEngine {
  startWorkflow(workflowId: string, config: DAGConfig): Effect.Effect<unknown>
  scheduleReadyNodes(workflowId: string): Effect.Effect<unknown>
  handleNodeCompletion(workflowId: string, nodeId: string, output: unknown): Effect.Effect<unknown>
  handleNodeFailure(workflowId: string, nodeId: string, error: Error): Effect.Effect<unknown>
  cancelWorkflow(workflowId: string): Effect.Effect<unknown>
  getWorkflowStatus(workflowId: string): Effect.Effect<WorkflowStatus>
}

const make = Effect.gen(function* () {
  const sessionService = yield* DAGSessionService
  const violationAPI = new ViolationQueryAPI(sessionService)

  // ============================================================================
  // 辅助函数
  // ============================================================================

  /**
   * 检查节点的所有依赖是否已完成
   */
  const areDependenciesSatisfied = (node: DAGNodeSession, completedNodeIds: Set<string>): boolean => {
    if (!node.dependencies || node.dependencies.length === 0) {
      return true
    }
    return node.dependencies.every((depId: string) => completedNodeIds.has(depId))
  }

  /**
   * 获取所有就绪的节点（依赖已满足且尚未执行）
   */
  const getReadyNodes = (
    nodes: DAGNodeSession[],
    completedNodeIds: Set<string>,
    failedNodeIds: Set<string>,
    runningNodeIds: Set<string>
  ): DAGNodeSession[] => {
    return nodes.filter(node => {
      const isNotRunning = !runningNodeIds.has(node.node_id)
      const isNotCompleted = !completedNodeIds.has(node.node_id)
      const isNotFailed = !failedNodeIds.has(node.node_id)
      const depsSatisfied = areDependenciesSatisfied(node, completedNodeIds)
      return isNotRunning && isNotCompleted && isNotFailed && depsSatisfied
    })
  }

  // ============================================================================
  // 核心方法
  // ============================================================================

  /**
   * 启动工作流
   */
  const startWorkflow: WorkflowEngine['startWorkflow'] = (workflowId, config) =>
    Effect.gen(function* () {
      // 更新工作流状态为 running
      yield* sessionService.updateWorkflowStatus(workflowId, 'running')
      
      // 调度第一批准备就绪的节点
      yield* scheduleReadyNodes(workflowId)
      
      return { success: true, workflowId }
    })

  /**
   * 调度所有就绪的节点
   */
  const scheduleReadyNodes: WorkflowEngine['scheduleReadyNodes'] = (workflowId) =>
    Effect.gen(function* () {
      // 1. 获取所有节点
      const allNodes = yield* sessionService.listNodes(workflowId)
      
      // 2. 收集已完成、已失败、正在运行的节点 ID
      const completedNodeIds = new Set<string>(
        allNodes.filter((n: DAGNodeSession) => n.status === 'completed').map((n: DAGNodeSession) => n.node_id)
      )
      const failedNodeIds = new Set<string>(
        allNodes.filter((n: DAGNodeSession) => n.status === 'failed').map((n: DAGNodeSession) => n.node_id)
      )
      const runningNodeIds = new Set<string>(
        allNodes.filter((n: DAGNodeSession) => n.status === 'running').map((n: DAGNodeSession) => n.node_id)
      )
      
      // 3. 获取就绪的节点
      const readyNodes = getReadyNodes(allNodes, completedNodeIds, failedNodeIds, runningNodeIds)
      
      // 4. 调度就绪的节点
      for (const node of readyNodes) {
        yield* sessionService.updateNodeStatus({
          nodeId: node.node_id,
          status: 'running'
        })
      }
      
      return { scheduled: readyNodes.length }
    })

  /**
   * 处理节点完成
   */
  const handleNodeCompletion: WorkflowEngine['handleNodeCompletion'] = (workflowId, nodeId, output) =>
    Effect.gen(function* () {
      // 1. 更新节点状态
      yield* sessionService.updateNodeStatus({
        nodeId,
        status: 'completed',
        outputData: output
      })
      
      // 2. 调度下一批准备就绪的节点
      yield* scheduleReadyNodes(workflowId)
      
      return { success: true }
    })

  /**
   * 处理节点失败
   */
  const handleNodeFailure: WorkflowEngine['handleNodeFailure'] = (workflowId, nodeId, error) =>
    Effect.gen(function* () {
      // 1. 更新节点状态
      yield* sessionService.updateNodeStatus({
        nodeId,
        status: 'failed',
        error: error.message
      })
      
      // 2. 创建违规记录
      yield* sessionService.createViolation({
        workflowId,
        nodeId,
        type: 'execution_error',
        severity: 'error',
        message: error.message
      })
      
      // 3. 调度下一批准备就绪的节点（其他分支可能继续）
      yield* scheduleReadyNodes(workflowId)
      
      return { success: true }
    })

  /**
   * 取消工作流
   */
  const cancelWorkflow: WorkflowEngine['cancelWorkflow'] = (workflowId) =>
    Effect.gen(function* () {
      yield* sessionService.updateWorkflowStatus(workflowId, 'cancelled')
      return { success: true }
    })

  /**
   * 获取工作流状态
   */
  const getWorkflowStatus: WorkflowEngine['getWorkflowStatus'] = (workflowId) =>
    Effect.gen(function* () {
      // 1. 获取工作流
      const workflow = yield* sessionService.getWorkflow(workflowId)
      if (!workflow) {
        return yield* Effect.fail(new Error(`Workflow ${workflowId} not found`))
      }
      
      // 2. 获取所有节点
      const allNodes = yield* sessionService.listNodes(workflowId)
      
      // 3. 统计节点状态
      const completedNodes = allNodes.filter((n: DAGNodeSession) => n.status === 'completed').length
      const failedNodes = allNodes.filter((n: DAGNodeSession) => n.status === 'failed').length
      const runningNodes = allNodes.filter((n: DAGNodeSession) => n.status === 'running').length
      
      // 4. 计算就绪节点
      const completedNodeIds = new Set<string>(
        allNodes.filter((n: DAGNodeSession) => n.status === 'completed').map((n: DAGNodeSession) => n.node_id)
      )
      const failedNodeIds = new Set<string>(
        allNodes.filter((n: DAGNodeSession) => n.status === 'failed').map((n: DAGNodeSession) => n.node_id)
      )
      const runningNodeIds = new Set<string>(
        allNodes.filter((n: DAGNodeSession) => n.status === 'running').map((n: DAGNodeSession) => n.node_id)
      )
      const readyNodes = getReadyNodes(allNodes, completedNodeIds, failedNodeIds, runningNodeIds)
      
      // 5. 获取违规记录
      const violations = yield* violationAPI.listViolations(workflowId)
      
      // 6. 返回状态
      return {
        workflowId,
        status: workflow.status,
        totalNodes: allNodes.length,
        completedNodes,
        failedNodes,
        runningNodes,
        readyNodes: readyNodes.length,
        violations,
        violations_count: violations.length,
        timestamp: Date.now()
      }
    })

  return {
    startWorkflow,
    scheduleReadyNodes,
    handleNodeCompletion,
    handleNodeFailure,
    cancelWorkflow,
    getWorkflowStatus
  } as WorkflowEngine
})

export const WorkflowEngine = { make }
