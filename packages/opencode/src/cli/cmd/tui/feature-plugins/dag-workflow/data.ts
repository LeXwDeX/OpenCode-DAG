/**
 * DAG Workflow 数据抽象层
 *
 * 封装 WP3 阶段的 mock 数据访问。
 * 后续 WP4 会替换为 SDK query + SSE subscription，但对外暴露的接口不变。
 *
 * 铁律约束：
 * - 禁止直接调用 SDK（必须走此抽象层）
 * - KV 键通过 kv.get/set API 操作（不硬编码完整键字面量到调用方）
 * - 传输抽象层接口稳定，方便 WP4 扩展实现
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type {
  DAGNodeSession,
  DAGViolation,
  DAGWorkflowSession,
} from "@/dag/session/types"
import { createMemo, createSignal, type Accessor } from "solid-js"

// ============================================================================
// KV Key 模板（封装在此模块内，调用方不感知具体前缀）
// ============================================================================

export const kvKeys = {
  workflowList: (sessionId: string) => `dag_workflows_${sessionId}`,
  workflow: (workflowId: string) => `dag_workflow_${workflowId}`,
  nodes: (workflowId: string) => `dag_nodes_${workflowId}`,
  violations: (workflowId: string) => `dag_violations_${workflowId}`,
  timeline: (workflowId: string) => `dag_timeline_${workflowId}`,
}

// ============================================================================
// Timeline 事件类型（WP3 mock 用；WP4 将来自 SDK SSE）
// ============================================================================

export type DAGTimelineEvent = {
  id: string
  workflow_id: string
  node_id?: string
  type: "state_change" | "violation" | "log" | "milestone"
  label: string
  timestamp: number
  severity?: "info" | "warning" | "error"
}

// ============================================================================
// Mock 数据（WP3 阶段；WP4 替换为真实数据源）
// ============================================================================

const NOW = Date.now()

const MOCK_WORKFLOW_LIST: DAGWorkflowSession[] = [
  {
    id: "wf-123",
    chat_session_id: "chat-session-1",
    config: {
      name: "Build Agent Flow",
      description: "三阶段 agent 构建流水线",
      nodes: [
        {
          id: "gather",
          name: "收集需求",
          dependencies: [],
          required: true,
          worker_type: "subagent",
          worker_config: {},
        },
        {
          id: "plan",
          name: "生成计划",
          dependencies: ["gather"],
          required: true,
          worker_type: "subagent",
          worker_config: {},
        },
        {
          id: "execute",
          name: "执行任务",
          dependencies: ["plan"],
          required: true,
          worker_type: "subagent",
          worker_config: {},
        },
      ],
      max_concurrency: 2,
    },
    status: "running",
    node_sessions: {
      gather: {
        node_id: "gather",
        workflow_id: "wf-123",
        config: {
          id: "gather",
          name: "收集需求",
          dependencies: [],
          required: true,
          worker_type: "subagent",
          worker_config: {},
        },
        status: "completed",
        output: null,
        retry_count: 0,
        max_retries: 3,
        timeout_ms: 60_000,
        required_nodes: [],
        dependencies: [],
        metadata: {},
        start_time: NOW - 60_000,
        completed_at: (NOW - 30_000).toString(),
        end_time: NOW - 30_000,
        duration_ms: 30_000,
        parent_node: null,
        created_at: NOW - 60_000,
        updated_at: NOW - 30_000,
        logs: ["需求收集完成", "共识别 3 个子任务"],
      },
      plan: {
        node_id: "plan",
        workflow_id: "wf-123",
        config: {
          id: "plan",
          name: "生成计划",
          dependencies: ["gather"],
          required: true,
          worker_type: "subagent",
          worker_config: {},
        },
        status: "running",
        output: null,
        retry_count: 0,
        max_retries: 3,
        timeout_ms: 120_000,
        required_nodes: ["gather"],
        dependencies: ["gather"],
        metadata: {},
        start_time: NOW - 20_000,
        completed_at: null,
        end_time: null,
        duration_ms: null,
        parent_node: null,
        created_at: NOW - 20_000,
        updated_at: NOW,
        logs: ["正在分解需求为可执行计划..."],
      },
      execute: {
        node_id: "execute",
        workflow_id: "wf-123",
        config: {
          id: "execute",
          name: "执行任务",
          dependencies: ["plan"],
          required: true,
          worker_type: "subagent",
          worker_config: {},
        },
        status: "pending",
        output: null,
        retry_count: 0,
        max_retries: 3,
        timeout_ms: 300_000,
        required_nodes: ["plan"],
        dependencies: ["plan"],
        metadata: {},
        start_time: null,
        completed_at: null,
        end_time: null,
        duration_ms: null,
        parent_node: null,
        created_at: NOW - 60_000,
        updated_at: NOW - 60_000,
        logs: [],
      },
    },
    violations: [],
    metadata: {},
    start_time: NOW - 60_000,
    end_time: null,
    current_node: "plan",
    created_at: NOW - 60_000,
    updated_at: NOW,
    completed_at: null,
    duration_ms: null,
  },
  {
    id: "wf-456",
    chat_session_id: "chat-session-1",
    config: {
      name: "Debug Pipeline",
      description: "失败重试演示",
      nodes: [
        {
          id: "diag",
          name: "诊断",
          dependencies: [],
          required: true,
          worker_type: "subagent",
          worker_config: {},
        },
        {
          id: "fix",
          name: "修复",
          dependencies: ["diag"],
          required: true,
          worker_type: "subagent",
          worker_config: {},
        },
      ],
      max_concurrency: 1,
    },
    status: "failed",
    node_sessions: {
      diag: {
        node_id: "diag",
        workflow_id: "wf-456",
        config: {
          id: "diag",
          name: "诊断",
          dependencies: [],
          required: true,
          worker_type: "subagent",
          worker_config: {},
        },
        status: "completed",
        output: null,
        retry_count: 0,
        max_retries: 0,
        timeout_ms: 60_000,
        required_nodes: [],
        dependencies: [],
        metadata: {},
        start_time: NOW - 90_000,
        completed_at: (NOW - 80_000).toString(),
        end_time: NOW - 80_000,
        duration_ms: 10_000,
        parent_node: null,
        created_at: NOW - 90_000,
        updated_at: NOW - 80_000,
        logs: ["诊断完成"],
      },
      fix: {
        node_id: "fix",
        workflow_id: "wf-456",
        config: {
          id: "fix",
          name: "修复",
          dependencies: ["diag"],
          required: true,
          worker_type: "subagent",
          worker_config: {},
        },
        status: "failed",
        output: null,
        error_info: {
          type: "runtime",
          message: "Subagent timed out after 120s",
          retryable: true,
        },
        retry_count: 2,
        max_retries: 2,
        timeout_ms: 120_000,
        required_nodes: ["diag"],
        dependencies: ["diag"],
        metadata: {},
        start_time: NOW - 75_000,
        completed_at: null,
        end_time: NOW - 70_000,
        duration_ms: 5_000,
        parent_node: null,
        created_at: NOW - 75_000,
        updated_at: NOW - 70_000,
        logs: ["尝试修复失败", "重试次数已耗尽"],
      },
    },
    violations: [
      {
        id: "v-001",
        workflowId: "wf-456",
        type: "required_node_failed",
        severity: "error",
        nodeId: "fix",
        message: "Required node 'fix' failed after 2 retries",
        timestamp: new Date(NOW - 70_000).toISOString(),
      },
    ],
    metadata: {},
    start_time: NOW - 90_000,
    end_time: NOW - 70_000,
    current_node: null,
    created_at: NOW - 90_000,
    updated_at: NOW - 70_000,
    completed_at: NOW - 70_000,
    duration_ms: 20_000,
  },
]

const MOCK_WORKFLOWS_INDEX: Record<string, DAGWorkflowSession> = {
  "wf-123": MOCK_WORKFLOW_LIST[0],
  "wf-456": MOCK_WORKFLOW_LIST[1],
}

const MOCK_TIMELINE: Record<string, DAGTimelineEvent[]> = {
  "wf-123": [
    {
      id: "evt-1",
      workflow_id: "wf-123",
      node_id: "gather",
      type: "milestone",
      label: "Node 'gather' completed",
      timestamp: NOW - 30_000,
      severity: "info",
    },
    {
      id: "evt-2",
      workflow_id: "wf-123",
      node_id: "plan",
      type: "state_change",
      label: "Node 'plan' transitioned to running",
      timestamp: NOW - 20_000,
      severity: "info",
    },
  ],
  "wf-456": [
    {
      id: "evt-3",
      workflow_id: "wf-456",
      node_id: "fix",
      type: "violation",
      label: "required_node_failed: Node 'fix'",
      timestamp: NOW - 70_000,
      severity: "error",
    },
  ],
}

// ============================================================================
// Hooks 公共签名
// ============================================================================

export type WorkflowListApi = {
  list: Accessor<DAGWorkflowSession[]>
  refresh: () => void
}

export type WorkflowApi = {
  workflow: Accessor<DAGWorkflowSession | null>
  refresh: () => void
}

export type NodesApi = {
  nodes: Accessor<DAGNodeSession[]>
  refresh: () => void
}

export type ViolationsApi = {
  violations: Accessor<DAGViolation[]>
  refresh: () => void
}

export type TimelineApi = {
  events: Accessor<DAGTimelineEvent[]>
  refresh: () => void
}

/**
 * useWorkflowList — 获取 session 下所有 workflow 列表
 * 优先 KV fallback，KV 无数据时返回 mock 数据（WP3）
 */
