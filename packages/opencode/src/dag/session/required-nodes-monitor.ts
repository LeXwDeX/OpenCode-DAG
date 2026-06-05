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
    // 1. 监听节点跳过事件 - 如果 required node 被 skipped
    this.eventBus.subscribe("node.skipped", (event: any) => {
      const nodeName = event?.node_name
      const workflowId = event?.workflow_id

      if (nodeName && workflowId) {
        this.handleNodeSkipped(nodeName, workflowId)
      }
    })

    // 2. 监听 workflow 完成 - 检查所有 required nodes 是否完成
    this.eventBus.subscribe("workflow.completed", (event: any) => {
      const workflowId = event?.workflow_id
      
      if (workflowId) {
        this.checkAllRequiredNodesCompleted(workflowId)
      }
    })
  }

  /**
   * 处理节点被跳过的情况
   */
  private async handleNodeSkipped(nodeName: string, workflowId: string) {
    try {
      // 1. 获取 workflow
      const workflow = await Effect.runPromise(
        this.sessionService.getWorkflow(workflowId)
      )
      
      if (!workflow) {
        console.error(`Workflow ${workflowId} not found`)
        return
      }

      // 2. 按节点配置名查找 session 层节点（event 带的是 node_name，非 session 层 node_id）
      const allNodes = await Effect.runPromise(
        this.sessionService.listNodes(workflowId)
      )
      const node = allNodes.find(n => (n.config as any)?.name === nodeName)
      
      if (!node) {
        console.error(`Node "${nodeName}" not found in workflow ${workflowId}`)
        return
      }

      // 3. 检查这是否是 required node（按配置名匹配）
      const isRequired = workflow.config.nodes.find((n) => n.name === nodeName)

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
          message: `Required node "${nodeName}" was skipped`,
        })
      )

      // 5. 更新 workflow 状态为 failed
      await Effect.runPromise(
        this.sessionService.updateWorkflowStatus(
          workflowId,
          "failed"
        )
      )
      
      console.warn(`Required node "${nodeName}" was skipped in workflow ${workflowId}`)
    } catch (error) {
      console.error(`Failed to handle skipped node ${nodeName}:`, error)
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

        // 6. workflow 已 completed（终态不可逆），仅通过 violation 记录追踪
        //    不再尝试 updateWorkflowStatus — completed→failed 违反铁律 #2
      }
    } catch (error) {
      console.error(`Failed to check required nodes for workflow ${workflowId}:`, error)
    }
  }
}
