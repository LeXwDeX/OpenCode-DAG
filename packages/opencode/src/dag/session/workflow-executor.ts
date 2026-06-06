import { Effect } from "effect"
import type { WorkflowEngine, WorkflowStatusSnapshot } from "./workflow-engine"
import { unregisterEngine } from "./workflow-engine"
import type { DAGConfig } from "./types"

/** DAG executor default max runtime: 10 minutes */
const DEFAULT_MAX_RUNTIME_MS = 10 * 60 * 1000

/**
 * DAG 工作流执行器接口
 * 
 * 负责协调工作流的整体执行生命周期：
 * - 监控工作流状态
 * - 调度和执行就绪节点
 * - 处理并发控制
 * - 管理超时和错误
 */
export interface WorkflowExecutor {
  /**
   * 启动工作流执行
   */
  start(workflowId: string): Effect.Effect<void, never, never>
  
  /**
   * 获取当前工作流状态
   */
  getStatus(workflowId: string): Effect.Effect<WorkflowStatusSnapshot, never, never>
  
  /**
   * 执行单个就绪节点（用于测试或手动控制）
   */
  executeReadyNode(workflowId: string, nodeId: string): Effect.Effect<unknown, Error, never>
}

/**
 * 创建 WorkflowExecutor 实例
 * 
 * 执行循环包含超时保护和 cancelled 检测：
 * - 超过 maxRuntimeMs 自动中止
 * - 工作流状态变为 cancelled 立即退出
 */
export function createWorkflowExecutor(
  engine: WorkflowEngine,
  config: DAGConfig,
  maxRuntimeMs: number = DEFAULT_MAX_RUNTIME_MS
): WorkflowExecutor {
  return {
    start(workflowId: string): Effect.Effect<void, never, never> {
      return Effect.gen(function* () {
        const startedAt = Date.now()
        
        while (true) {
          // Timeout guard: abort if max runtime exceeded
          if (Date.now() - startedAt > maxRuntimeMs) {
            yield* engine.cancelWorkflow(workflowId)
            console.error(`Workflow ${workflowId} exceeded max runtime (${maxRuntimeMs}ms), cancelled`)
            break
          }
          
          const status = yield* engine.getWorkflowStatus(workflowId)
          
          // Terminal state check: completed / failed / cancelled
          if (status.status === "completed" || status.status === "failed" || status.status === "cancelled") {
            break
          }
          
          yield* engine.scheduleReadyNodes(workflowId)
          yield* Effect.sleep(100)
        }
      }).pipe(Effect.ensuring(Effect.sync(() => unregisterEngine(workflowId))))
    },
    
    getStatus(workflowId: string): Effect.Effect<WorkflowStatusSnapshot, never, never> {
      return engine.getWorkflowStatus(workflowId)
    },
    
    executeReadyNode(workflowId: string, nodeId: string): Effect.Effect<unknown, Error, never> {
      return Effect.die(new Error("executeReadyNode not yet implemented"))
    }
  }
}