export function useWorkflowList(props: {
  kv: TuiPluginApi["kv"]
  session_id: Accessor<string>
}): WorkflowListApi {
  const [version, setVersion] = createSignal(0)

  const list = createMemo<DAGWorkflowSession[]>(() => {
    version()
    const sid = props.session_id()
    const kvData = props.kv.get<DAGWorkflowSession[]>(kvKeys.workflowList(sid))
    if (kvData && Array.isArray(kvData) && kvData.length > 0) return kvData
    return MOCK_WORKFLOW_LIST
  })

  return {
    list,
    refresh: () => setVersion((v) => v + 1),
  }
}

/**
 * useWorkflow — 获取单个 workflow
 * KV 优先；mock fallback
 */
export function useWorkflow(props: {
  kv: TuiPluginApi["kv"]
  workflowId: Accessor<string | undefined>
}): WorkflowApi {
  const [version, setVersion] = createSignal(0)

  const workflow = createMemo<DAGWorkflowSession | null>(() => {
    version()
    const id = props.workflowId()
    if (!id) return null
    const kvData = props.kv.get<DAGWorkflowSession>(kvKeys.workflow(id))
    if (kvData) return kvData
    return MOCK_WORKFLOWS_INDEX[id] ?? null
  })

  return {
    workflow,
    refresh: () => setVersion((v) => v + 1),
  }
}

