/**
 * DAG Workflow 数据抽象层
 *
 * 通过 server 只读路由（SDK `client.dag.*`）拉取 DAG 工作流数据，
 * 并订阅平台事件总线（`api.event`，由 server SSE 推送）做实时刷新。
 *
 * 铁律约束：
 * - TUI 只读：此层只读取，绝不写状态（写必须经 server API + 状态机）
 * - 组件不得直接调用 SDK：所有数据访问都封装在此模块的 hooks 内
 * - 实时更新通过 `api.event` 订阅（dag.workflow.updated / dag.node.updated），
 *   不使用 createResource（按本插件架构约束）
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type {
  DAGConfig,
  DAGNodeConfig,
  DAGNodeSession,
  DAGViolation,
  DAGWorkflowSession,
} from "@/dag/session/types"
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"

type Client = TuiPluginApi["client"]
type EventBus = TuiPluginApi["event"]

// ============================================================================
// SDK → 领域类型映射
//
// SDK 生成的数字字段是 `number | "NaN" | "Infinity" | ...` 联合（OpenAPI 序列化
// 产物），这里统一收敛为 number / number | null。
// ============================================================================

type SdkNumber = number | string

function num(v: SdkNumber | null | undefined, fallback = 0): number {
  if (v === null || v === undefined) return fallback
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function numOrNull(v: SdkNumber | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** SDK DagNode → 领域 DAGNodeSession */
export function mapNode(n: {
  node_id: string
  workflow_id: string
  config: unknown
  status: DAGNodeSession["status"]
  output: unknown
  retry_count: SdkNumber
  max_retries: SdkNumber
  timeout_ms: SdkNumber
  required_nodes: ReadonlyArray<string>
  dependencies: ReadonlyArray<string>
  metadata: Record<string, unknown>
  start_time: SdkNumber | null
  completed_at: string | null
  end_time: SdkNumber | null
  duration_ms: SdkNumber | null
  parent_node: string | null
  created_at: SdkNumber
  updated_at: SdkNumber
}): DAGNodeSession {
  return {
    node_id: n.node_id,
    workflow_id: n.workflow_id,
    config: (n.config ?? {}) as DAGNodeConfig,
    status: n.status,
    output: n.output,
    retry_count: num(n.retry_count),
    max_retries: num(n.max_retries),
    timeout_ms: num(n.timeout_ms),
    required_nodes: [...n.required_nodes],
    dependencies: [...n.dependencies],
    metadata: { ...n.metadata },
    start_time: numOrNull(n.start_time),
    completed_at: n.completed_at ? String(n.completed_at) : null,
    end_time: numOrNull(n.end_time),
    duration_ms: numOrNull(n.duration_ms),
    parent_node: n.parent_node ?? null,
    created_at: num(n.created_at),
    updated_at: num(n.updated_at),
    logs: [],
  }
}

