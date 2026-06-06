import { Cause, Effect } from "effect"
import { DAGSessionService } from "./session-service"
import { ViolationQueryAPI } from "./violation-query"
import type { DAGConfig, DAGNodeSession, DAGViolation, DAGWorkflowStatus } from "./types"
import type { PromptOps } from "@/session/prompt-ops"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"

/**
 * Workflow Status 快照接口
 * 
 * 命名为 Snapshot 以避免与 state-machine/types.ts 的 enum WorkflowStatus 冲突
 */
export interface WorkflowStatusSnapshot {
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
  getWorkflowStatus(workflowId: string): Effect.Effect<WorkflowStatusSnapshot>
}

// ============================================================================
// Module-Level Engine Registry (mirrors session-service.ts:26 _eventBus pattern)
// Enables static WorkflowEngine.get() lookups from tool layer without Effect context
// ============================================================================

const engineRegistry = new Map<string, WorkflowEngine>()
const spawnedNodes = new Set<string>()
const concurrencyRegistry = new Map<string, number>()

export function registerEngine(workflowId: string, engine: WorkflowEngine): void {
  engineRegistry.set(workflowId, engine)
}

export function unregisterEngine(workflowId: string): void {
  engineRegistry.delete(workflowId)
  concurrencyRegistry.delete(workflowId)
  for (const k of Array.from(spawnedNodes)) {
    if (k.startsWith(`${workflowId}::`)) spawnedNodes.delete(k)
  }
}

