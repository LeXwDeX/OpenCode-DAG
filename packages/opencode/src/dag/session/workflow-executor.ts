import { Effect } from "effect"
import type { WorkflowEngine, WorkflowStatus } from "./workflow-engine"
import type { DAGConfig } from "./types"

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
  getStatus(workflowId: string): Effect.Effect<WorkflowStatus, never, never>
  
  /**
   * 执行单个就绪节点（用于测试或手动控制）
   */
  executeReadyNode(workflowId: string, nodeId: string): Effect.Effect<unknown, Error, never>
}

/**
 * 创建 WorkflowExecutor 实例
 */
export function createWorkflowExecutor(
  engine: WorkflowEngine,
  config: DAGConfig
): WorkflowExecutor {
  return {
    start(workflowId: string): Effect.Effect<void, never, never> {
      return Effect.gen(function* () {
        while (true) {
          // 获取当前状态
          const status = yield* engine.getWorkflowStatus(workflowId)
          
          // 检查是否完成
          if (status.status === "completed" || status.status === "failed") {
            break
          }
          
          // 调度就绪节点
          yield* engine.scheduleReadyNodes(workflowId)
          
          // 等待一段时间（避免忙等待）
          yield* Effect.sleep(100)
        }
      })
    },
    
    getStatus(workflowId: string): Effect.Effect<WorkflowStatus, never, never> {
      return engine.getWorkflowStatus(workflowId)
    },
    
    executeReadyNode(workflowId: string, nodeId: string): Effect.Effect<unknown, Error, never> {
      // 这个方法的实现需要访问节点执行器
      // 暂时抛出未实现错误
      return Effect.die(new Error("executeReadyNode not yet implemented"))
    }
  }
}