/** SDK DagWorkflow → 领域 DAGWorkflowSession（节点会话单独注入） */
export function mapWorkflow(
  w: {
    id: string
    chat_session_id: string
    config: unknown
    status: DAGWorkflowSession["status"]
    metadata: Record<string, unknown>
    start_time: SdkNumber
    end_time: SdkNumber | null
    current_node: string | null
    created_at: SdkNumber
    updated_at: SdkNumber
    completed_at: SdkNumber | null
    duration_ms: SdkNumber | null
  },
  nodes: DAGNodeSession[] = [],
): DAGWorkflowSession {
  const node_sessions: Record<string, DAGNodeSession> = {}
  for (const n of nodes) node_sessions[n.node_id] = n
  return {
    id: w.id,
    chat_session_id: w.chat_session_id,
    config: (w.config ?? { nodes: [] }) as DAGConfig,
    status: w.status,
    node_sessions,
    violations: [],
    metadata: { ...w.metadata },
    start_time: num(w.start_time),
    end_time: numOrNull(w.end_time),
    current_node: w.current_node ?? null,
    created_at: num(w.created_at),
    updated_at: num(w.updated_at),
    completed_at: numOrNull(w.completed_at),
    duration_ms: numOrNull(w.duration_ms),
  }
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

// ============================================================================
// Hooks
// ============================================================================

/**
 * useWorkflowList — 获取（可按 chat session 过滤的）workflow 列表。
 * 订阅 dag.workflow.updated 做实时刷新。
 */
export function useWorkflowList(props: {
  client: Client
  event: EventBus
  session_id: Accessor<string>
}): WorkflowListApi {
  const [list, setList] = createSignal<DAGWorkflowSession[]>([])
  let cancelled = false

  async function load() {
    const sid = props.session_id()
    const res = await props.client.dag.listWorkflows(sid ? { chatSessionId: sid } : {})
    if (cancelled) return
    const data = res.data
    if (Array.isArray(data)) setList(data.map((w) => mapWorkflow(w)))
  }

  createEffect(() => {
    props.session_id()
    void load()
  })

  const off = props.event.on("dag.workflow.updated", () => void load())
  onCleanup(() => {
    cancelled = true
    off()
  })

  return { list, refresh: () => void load() }
}

/**
 * useWorkflow — 获取单个 workflow 详情（含其节点会话）。
 * 订阅该 workflow 的 dag.workflow.updated / dag.node.updated 做实时刷新。
 */
export function useWorkflow(props: {
  client: Client
  event: EventBus
  workflowId: Accessor<string | undefined>
}): WorkflowApi {
  const [workflow, setWorkflow] = createSignal<DAGWorkflowSession | null>(null)
  let cancelled = false

  async function load() {
    const id = props.workflowId()
    if (!id) {
      setWorkflow(null)
      return
    }
    const res = await props.client.dag.getWorkflow({ workflowId: id })
    if (cancelled) return
    const detail = res.data
    if (detail?.workflow) {
      const nodes = (detail.nodes ?? []).map(mapNode)
      setWorkflow(mapWorkflow(detail.workflow, nodes))
    } else {
      setWorkflow(null)
    }
  }

  createEffect(() => {
    props.workflowId()
    void load()
  })

  const matches = (wfID: string) => wfID === props.workflowId()
  const offW = props.event.on("dag.workflow.updated", (e) => {
    if (matches(e.properties.workflowID)) void load()
  })
  const offN = props.event.on("dag.node.updated", (e) => {
    if (matches(e.properties.workflowID)) void load()
  })
  onCleanup(() => {
    cancelled = true
    offW()
    offN()
  })

  return { workflow, refresh: () => void load() }
}

/**
 * useNodes — 获取某个 workflow 的所有节点会话。
 * 与 useWorkflow 共享 getWorkflow 路由，订阅 dag.node.updated 做实时刷新。
 */
export function useNodes(props: {
  client: Client
  event: EventBus
  workflowId: Accessor<string | undefined>
}): NodesApi {
  const [nodes, setNodes] = createSignal<DAGNodeSession[]>([])
  let cancelled = false

  async function load() {
    const id = props.workflowId()
    if (!id) {
      setNodes([])
      return
    }
    const res = await props.client.dag.getWorkflow({ workflowId: id })
    if (cancelled) return
    const detail = res.data
    setNodes((detail?.nodes ?? []).map(mapNode))
  }

  createEffect(() => {
    props.workflowId()
    void load()
  })

  const matches = (wfID: string) => wfID === props.workflowId()
  const offW = props.event.on("dag.workflow.updated", (e) => {
    if (matches(e.properties.workflowID)) void load()
  })
  const offN = props.event.on("dag.node.updated", (e) => {
    if (matches(e.properties.workflowID)) void load()
  })
  onCleanup(() => {
    cancelled = true
    offW()
    offN()
  })

  return { nodes, refresh: () => void load() }
}

/**
 * useViolations — workflow 违规记录。
 *
 * server 目前未暴露独立的 violations 只读路由，故此 hook 返回空集合，
 * 保留接口以便后续 server 增加 `/dag/workflows/:id/violations` 后接入。
 */
export function useViolations(_props: {
  workflowId: Accessor<string | undefined>
}): ViolationsApi {
  const [violations] = createSignal<DAGViolation[]>([])
  return { violations, refresh: () => {} }
}