const make = Effect.gen(function* () {
  const dagSessionService = yield* DAGSessionService.make
  const sessionService = dagSessionService
  const violationAPI = new ViolationQueryAPI(sessionService)

  let _promptOps: PromptOps | undefined

  const setPromptOps = (ops: PromptOps) => {
    _promptOps = ops
  }

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
  // Node Spawn — Full daemon-flow for a single node (§10 compliant)
  // ============================================================================

  const spawnReadyNode = (workflowId: string, node: DAGNodeSession): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      // 1. Validate promptOps available
      if (!_promptOps) {
        yield* sessionService.updateNodeStatus({
          sessionId: node.node_id,
          status: 'failed',
          error: 'no promptOps configured for DAG node execution'
        } as any).pipe(Effect.ignore)
        return
      }

      // 2. Resolve agent
      const agentService = yield* Agent.Service
      const agent = yield* agentService.get(node.config.worker_type)
        .pipe(Effect.catchCause(() => Effect.succeed(undefined as any)))
      if (!agent) {
        yield* sessionService.updateNodeStatus({
          sessionId: node.node_id,
          status: 'failed',
          error: `unknown worker_type: ${node.config.worker_type}`
        } as any).pipe(Effect.ignore)
        return
      }

      // 3. Resolve sessions + create child session (§10: before status='running')
      const sessions = yield* Session.Service
      const workflow = yield* sessionService.getWorkflow(workflowId)
      if (!workflow) {
        yield* Effect.logDebug(`spawnReadyNode: workflow ${workflowId} gone, aborting spawn`)
        return
      }
      const childSession = yield* sessions.create({
        parentID: workflow.chat_session_id as any,
        title: node.config.name + ' (DAG node)',
      })

      // 4. Persist chat_session_id metadata (§10 timing fix - BEFORE updateNodeStatus('running'))
      if (sessionService.updateNodeMetadata) {
        yield* sessionService.updateNodeMetadata(node.node_id, {
          chat_session_id: childSession.id,
        }).pipe(Effect.ignore)
      }

      // 5. NOW mark as running (persist-first, before prompt)
      yield* sessionService.updateNodeStatus({
        sessionId: node.node_id,
        status: 'running'
      }).pipe(Effect.ignore)

      // 6. Prepend DAG node instruction + run prompt
      const promptInstruction = [
        `You are executing a DAG node. Node ID: ${node.node_id}.`,
        `When you have finished your work, you MUST call the \`node_complete\` tool EXACTLY ONCE with your result.`,
        `Use status='completed' and output for success. Use status='failed' and error for fatal errors.`,
        `If you do not call node_complete, the node will be marked failed.`,
        ``,
        `Your task:`,
        (node.config.worker_config?.prompt ?? ''),
      ].join("\n")

      const parts = yield* _promptOps.resolvePromptParts(promptInstruction)
      yield* _promptOps.prompt({
        sessionID: childSession.id,
        messageID: MessageID.ascending(),
        agent: agent.name,
        parts,
      }).pipe(
        Effect.catchCause((cause) => {
          return sessionService.updateNodeStatus({
            sessionId: node.node_id,
            status: 'failed',
            error: `prompt failed: ${String(Cause.squash(cause))}`
          } as any).pipe(Effect.ignore, Effect.andThen(Effect.failCause(cause)))
        }),
      ).pipe(Effect.ignore)

      // 7. Post-prompt: if node still 'running' (subagent never called node_complete)
      const finalNodes = yield* sessionService.listNodes(workflowId)
      const thisNode = finalNodes.find((n: DAGNodeSession) => n.node_id === node.node_id)
      if (thisNode && thisNode.status === 'running') {
        yield* sessionService.updateNodeStatus({
          sessionId: node.node_id,
          status: 'failed',
          error: 'node did not call node_complete tool'
        } as any).pipe(Effect.ignore)
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const errMsg = String(Cause.squash(cause))
          // Mark node failed if still in non-terminal state (spawn infra failure)
          const nodes = yield* sessionService.listNodes(workflowId).pipe(Effect.catchCause(() => Effect.succeed([] as DAGNodeSession[])))
          const current = nodes.find((n: DAGNodeSession) => n.node_id === node.node_id)
          if (current && (current.status === 'pending' || current.status === 'running')) {
            yield* sessionService.updateNodeStatus({
              sessionId: node.node_id,
              status: 'failed',
              error: `spawn failed: ${errMsg}`
            } as any).pipe(Effect.ignore)
            yield* sessionService.createViolation({
              workflowId,
              nodeId: node.node_id,
              type: 'execution_failed',
              severity: 'error',
              message: `Node spawn failed: ${errMsg}`,
            }).pipe(Effect.ignore)
          }
          return yield* Effect.logDebug(`spawnReadyNode uncaught: ${errMsg}`)
        })
      )
    ) as Effect.Effect<void, never, never>

  // ============================================================================
  // 核心方法
  // ============================================================================

  /**
   * 启动工作流
   */
  const startWorkflow: WorkflowEngine['startWorkflow'] = (workflowId, config) =>
    Effect.gen(function* () {
      // Store concurrency cap for scheduleReadyNodes budget enforcement
      concurrencyRegistry.set(workflowId, config.max_concurrency)

      // 更新工作流状态为 running
      yield* sessionService.updateWorkflowStatus(workflowId, 'running')
      
      // 调度第一批准备就绪的节点
      yield* scheduleReadyNodes(workflowId)
      
      return { success: true, workflowId }
    }) as Effect.Effect<{ success: boolean; workflowId: string }, never>

  /**
   * 调度所有就绪的节点 — daemon-based spawn (no inline status update)
   */
  const scheduleReadyNodes: WorkflowEngine['scheduleReadyNodes'] = (workflowId) =>
    Effect.gen(function* () {
      const allNodes = yield* sessionService.listNodes(workflowId)
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

      // Enforce concurrency cap
      const maxConcurrency = concurrencyRegistry.get(workflowId) ?? Number.POSITIVE_INFINITY
      const budget = maxConcurrency - runningNodeIds.size
      if (budget <= 0) return { scheduled: 0 }

      const limit = Math.min(readyNodes.length, budget)
      let scheduled = 0
      for (let i = 0; i < limit; i++) {
        const node = readyNodes[i]
        if (!spawnedNodes.has(node.node_id)) {
          spawnedNodes.add(node.node_id)
          yield* spawnReadyNode(workflowId, node).pipe(Effect.forkDetach)
          scheduled++
        }
      }

      return { scheduled }
    }) as Effect.Effect<{ scheduled: number }, never>

  /**
   * 处理节点完成
   */
  const handleNodeCompletion: WorkflowEngine['handleNodeCompletion'] = (workflowId, nodeId, output) =>
    Effect.gen(function* () {
      // 1. 更新节点状态
      yield* sessionService.updateNodeStatus({
        sessionId: nodeId,
        status: 'completed',
        outputData: output
      })
      
      // 2. 调度下一批准备就绪的节点
      yield* scheduleReadyNodes(workflowId)
      
      return { success: true }
    }) as Effect.Effect<{ success: boolean }, never>

  /**
   * 处理节点失败
   */
  const handleNodeFailure: WorkflowEngine['handleNodeFailure'] = (workflowId, nodeId, error) =>
    Effect.gen(function* () {
      // 1. 更新节点状态
      yield* sessionService.updateNodeStatus({
        sessionId: nodeId,
        status: 'failed',
        error: error.message
      })
      
      // 2. 创建违规记录
      yield* sessionService.createViolation({
        workflowId,
        nodeId,
        type: 'required_node_failed',
        severity: 'error',
        message: error.message
      })
      
      // 3. 调度下一批准备就绪的节点（其他分支可能继续）
      yield* scheduleReadyNodes(workflowId)
      
      return { success: true }
    }) as Effect.Effect<{ success: boolean }, never>

  /**
   * 取消工作流
   */
  const cancelWorkflow: WorkflowEngine['cancelWorkflow'] = (workflowId) =>
    Effect.gen(function* () {
      yield* sessionService.updateWorkflowStatus(workflowId, 'cancelled')
      return { success: true }
    }) as Effect.Effect<{ success: boolean }, never>

  /**
   * 获取工作流状态
   */
  const getWorkflowStatus: WorkflowEngine['getWorkflowStatus'] = (workflowId) =>
    Effect.sync(() => {
      // 1. 获取工作流 - 直接调用底层方法，避免 Effect.gen
      let workflow: any
      let allNodes: DAGNodeSession[]
      let violations: DAGViolation[]
      
      // 使用 Effect.runSync 同步执行
      workflow = Effect.runSync(sessionService.getWorkflow(workflowId))
      if (!workflow) {
        throw new Error(`Workflow ${workflowId} not found`)
      }
      
      // 2. 获取所有节点
      allNodes = Effect.runSync(sessionService.listNodes(workflowId))
      
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
      violations = Effect.runSync(violationAPI.getWorkflowViolations(workflowId))
      
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
    }) as Effect.Effect<WorkflowStatusSnapshot, never>

  return {
    startWorkflow,
    scheduleReadyNodes,
    handleNodeCompletion,
    handleNodeFailure,
    cancelWorkflow,
    getWorkflowStatus,
    setPromptOps,
    spawnReadyNode,
  } as WorkflowEngine & {
    setPromptOps: typeof setPromptOps
    spawnReadyNode: typeof spawnReadyNode
  }
})

export const WorkflowEngine = {
  make,
  get: (workflowId: string) => engineRegistry.get(workflowId),
}
