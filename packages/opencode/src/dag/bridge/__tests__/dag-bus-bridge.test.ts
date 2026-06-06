/**
 * DAG Event Bridge 单元测试
 *
 * TDD 红灯阶段：测试先行，验证桥接层的事件翻译、过滤、生命周期行为。
 *
 * Acceptance 门禁：
 * - [x] 订阅 workflow.started → 发布 dag.workflow.updated（payload 正确翻译）
 * - [x] 订阅 node.completed → 发布 dag.node.updated
 * - [x] 订阅 node.progress → 发布 dag.node.progress
 * - [x] 订阅 node.ask_main → 发布 dag.node.ask_main
 * - [x] 不订阅内部事件（node.registered / node.timeout）
 * - [x] 按 workflow_id 过滤
 * - [x] dispose() 后不再发布
 * - [x] subscribe 返回 UnsubscribeFn，调用后平台 Bus 也停止
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { EventBus } from "../../state-machine/EventBus"
import type { IEventBus } from "../../state-machine/IStateMachine"
import { DagEventBridge } from "../dag-bus-bridge"

// ============================================================================
// Test Helpers
// ============================================================================

interface PublishedEvent {
  type: string
  properties: Record<string, unknown>
}

function createMockPublish(): { fn: (type: string, properties: Record<string, unknown>) => void; events: PublishedEvent[] } {
  const events: PublishedEvent[] = []
  return {
    fn: (type: string, properties: Record<string, unknown>) => {
      events.push({ type, properties })
    },
    events,
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe("DagEventBridge", () => {
  let dagEventBus: EventBus
  let mock: ReturnType<typeof createMockPublish>

  beforeEach(() => {
    dagEventBus = new EventBus()
    mock = createMockPublish()
  })

  test("subscribes workflow.started → publishes dag.workflow.updated with correct payload", () => {
    const bridge = new DagEventBridge(dagEventBus as IEventBus, {
      chatSessionID: "chat-1",
    })
    bridge.subscribe(mock.fn)

    dagEventBus.emit({
      type: "workflow.started",
      workflow_id: "wf-1",
      timestamp: new Date(1700000000000),
    })

    expect(mock.events).toHaveLength(1)
    expect(mock.events[0].type).toBe("dag.workflow.updated")
    expect(mock.events[0].properties).toEqual({
      workflowID: "wf-1",
      chatSessionID: "chat-1",
      status: "running",
      timestamp: 1700000000000,
    })

    bridge.dispose()
  })

  test("subscribes node.completed → publishes dag.node.updated", () => {
    const bridge = new DagEventBridge(dagEventBus as IEventBus, {
      chatSessionID: "chat-1",
    })
    bridge.subscribe(mock.fn)

    dagEventBus.emit({
      type: "node.completed",
      workflow_id: "wf-1",
      node_name: "implement",
      output_summary: { files: ["src/foo.ts"] },
      diff_stats: { files_changed_count: 1, lines_added: 10, lines_removed: 0, patch_file: "" },
    })

    expect(mock.events).toHaveLength(1)
    expect(mock.events[0].type).toBe("dag.node.updated")
    expect(mock.events[0].properties.workflowID).toBe("wf-1")
    expect(mock.events[0].properties.nodeID).toBe("implement")
    expect(mock.events[0].properties.chatSessionID).toBe("chat-1")
    expect(mock.events[0].properties.status).toBe("completed")

    bridge.dispose()
  })

  test("subscribes node.progress → publishes dag.node.progress", () => {
    const bridge = new DagEventBridge(dagEventBus as IEventBus, {
      chatSessionID: "chat-1",
    })
    bridge.subscribe(mock.fn)

    dagEventBus.emit({
      type: "node.progress",
      workflow_id: "wf-1",
      node_name: "verify",
      progress_data: { percent: 50, step: "linting" },
    })

    expect(mock.events).toHaveLength(1)
    expect(mock.events[0].type).toBe("dag.node.progress")
    expect(mock.events[0].properties.workflowID).toBe("wf-1")
    expect(mock.events[0].properties.nodeID).toBe("verify")
    expect(mock.events[0].properties.chatSessionID).toBe("chat-1")
    expect(mock.events[0].properties.progress).toEqual({ percent: 50, step: "linting" })

    bridge.dispose()
  })

  test("subscribes node.ask_main → publishes dag.node.ask_main", () => {
    const bridge = new DagEventBridge(dagEventBus as IEventBus, {
      chatSessionID: "chat-1",
    })
    bridge.subscribe(mock.fn)

    dagEventBus.emit({
      type: "node.ask_main",
      workflow_id: "wf-1",
      node_name: "implement",
      question: "Which test runner should I use?",
      context: "bun vs vitest",
    })

    expect(mock.events).toHaveLength(1)
    expect(mock.events[0].type).toBe("dag.node.ask_main")
    expect(mock.events[0].properties.workflowID).toBe("wf-1")
    expect(mock.events[0].properties.nodeID).toBe("implement")
    expect(mock.events[0].properties.chatSessionID).toBe("chat-1")
    expect(mock.events[0].properties.question).toBe("Which test runner should I use?")
    expect(mock.events[0].properties.context).toBe("bun vs vitest")

    bridge.dispose()
  })

  test("does not forward internal events (node.registered / node.timeout)", () => {
    const bridge = new DagEventBridge(dagEventBus as IEventBus, {
      chatSessionID: "chat-1",
    })
    bridge.subscribe(mock.fn)

    dagEventBus.emit({
      type: "node.registered",
      workflow_id: "wf-1",
      node_name: "implement",
      node_type: "normal" as any,
    })

    dagEventBus.emit({
      type: "node.timeout",
      workflow_id: "wf-1",
      node_name: "implement",
      timeout_sec: 300,
    })

    dagEventBus.emit({
      type: "node.reset",
      workflow_id: "wf-1",
      node_name: "implement",
    })

    dagEventBus.emit({
      type: "node.pushed",
      workflow_id: "wf-1",
      node_name: "implement",
      push_count: 2,
      reason: "lint_failure",
    })

    expect(mock.events).toHaveLength(0)

    bridge.dispose()
  })

  test("filters by workflow_id — only forwards matching events", () => {
    const bridge = new DagEventBridge(dagEventBus as IEventBus, {
      workflowID: "wf-1",
      chatSessionID: "chat-1",
    })
    bridge.subscribe(mock.fn)

    // 匹配的事件
    dagEventBus.emit({
      type: "workflow.started",
      workflow_id: "wf-1",
      timestamp: new Date(),
    })

    // 不匹配的事件
    dagEventBus.emit({
      type: "workflow.started",
      workflow_id: "wf-other",
      timestamp: new Date(),
    })

    // 不匹配的节点事件
    dagEventBus.emit({
      type: "node.completed",
      workflow_id: "wf-other",
      node_name: "test",
      output_summary: null,
      diff_stats: { files_changed_count: 0, lines_added: 0, lines_removed: 0, patch_file: "" },
    })

    // 匹配 wf-1 的 node 事件
    dagEventBus.emit({
      type: "node.completed",
      workflow_id: "wf-1",
      node_name: "verify",
      output_summary: null,
      diff_stats: { files_changed_count: 0, lines_added: 0, lines_removed: 0, patch_file: "" },
    })

    expect(mock.events).toHaveLength(2)
    expect(mock.events[0].properties.workflowID).toBe("wf-1")
    expect(mock.events[1].properties.workflowID).toBe("wf-1")

    bridge.dispose()
  })

  test("dispose() stops publishing — no events forwarded after disposal", () => {
    const bridge = new DagEventBridge(dagEventBus as IEventBus, {
      chatSessionID: "chat-1",
    })
    bridge.subscribe(mock.fn)

    // 正常事件
    dagEventBus.emit({
      type: "workflow.started",
      workflow_id: "wf-1",
      timestamp: new Date(),
    })
    expect(mock.events).toHaveLength(1)

    // 释放
    bridge.dispose()

    // dispose 后的事件不应被转发
    dagEventBus.emit({
      type: "workflow.completed",
      workflow_id: "wf-1",
      duration_ms: 5000,
      accumulated_diff: "",
    })

    // 仍然只有 1 个事件
    expect(mock.events).toHaveLength(1)
  })

  test("subscribe returns UnsubscribeFn — calling it stops platform Bus forwarding", () => {
    const bridge = new DagEventBridge(dagEventBus as IEventBus, {
      chatSessionID: "chat-1",
    })

    const unsubscribe = bridge.subscribe(mock.fn)
    expect(typeof unsubscribe).toBe("function")

    // 正常事件
    dagEventBus.emit({
      type: "node.started",
      workflow_id: "wf-1",
      node_name: "implement",
      worktree_path: "/tmp/wt-1",
    })
    expect(mock.events).toHaveLength(1)

    // 调用 unsubscribe
    unsubscribe()

    // unsubscribe 后不应再转发
    dagEventBus.emit({
      type: "node.failed",
      workflow_id: "wf-1",
      node_name: "implement",
      trigger_reason: "exec_failed" as any,
    })

    // 仍然只有 1 个事件
    expect(mock.events).toHaveLength(1)

    bridge.dispose()
  })

  test("subscribes workflow.created → publishes dag.workflow.updated with status='pending'", () => {
    const bridge = new DagEventBridge(dagEventBus as IEventBus, {
      chatSessionID: "chat-1",
    })
    bridge.subscribe(mock.fn)

    dagEventBus.emit({
      type: "workflow.created",
      workflow_id: "wf-1",
      template: "default",
      timestamp: new Date(1700000000000),
    })

    expect(mock.events).toHaveLength(1)
    expect(mock.events[0].type).toBe("dag.workflow.updated")
    expect(mock.events[0].properties).toEqual({
      workflowID: "wf-1",
      chatSessionID: "chat-1",
      status: "pending",
      timestamp: 1700000000000,
    })

    bridge.dispose()
  })
})