/**
 * useNodes — 获取某个 workflow 的所有节点
 */
export function useNodes(props: {
  kv: TuiPluginApi["kv"]
  workflowId: Accessor<string | undefined>
}): NodesApi {
  const [version, setVersion] = createSignal(0)

  const nodes = createMemo<DAGNodeSession[]>(() => {
    version()
    const id = props.workflowId()
    if (!id) return []
    const kvData = props.kv.get<DAGNodeSession[]>(kvKeys.nodes(id))
    if (kvData && Array.isArray(kvData)) return kvData
    const wf = MOCK_WORKFLOWS_INDEX[id]
    return wf ? Object.values(wf.node_sessions) : []
  })

  return {
    nodes,
    refresh: () => setVersion((v) => v + 1),
  }
}

/**
 * useViolations — 获取某个 workflow 的违规记录
 */
export function useViolations(props: {
  kv: TuiPluginApi["kv"]
  workflowId: Accessor<string | undefined>
}): ViolationsApi {
  const [version, setVersion] = createSignal(0)

  const violations = createMemo<DAGViolation[]>(() => {
    version()
    const id = props.workflowId()
    if (!id) return []
    const kvData = props.kv.get<DAGViolation[]>(kvKeys.violations(id))
    if (kvData && Array.isArray(kvData)) return kvData
    const wf = MOCK_WORKFLOWS_INDEX[id]
    return wf?.violations ?? []
  })

  return {
    violations,
    refresh: () => setVersion((v) => v + 1),
  }
}

/**
 * useTimeline — 获取某个 workflow 的时间线事件
 */
export function useTimeline(props: {
  kv: TuiPluginApi["kv"]
  workflowId: Accessor<string | undefined>
}): TimelineApi {
  const [version, setVersion] = createSignal(0)

  const events = createMemo<DAGTimelineEvent[]>(() => {
    version()
    const id = props.workflowId()
    if (!id) return []
    const kvData = props.kv.get<DAGTimelineEvent[]>(kvKeys.timeline(id))
    if (kvData && Array.isArray(kvData)) return kvData
    return MOCK_TIMELINE[id] ?? []
  })

  return {
    events,
    refresh: () => setVersion((v) => v + 1),
  }
}
