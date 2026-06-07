/**
 * DAG Event Bridge — 单向只读翻译层
 *
 * 将 DAG 内部 IEventBus 的 workflow / node 事件翻译为平台 Bus 事件。
 * 只读转发，禁止回写（§9.a）。
 *
 * 架构约束：
 * - §0.1 构造函数必需在前可选在后
 * - §0.2 共享 IEventBus，禁止自建事件通道
 * - §9.a 只读转发，禁止回写
 * - §9.c 按 workflow_id 过滤
 * - §10 字段名固定 chat_session_id
 */

import type { IEventBus, UnsubscribeFunction } from "../state-machine/IStateMachine"
import type { WorkflowEvent, NodeEvent } from "../state-machine/types"

// ============================================================================
// Types
// ============================================================================

export interface BridgeOptions {
  /** 只转发匹配此 workflowID 的事件（§9.c 按 workflow_id 过滤） */
  workflowID?: string
  /** 关联的平台 Chat Session ID（§10） */
  chatSessionID?: string
}

/**
 * 平台事件发布函数签名。
 *
 * 通过回调注入解耦 Effect 运行时依赖，保持 bridge 不依赖
 * session-service / WorkflowEngine / SQLite。
 *
 * 生产环境 wiring 示例：
 * ```ts
 * bridge.subscribe((type, props) => {
 *   Bus.publish(ctx, DagWorkflowUpdated, props as any)
 * })
 * ```
 */
export type PublishEventFn = (type: string, properties: Record<string, unknown>) => void

// ============================================================================
// Internal: 事件类型过滤集合（不转发的 DAG 内部事件）
// ============================================================================

const IGNORED_EVENT_TYPES = new Set([
  "node.registered",
  "node.reset",
  "node.pushed",
  "node.timeout",
])

// ============================================================================
// Bridge Class
// ============================================================================

/**
 * DAG 事件桥接器
 *
 * 订阅 DAG IEventBus 全品类事件，按 workflowID 过滤后翻译为平台 Bus 事件。
 */
export class DagEventBridge {
  private unsubscribeFns: UnsubscribeFunction[] = []
  private disposed = false
  private publishFn: PublishEventFn | undefined

  constructor(
    private readonly eventBus: IEventBus,
    private readonly options: BridgeOptions = {},
  ) {}

  /**
   * 开始桥接：订阅 DAG IEventBus 并转发到平台 Bus。
   *
   * @param publishFn - 平台发布函数（注入解耦）
   * @returns 取消桥接函数
   */
  subscribe(publishFn: PublishEventFn): UnsubscribeFunction {
    this.publishFn = publishFn

    const unsub = this.eventBus.subscribe("*", (event) => {
      this.handleEvent(event as WorkflowEvent | NodeEvent)
    })

    this.unsubscribeFns.push(unsub)

    return () => {
      unsub()
      this.unsubscribeFns = this.unsubscribeFns.filter((fn) => fn !== unsub)
      this.publishFn = undefined
    }
  }

  /** 释放 DAG IEventBus 订阅 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.publishFn = undefined
    for (const unsub of this.unsubscribeFns) {
      unsub()
    }
    this.unsubscribeFns = []
  }

  // ── private: event routing ───────────────────────────────────────────

  private handleEvent(event: WorkflowEvent | NodeEvent): void {
    if (this.disposed) return
    if (!this.publishFn) return

    // §9.c: filter by workflow_id if option is set
    if (this.options.workflowID && event.workflow_id !== this.options.workflowID) {
      return
    }

    // Skip internal events not meant for platform consumers
    if (IGNORED_EVENT_TYPES.has(event.type)) return

    if (event.type.startsWith("workflow.")) {
      this.translateWorkflowEvent(event as WorkflowEvent)
    } else if (event.type.startsWith("node.")) {
      this.translateNodeEvent(event as NodeEvent)
    }
  }

  private translateWorkflowEvent(event: WorkflowEvent): void {
    const publishFn = this.publishFn
    if (!publishFn) return

    const status = workflowEventToStatus(event)
    if (!status) return

    try {
      publishFn("dag.workflow.updated", {
        workflowID: event.workflow_id,
        ...(this.options.chatSessionID && { chatSessionID: this.options.chatSessionID }),
        status,
        timestamp: extractTimestamp(event),
      })
    } catch (err) {
      console.warn("[DagEventBridge] publish failed:", err)
    }
  }

  private translateNodeEvent(event: NodeEvent): void {
    const publishFn = this.publishFn
    if (!publishFn) return

    const nodeID = event.node_name

    if (event.type === "node.progress") {
      try {
        publishFn("dag.node.progress", {
          workflowID: event.workflow_id,
          nodeID,
          ...(this.options.chatSessionID && { chatSessionID: this.options.chatSessionID }),
          progress: event.progress_data,
          timestamp: Date.now(),
        })
      } catch (err) {
        console.warn("[DagEventBridge] publish failed:", err)
      }
      return
    }

    if (event.type === "node.ask_main") {
      const props: Record<string, unknown> = {
        workflowID: event.workflow_id,
        nodeID,
        ...(this.options.chatSessionID && { chatSessionID: this.options.chatSessionID }),
        question: event.question,
        timestamp: Date.now(),
      }
      if (event.context !== undefined) {
        props.context = event.context
      }
      try {
        publishFn("dag.node.ask_main", props)
      } catch (err) {
        console.warn("[DagEventBridge] publish failed:", err)
      }
      return
    }

    // All other node events → dag.node.updated with derived status
    const status = nodeEventToStatus(event)
    if (!status) return

    try {
      publishFn("dag.node.updated", {
        workflowID: event.workflow_id,
        nodeID,
        ...(this.options.chatSessionID && { chatSessionID: this.options.chatSessionID }),
        status,
        timestamp: extractNodeTimestamp(event),
      })
    } catch (err) {
      console.warn("[DagEventBridge] publish failed:", err)
    }
  }
}

// ============================================================================
// Helpers: event → platform status mapping
// ============================================================================

function workflowEventToStatus(event: WorkflowEvent): string | null {
  switch (event.type) {
    case "workflow.created":
      return "pending"
    case "workflow.started":
      return "running"
    case "workflow.completed":
      return "completed"
    case "workflow.failed":
      return "failed"
    case "workflow.cancelled":
      return "cancelled"
    case "workflow.paused":
    case "workflow.resumed":
    case "workflow.archived":
    case "workflow.replanned":
      return null // not forwarded to platform
  }
}

function nodeEventToStatus(event: NodeEvent): string | null {
  switch (event.type) {
    case "node.started":
      return "running"
    case "node.completed":
      return "completed"
    case "node.failed":
      return "failed"
    case "node.paused":
      return "pending"
    case "node.resumed":
      return "running"
    case "node.skipped":
      return "skipped"
    case "node.aborted":
      return "failed"
    case "node.restarted":
      return "running"
    default:
      return null
  }
}

function extractTimestamp(event: WorkflowEvent): number {
  switch (event.type) {
    case "workflow.created":
    case "workflow.started":
    case "workflow.resumed":
      return event.timestamp.getTime()
    case "workflow.paused":
      return event.paused_at.getTime()
    case "workflow.cancelled":
      return event.cancelled_at.getTime()
    case "workflow.archived":
      return event.archived_at.getTime()
    default:
      return Date.now()
  }
}

function extractNodeTimestamp(event: NodeEvent): number {
  switch (event.type) {
    case "node.paused":
      return event.paused_at.getTime()
    case "node.resumed":
      return event.timestamp.getTime()
    default:
      return Date.now()
  }
}
