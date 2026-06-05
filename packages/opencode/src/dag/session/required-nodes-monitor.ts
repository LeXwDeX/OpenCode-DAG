import { Effect } from "effect"
import { EventBus } from "../state-machine/EventBus"
import type { DAGSessionService } from "./session-service"
import type { DAGNodeConfig } from "./types"

/**
 * Required Nodes Monitor
 * 
 * 在 Workflow 执行期间监控 required_nodes 的完成状态
 * 检测违规并记录到数据库
 */
export class RequiredNodesMonitor {
  constructor(
    private eventBus: EventBus,
    private sessionService: DAGSessionService,
  ) {}

  /**
   * 注册事件监听器
   */
  register() {
    // 1. 监听节点状态变化 - 如果 required node 被 skipped
    this.eventBus.subscribe("node.status_changed", (event: any) => {
      if (event?.data?.status === "skipped") {
        const nodeId = event.data.nodeId
        const workflowId = event.data.workflowId
        
        if (nodeId && workflowId) {
          this.handleNodeSkipped(nodeId, workflowId)
        }
      }
    })

    // 2. 监听 workflow 完成 - 检查所有 required nodes 是否完成
    this.eventBus.subscribe("workflow.completed", (event: any) => {
      const workflowId = event?.data?.workflow_id
      
      if (workflowId) {
        this.checkAllRequiredNodesCompleted(workflowId)
      }
    })
  }

  /**
   * 处理节点被跳过的情况
   */
  private async handleNodeSkipped(nodeId: string, workflowId: string) {
    try {
      // 1. 获取 workflow
      const workflow = await Effect.runPromise(
        this.sessionService.getWorkflow(workflowId)
      )
      
      if (!workflow) {
        console.error(`Workflow ${workflowId} not found`)
        return
      }

      // 2. 获取节点
      const node = await Effect.runPromise(
        this.sessionService.getNode(nodeId)
      )
      
      if (!node) {
        console.error(`Node ${nodeId} not found in workflow ${workflowId}`)
        return
      }

      // 3. 检查这是否是 required node
      const isRequired = workflow.config.nodes.find((n) => n.id === nodeId)

      if (!isRequired) {
        return // 不是 required node，忽略
      }

      // 4. 记录违规
      await Effect.runPromise(
        this.sessionService.createViolation({
          workflowId,
          nodeId: node.node_id,
          type: "required_node_skipped",
          severity: "error",
          message: `Required node ${node.node_id} was skipped`,
        })
      )

      // 5. 更新 workflow 状态为 failed_with_violations
      await Effect.runPromise(
        this.sessionService.updateWorkflowStatus(
          workflowId,
          "failed_with_violations"
        )
      )
      
      console.warn(`Required node ${node.node_id} was skipped in workflow ${workflowId}`)
    } catch (error) {
      console.error(`Failed to handle skipped node ${nodeId}:`, error)
    }
  }

  /**
   * 检查所有 required nodes 是否都已完成
   */
  private async checkAllRequiredNodesCompleted(workflowId: string) {
    try {
      // 1. 获取 workflow
      const workflow = await Effect.runPromise(
        this.sessionService.getWorkflow(workflowId)
      )
      
      if (!workflow) {
        console.error(`Workflow ${workflowId} not found`)
        return
      }

      // 2. 获取所有节点
      const nodes = await Effect.runPromise(
        this.sessionService.listNodes(workflowId)
      )

      // 3. 找出所有 required nodes
      const requiredNodeConfigs = workflow.config.nodes.filter(
        (n: DAGNodeConfig) => n.required
      )

      // 4. 检查是否都已完成
      const completedNodeIds = new Set(
        nodes
          .filter(n => n.status === "completed")
          .map(n => n.node_id)
      )

      const missingRequired = requiredNodeConfigs.filter(
        (n: DAGNodeConfig) => !completedNodeIds.has(n.id)
      )

      // 5. 如果有缺失的 required nodes，记录违规
      if (missingRequired.length > 0) {
        console.warn(
          `Workflow ${workflowId} completed but ${missingRequired.length} required nodes did not complete`
        )

        for (const missingNode of missingRequired) {
          await Effect.runPromise(
            this.sessionService.createViolation({
              workflowId,
              nodeId: missingNode.id,
              type: "required_node_skipped",
              severity: "error",
              message: `Required node ${missingNode.id} did not complete`,
              details: {
                expectedStatus: "completed",
                node: missingNode,
              },
            })
          )
        }

        // 6. 更新 workflow 状态为 failed_with_violations
        await Effect.runPromise(
          this.sessionService.updateWorkflowStatus(
            workflowId,
            "failed_with_violations"
          )
        )
      }
    } catch (error) {
      console.error(`Failed to check required nodes for workflow ${workflowId}:`, error)
    }
  }
}
