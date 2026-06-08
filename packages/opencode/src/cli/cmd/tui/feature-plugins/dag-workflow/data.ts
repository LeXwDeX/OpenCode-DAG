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
  DAGNodeError,
  DAGNodeMetrics,
  DAGNodeSession,
  DAGViolation,
  DAGWorkflowSession,
  DAGWorkflowStatus,
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

/** SDK DagNodeMetrics → 领域 DAGNodeMetrics（规范化 SdkNumber，丢弃非有限/缺省字段） */
function mapMetrics(m: {
  cpu_percent?: SdkNumber | null
  memory_mb?: SdkNumber | null
  disk_io_mb?: SdkNumber | null
  network_io_mb?: SdkNumber | null
}): DAGNodeMetrics {
  const out: DAGNodeMetrics = {}
  const cpu = numOrNull(m.cpu_percent)
  if (cpu !== null) out.cpu_percent = cpu
  const mem = numOrNull(m.memory_mb)
  if (mem !== null) out.memory_mb = mem
  const disk = numOrNull(m.disk_io_mb)
  if (disk !== null) out.disk_io_mb = disk
  const net = numOrNull(m.network_io_mb)
  if (net !== null) out.network_io_mb = net
  return out
}

/** SDK DagNode → 领域 DAGNodeSession */
export function mapNode(n: {
  node_id: string
  workflow_id: string
  config: unknown
  status: DAGNodeSession["status"]
  output: unknown
  error_info?: DAGNodeError | null
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
  logs?: ReadonlyArray<string> | null
  metrics?: {
    cpu_percent?: SdkNumber | null
    memory_mb?: SdkNumber | null
    disk_io_mb?: SdkNumber | null
    network_io_mb?: SdkNumber | null
  } | null
}): DAGNodeSession {
  return {
    node_id: n.node_id,
    workflow_id: n.workflow_id,
    config: (n.config ?? {}) as DAGNodeConfig,
    status: n.status,
    output: n.output,
    ...(n.error_info ? { error_info: n.error_info } : {}),
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
    logs: n.logs ? [...n.logs] : [],
    ...(n.metrics ? { metrics: mapMetrics(n.metrics) } : {}),
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

/** SDK DagViolation → 领域 DAGViolation（规范化可选字段） */
export function mapViolation(v: {
  id: string
  workflowId: string
  nodeId?: string | null
  type: DAGViolation["type"]
  severity: DAGViolation["severity"]
  message: string
  timestamp: string
  details?: Record<string, unknown> | null
}): DAGViolation {
  return {
    id: v.id,
    workflowId: v.workflowId,
    ...(v.nodeId ? { nodeId: v.nodeId } : {}),
    type: v.type,
    severity: v.severity,
    message: v.message,
    timestamp: v.timestamp,
    ...(v.details ? { details: v.details } : {}),
  }
}

/**
 * 按状态 + 名称/ID 子串过滤工作流列表（纯函数，供 console-route 受控过滤与测试复用）。
 * search 大小写不敏感，匹配 config.name（缺省回退 id）。
 */
export function filterWorkflows(
  list: DAGWorkflowSession[],
  statusFilter: DAGWorkflowStatus | null,
  search: string,
): DAGWorkflowSession[] {
  let out = list
  if (statusFilter) out = out.filter((w) => w.status === statusFilter)
  const q = search.trim().toLowerCase()
  if (q) out = out.filter((w) => (w.config?.name ?? w.id).toLowerCase().includes(q))
  return out
}

/**
 * 键盘导航的纯索引数学：在长度 length 的列表中，从当前索引 curIdx 移动 delta。
 * - length===0 → -1（调用方应先守卫）
 * - curIdx<0（无选中）→ delta>0 取首项 0，否则取末项
 * - 否则在 [0, length-1] 内 clamp(curIdx+delta)
 */
export function nextIndex(length: number, curIdx: number, delta: number): number {
  if (length === 0) return -1
  if (curIdx < 0) return delta > 0 ? 0 : length - 1
  return Math.min(length - 1, Math.max(0, curIdx + delta))
}

// ============================================================================
// Hooks 公共签名
// ============================================================================

export type WorkflowListApi = {
  list: Accessor<DAGWorkflowSession[]>
  error: Accessor<string | null>
  loading: Accessor<boolean>
  refresh: () => void
}

export type WorkflowDetailApi = {
  workflow: Accessor<DAGWorkflowSession | null>
  nodes: Accessor<DAGNodeSession[]>
  error: Accessor<string | null>
  loading: Accessor<boolean>
  refresh: () => void
}

export type ViolationsApi = {
  violations: Accessor<DAGViolation[]>
  error: Accessor<string | null>
  refresh: () => void
}

export type WorkflowHistory = {
  history_id: string
  workflow_id: string
  chat_session_id: string
  action: string
  old_state: unknown
  new_state: unknown
  change_details: unknown
  changed_by: string | null
  created_at: string
}

export type NodeLog = {
  log_id: string
  node_id: string
  workflow_id: string
  chat_session_id: string
  log_level: string
  log_message: string
  log_data: unknown
  execution_phase: string | null
  created_at: string
}

export type WorkflowHistoryApi = {
  history: Accessor<WorkflowHistory[]>
  error: Accessor<string | null>
  loading: Accessor<boolean>
  refresh: () => void
}

export type NodeLogsApi = {
  logs: Accessor<NodeLog[]>
  error: Accessor<string | null>
  loading: Accessor<boolean>
  refresh: () => void
}

export type NodeAskMainPayload = {
  workflowID: string
  nodeID: string
  chatSessionID?: string
  question: string
  context?: string
  timestamp: number
}

export type NodeAskMainApi = {
  lastQuestion: Accessor<NodeAskMainPayload | null>
  clear: () => void
}

// ============================================================================
// Timeline / GraphStats 领域类型（WP-TUI-4）
// ============================================================================

export type TimelineEventType = "node_start" | "node_complete" | "node_failed" | "edge_traversal"

export type TimelineEvent = {
  type: TimelineEventType
  nodeId: string
  timestamp: number
  duration: number | null
  metadata?: Record<string, unknown>
}

export type NodeExecutionTime = {
  nodeId: string
  nodeName: string
  startTime: number
  endTime: number
  duration: number
  status: "pending" | "queued" | "running" | "completed" | "failed" | "skipped"
}

export type Timeline = {
  workflowId: string
  startTime: number
  endTime: number | null
  events: TimelineEvent[]
  totalDuration: number
  nodeExecutionTimes: Record<string, NodeExecutionTime>
}

export type GraphStats = {
  totalNodes: number
  totalEdges: number
  criticalPathLength: number
  parallelismDegree: number
  estimatedCompletionTime: number
}

export type WorkflowTimelineApi = {
  timeline: Accessor<Timeline | null>
  error: Accessor<string | null>
  loading: Accessor<boolean>
  refresh: () => void
}

export type WorkflowStatsApi = {
  stats: Accessor<GraphStats | null>
  error: Accessor<string | null>
  loading: Accessor<boolean>
  refresh: () => void
}

export function mapWorkflowHistory(h: {
  history_id: string
  workflow_id: string
  chat_session_id: string
  action: string
  old_state: unknown
  new_state: unknown
  change_details: unknown
  changed_by: string | null
  created_at: string
}): WorkflowHistory {
  return {
    history_id: h.history_id,
    workflow_id: h.workflow_id,
    chat_session_id: h.chat_session_id,
    action: h.action,
    old_state: h.old_state,
    new_state: h.new_state,
    change_details: h.change_details,
    changed_by: h.changed_by,
    created_at: h.created_at,
  }
}

export function mapNodeLog(log: {
  log_id: string
  node_id: string
  workflow_id: string
  chat_session_id: string
  log_level: string
  log_message: string
  log_data: unknown
  execution_phase: string | null
  created_at: string
}): NodeLog {
  return {
    log_id: log.log_id,
    node_id: log.node_id,
    workflow_id: log.workflow_id,
    chat_session_id: log.chat_session_id,
    log_level: log.log_level,
    log_message: log.log_message,
    log_data: log.log_data,
    execution_phase: log.execution_phase,
    created_at: log.created_at,
  }
}

/** SDK DagTimeline → 领域 Timeline（SdkNumber 收敛） */
export function mapTimeline(t: {
  workflowId: string
  startTime: SdkNumber
  endTime: SdkNumber | null
  events: ReadonlyArray<{
    type: TimelineEventType
    nodeId: string
    timestamp: SdkNumber
    duration?: SdkNumber | null
    metadata?: Record<string, unknown>
  }>
  totalDuration: SdkNumber
  nodeExecutionTimes?: Record<
    string,
    {
      nodeId: string
      nodeName: string
      startTime: SdkNumber
      endTime: SdkNumber
      duration: SdkNumber
      status: NodeExecutionTime["status"]
    }
  >
}): Timeline {
  return {
    workflowId: t.workflowId,
    startTime: num(t.startTime),
    endTime: numOrNull(t.endTime),
    events: t.events.map((e) => ({
      type: e.type,
      nodeId: e.nodeId,
      timestamp: num(e.timestamp),
      duration: numOrNull(e.duration),
      ...(e.metadata ? { metadata: e.metadata } : {}),
    })),
    totalDuration: num(t.totalDuration),
    nodeExecutionTimes: Object.fromEntries(
      Object.entries(t.nodeExecutionTimes ?? {}).map(([k, v]) => [
        k,
        {
          nodeId: v.nodeId,
          nodeName: v.nodeName,
          startTime: num(v.startTime),
          endTime: num(v.endTime),
          duration: num(v.duration),
          status: v.status,
        } as NodeExecutionTime,
      ]),
    ),
  }
}

/** SDK DagGraphStatistics → 领域 GraphStats（SdkNumber 收敛） */
export function mapGraphStats(s: {
  totalNodes: SdkNumber
  totalEdges: SdkNumber
  criticalPathLength: SdkNumber
  parallelismDegree: SdkNumber
  estimatedCompletionTime: SdkNumber
}): GraphStats {
  return {
    totalNodes: num(s.totalNodes),
    totalEdges: num(s.totalEdges),
    criticalPathLength: num(s.criticalPathLength),
    parallelismDegree: num(s.parallelismDegree),
    estimatedCompletionTime: num(s.estimatedCompletionTime),
  }
}

export function useWorkflowHistory(props: {
  client: Client
  event: EventBus
  workflowId: Accessor<string | undefined>
}): WorkflowHistoryApi {
  const [history, setHistory] = createSignal<WorkflowHistory[]>([])
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  let cancelled = false
  let gen = 0

  async function load() {
    const id = props.workflowId()
    if (!id) {
      gen++
      setHistory([])
      setError(null)
      setLoading(false)
      return
    }
    const my = ++gen
    setLoading(true)
    try {
      const res = await props.client.dag.getWorkflowHistory({ workflowId: id, limit: "50" })
      if (cancelled || my !== gen) return
      setHistory((res.data ?? []).map(mapWorkflowHistory))
      setError(null)
    } catch (e) {
      if (cancelled || my !== gen) return
      setError(errMessage(e))
    } finally {
      if (!cancelled && my === gen) setLoading(false)
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
  const offR = props.event.on("dag.workflow.replanned", (e) => {
    if (matches(e.properties.workflowID)) void load()
  })
  const offN = props.event.on("dag.node.updated", (e) => {
    if (matches(e.properties.workflowID)) void load()
  })
  const offP = props.event.on("dag.node.progress", (e) => {
    if (matches(e.properties.workflowID)) void load()
  })
  onCleanup(() => {
    cancelled = true
    offW()
    offR()
    offN()
    offP()
  })

  return { history, error, loading, refresh: () => void load() }
}

export function useNodeLogs(props: {
  client: Client
  event: EventBus
  nodeId: Accessor<string | null | undefined>
}): NodeLogsApi {
  const [logs, setLogs] = createSignal<NodeLog[]>([])
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  let cancelled = false
  let gen = 0

  async function load() {
    const id = props.nodeId()
    if (!id) {
      gen++
      setLogs([])
      setError(null)
      setLoading(false)
      return
    }
    const my = ++gen
    setLoading(true)
    try {
      const res = await props.client.dag.getNodeLogs({ nodeId: id, limit: "100" })
      if (cancelled || my !== gen) return
      setLogs((res.data ?? []).map(mapNodeLog))
      setError(null)
    } catch (e) {
      if (cancelled || my !== gen) return
      setError(errMessage(e))
    } finally {
      if (!cancelled && my === gen) setLoading(false)
    }
  }

  createEffect(() => {
    props.nodeId()
    void load()
  })

  const matches = (nodeID: string) => nodeID === props.nodeId()
  const offN = props.event.on("dag.node.updated", (e) => {
    if (matches(e.properties.nodeID)) void load()
  })
  const offP = props.event.on("dag.node.progress", (e) => {
    if (matches(e.properties.nodeID)) void load()
  })
  onCleanup(() => {
    cancelled = true
    offN()
    offP()
  })

  return { logs, error, loading, refresh: () => void load() }
}

/**
 * useWorkflowTimeline — 工作流执行时间线（WP-TUI-4）。
 *
 * 通过 SDK 只读路由 client.dag.getTimeline({workflowId}) 拉取节点执行时间戳
 * 事件序列与节点耗时数据。订阅 dag.node.updated / dag.workflow.updated /
 * dag.workflow.replanned / dag.node.progress 四个事件做读侧轮询刷新
 * （不违反 §10.e Option C no-interrupt，因只做只读拉取）。
 */
export function useWorkflowTimeline(props: {
  client: Client
  event: EventBus
  workflowId: Accessor<string | undefined>
}): WorkflowTimelineApi {
  const [timeline, setTimeline] = createSignal<Timeline | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  let cancelled = false
  let gen = 0

  async function load() {
    const id = props.workflowId()
    if (!id) {
      gen++
      setTimeline(null)
      setError(null)
      setLoading(false)
      return
    }
    const my = ++gen
    setLoading(true)
    try {
      const res = await props.client.dag.getTimeline({ workflowId: id })
      if (cancelled || my !== gen) return
      setTimeline(res.data ? mapTimeline(res.data) : null)
      setError(null)
    } catch (e) {
      if (cancelled || my !== gen) return
      setError(errMessage(e))
    } finally {
      if (!cancelled && my === gen) setLoading(false)
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
  const offR = props.event.on("dag.workflow.replanned", (e) => {
    if (matches(e.properties.workflowID)) void load()
  })
  const offN = props.event.on("dag.node.updated", (e) => {
    if (matches(e.properties.workflowID)) void load()
  })
  const offP = props.event.on("dag.node.progress", (e) => {
    if (matches(e.properties.workflowID)) void load()
  })
  onCleanup(() => {
    cancelled = true
    offW()
    offR()
    offN()
    offP()
  })

  return { timeline, error, loading, refresh: () => void load() }
}

/**
 * useWorkflowStats — DAG 图统计（WP-TUI-4）。
 *
 * 通过 SDK 只读路由 client.dag.getStats({workflowId}) 拉取节点总数、边总数、
 * 关键路径长度、并行度和预计完成时间。事件刷新策略与 useWorkflowTimeline 一致。
 */
export function useWorkflowStats(props: {
  client: Client
  event: EventBus
  workflowId: Accessor<string | undefined>
}): WorkflowStatsApi {
  const [stats, setStats] = createSignal<GraphStats | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  let cancelled = false
  let gen = 0

  async function load() {
    const id = props.workflowId()
    if (!id) {
      gen++
      setStats(null)
      setError(null)
      setLoading(false)
      return
    }
    const my = ++gen
    setLoading(true)
    try {
      const res = await props.client.dag.getStats({ workflowId: id })
      if (cancelled || my !== gen) return
      setStats(res.data ? mapGraphStats(res.data) : null)
      setError(null)
    } catch (e) {
      if (cancelled || my !== gen) return
      setError(errMessage(e))
    } finally {
      if (!cancelled && my === gen) setLoading(false)
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
  const offR = props.event.on("dag.workflow.replanned", (e) => {
    if (matches(e.properties.workflowID)) void load()
  })
  const offN = props.event.on("dag.node.updated", (e) => {
    if (matches(e.properties.workflowID)) void load()
  })
  const offP = props.event.on("dag.node.progress", (e) => {
    if (matches(e.properties.workflowID)) void load()
  })
  onCleanup(() => {
    cancelled = true
    offW()
    offR()
    offN()
    offP()
  })

  return { stats, error, loading, refresh: () => void load() }
}

export async function pauseWorkflow(client: Client, workflowId: string) {
  return client.dag.pause({ workflowId })
}

export async function resumeWorkflow(client: Client, workflowId: string) {
  return client.dag.resume({ workflowId })
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * useWorkflowList — 获取（可按 chat session 过滤的）workflow 列表。
 * 订阅 dag.workflow.updated 做实时刷新。
 *
 * 竞态防护：每次 load 领取自增 generation 令牌，仅最新一次的响应可写回 signal，
 * 避免快速切换/并发刷新时旧的慢响应覆盖新数据。
 */
export function useWorkflowList(props: {
  client: Client
  event: EventBus
  session_id: Accessor<string>
}): WorkflowListApi {
  const [list, setList] = createSignal<DAGWorkflowSession[]>([])
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  let cancelled = false
  let gen = 0

  async function load() {
    const sid = props.session_id()
    const my = ++gen
    setLoading(true)
    try {
      const res = await props.client.dag.listWorkflows(sid ? { chatSessionId: sid } : {})
      if (cancelled || my !== gen) return
      const data = res.data
      if (Array.isArray(data)) setList(data.map((w) => mapWorkflow(w)))
      setError(null)
    } catch (e) {
      if (cancelled || my !== gen) return
      setError(errMessage(e))
    } finally {
      if (!cancelled && my === gen) setLoading(false)
    }
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

  return { list, error, loading, refresh: () => void load() }
}

/**
 * useWorkflowDetail — 单次 getWorkflow 同时供给 workflow 详情与节点列表。
 *
 * 合并了旧的 useWorkflow + useNodes：二者原本各自独立调用同一 getWorkflow 路由，
 * 造成每次选中/每个事件 2× 冗余请求。此 hook 单次拉取，workflow 与 nodes 共享。
 *
 * 订阅该 workflow 的 dag.workflow.updated / dag.node.updated 做实时刷新。
 * 同样使用 generation 令牌做竞态防护。
 */
export function useWorkflowDetail(props: {
  client: Client
  event: EventBus
  workflowId: Accessor<string | undefined>
}): WorkflowDetailApi {
  const [workflow, setWorkflow] = createSignal<DAGWorkflowSession | null>(null)
  const [nodes, setNodes] = createSignal<DAGNodeSession[]>([])
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  let cancelled = false
  let gen = 0

  async function load() {
    const id = props.workflowId()
    if (!id) {
      gen++
      setWorkflow(null)
      setNodes([])
      setError(null)
      setLoading(false)
      return
    }
    const my = ++gen
    setLoading(true)
    try {
      const res = await props.client.dag.getWorkflow({ workflowId: id })
      if (cancelled || my !== gen) return
      const detail = res.data
      const ns = (detail?.nodes ?? []).map(mapNode)
      if (detail?.workflow) {
        setWorkflow(mapWorkflow(detail.workflow, ns))
        setNodes(ns)
      } else {
        setWorkflow(null)
        setNodes([])
      }
      setError(null)
    } catch (e) {
      if (cancelled || my !== gen) return
      setError(errMessage(e))
    } finally {
      if (!cancelled && my === gen) setLoading(false)
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

  return { workflow, nodes, error, loading, refresh: () => void load() }
}

/**
 * useViolations — workflow 违规记录。
 *
 * 通过 SDK 只读路由 client.dag.getViolations({workflowId}) 拉取。
 * 订阅 dag.workflow.updated / dag.node.updated 事件作为刷新信号
 * （违规通常伴随节点状态变更发生）。
 */
export function useViolations(props: {
  client: Client
  event: EventBus
  workflowId: Accessor<string | undefined>
}): ViolationsApi {
  const [violations, setViolations] = createSignal<DAGViolation[]>([])
  const [error, setError] = createSignal<string | null>(null)
  let cancelled = false
  let gen = 0

  async function load() {
    const id = props.workflowId()
    if (!id) {
      gen++
      setViolations([])
      setError(null)
      return
    }
    const my = ++gen
    try {
      const res = await props.client.dag.getViolations({ workflowId: id })
      if (cancelled || my !== gen) return
      setViolations((res.data ?? []).map(mapViolation))
      setError(null)
    } catch (e) {
      if (cancelled || my !== gen) return
      setError(errMessage(e))
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

  return { violations, error, refresh: () => void load() }
}

/**
 * useNodeAskMain — 订阅 dag.node.ask_main 事件，将最新节点提问暴露为 signal。
 *
 * 仅监听事件（无 SDK 拉取）；通过 workflowId 过滤当前工作流的事件。
 * 消费方典型用法：createEffect 观察 lastQuestion，触发 toast / 自动跳转后调 clear()。
 */
export function useNodeAskMain(props: {
  event: EventBus
  workflowId: Accessor<string | undefined>
}): NodeAskMainApi {
  const [lastQuestion, setLastQuestion] = createSignal<NodeAskMainPayload | null>(null)
  const off = props.event.on("dag.node.ask_main", (e) => {
    const wfId = props.workflowId()
    if (wfId && e.properties.workflowID === wfId) {
      setLastQuestion({
        workflowID: e.properties.workflowID,
        nodeID: e.properties.nodeID,
        chatSessionID: e.properties.chatSessionID,
        question: e.properties.question,
        context: e.properties.context,
        timestamp: num(e.properties.timestamp),
      })
    }
  })
  onCleanup(off)
  return { lastQuestion, clear: () => setLastQuestion(null) }
}
