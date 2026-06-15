/**
 * i18n — 双语支持（en/zh），仅用于 DAG 工作流插件面板
 *
 * 数据源：`props.api.tuiConfig.lang`（opencode.json 的 `lang` 字段，默认 en）。
 *
 * 暴露：
 * - `t(lang, key)`                          — 静态翻译函数
 * - `workflowStatusLabel(lang, status)`      — 工作流状态翻译
 * - `nodeStatusLabel(lang, status)`          — 节点状态翻译
 * - `useLang(api)`                           — reactive accessor：返回 () => I18n
 */
import { createMemo } from "solid-js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { DAG_VIOLATION_TYPES, type DAGViolationType } from "@/dag/session/types"

export type Lang = "en" | "zh"

export type WorkflowStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "paused"

export type NodeStatus = "pending" | "queued" | "running" | "completed" | "failed" | "skipped" | "recoverable"

// Exported for the glyph robustness guard (glyphs.test.ts) which scans every
// dict value: en must be pure ASCII, zh must avoid EA-Ambiguous punctuation.
export const DICT = {
  en: {
    tab_dialogue: "Chat",
    tab_workflow: "DAG Workflow",
    view_tree: "Tree View",
    view_ascii: "ASCII DAG",
    esc_back: "[Esc] Back",
    label_status: "Status",
    label_progress: "Progress",
    label_duration: "Duration",
    label_no_nodes: "No nodes in this workflow",
    label_no_workflows: "No workflows",
    label_select_workflow: "Select a workflow from the list",
    label_loading: "Loading...",
    label_load_error: "Failed to load",
    label_search: "Search:",
    label_retries: "Retries",
    label_deps: "Deps",
    label_error: "Error",
    label_timing: "Timing",
    label_start_time: "Start",
    label_end_time: "End",
    label_completed_at: "Completed",
    label_output: "Output",
    label_snapshot_logs: "Snapshot logs",
    title_workflow_history: "Workflow History",
    title_node_logs: "Node Logs",
    history_empty: "No history",
    node_logs_empty: "No node logs",
    filter_all: "All",
    title_violations: "Violations",
    cmd_open_title: "Open DAG Workflow",
    node_select_hint: "Select a node",
    node_subsession_unavailable: "[Sub-session not available]",
    node_enter_subsession: "[Enter Sub-Session ->]",
    action_close: "[Close]",
    hint_hotkey_bar: "[Tab] Switch pane  [j/k] Move  [Enter] Select  [/] Search  [Leader+v] Toggle View  [Leader+p] Pause/Resume  [[/]] Sidebar  [Esc] Back",
    label_focus: "Focus:",
    focus_history: "History",
    focus_graph: "Graph",
    label_node: "Node:",
    ticker_live: "Live:",
    ticker_idle: "Idle",
    ticker_reasoning: "reasoning...",
    title_timeline: "Timeline",
    label_timeline: "Timeline",
    label_stats: "Stats",
    label_critical_path: "Critical",
    label_parallelism: "Parallel",
    label_eta: "ETA",
    timeline_empty: "No timeline events",
    label_tool_calls: "Tool Calls",
    label_violations: "Violations",
    label_no_violations: "No violations",
    ctrl_start: "[Start]",
    ctrl_pause: "[Pause]",
    ctrl_resume: "[Resume]",
    ctrl_cancel: "[Cancel]",
    ctrl_replan: "[Replan]",
    ctrl_step: "[Step]",
    ctrl_new: "[+ New]",
    dlg_cancel_title: "Cancel workflow",
    dlg_cancel_msg: "Cancelling is irreversible. Continue?",
    dlg_replan_title: "Replan workflow",
    dlg_replan_ph: "1-10",
    replan_concurrency: "Change Concurrency",
    replan_add_node: "Add Node",
    replan_remove_node: "Remove Node",
    replan_update_node: "Update Node Config",
    dlg_concurrency_title: "Set Max Concurrency (1-10)",
    dlg_concurrency_ph: "Enter number 1-10",
    dlg_add_node_title: "Add Node (JSON config)",
    dlg_add_node_ph: '{"id":"new","dependencies":["A"],"worker_type":"general","worker_config":{"prompt":"task"}}',
    dlg_remove_node_title: "Select Node to Remove",
    dlg_update_node_title: "Select Node to Update",
    dlg_update_node_prompt: "Update Node Config (JSON patch)",
    dlg_update_node_ph: '{"worker_config":{"prompt":"new task"}}',
    dlg_confirm_remove_title: "Confirm Removal",
    dlg_confirm_remove_msg: "Remove node '{node}'? Running nodes will be cascaded.",
    toast_node_added: "Node added",
    toast_node_removed: "Node removed",
    toast_node_updated: "Node updated",
    toast_invalid_json: "Invalid JSON format",
    toast_missing_node_id: "Node config requires 'id' field",
    toast_no_nodes: "No nodes available",
    toast_replan_error: "Replan failed",
    dlg_create_title: "Choose a template",
    dlg_goal_title: "Workflow goal",
    dlg_goal_ph: "Describe the goal",
    dlg_scope_title: "Scope (optional)",
    dlg_scope_ph: "e.g., frontend only, API layer",
    dlg_context_title: "Context (optional)",
    dlg_context_ph: "e.g., using React 19, TypeScript strict mode",
    toast_created: "Workflow created (pending). Start it via a chat turn.",
    toast_created_pending_start: "Workflow created (pending). Use [Start] to run it.",
    toast_replan_range: "Concurrency must be between 1 and 10",
    toast_create_error: "Failed to create workflow",
    toast_action_error: "Action failed",
    recoverable_action_hint: "Use dagworker replan to replace this node",
  },
  zh: {
    tab_dialogue: "对话",
    tab_workflow: "DAG 工作流",
    view_tree: "树状视图",
    view_ascii: "ASCII 图",
    esc_back: "[Esc] 返回",
    label_status: "状态",
    label_progress: "进度",
    label_duration: "耗时",
    label_no_nodes: "当前工作流没有节点",
    label_no_workflows: "没有工作流",
    label_select_workflow: "请从左侧列表选择一个工作流",
    label_loading: "加载中...",
    label_load_error: "加载失败",
    label_search: "搜索：",
    label_retries: "重试",
    label_deps: "依赖",
    label_error: "错误",
    label_timing: "时间",
    label_start_time: "开始",
    label_end_time: "结束",
    label_completed_at: "完成",
    label_output: "输出",
    label_snapshot_logs: "快照日志",
    title_workflow_history: "工作流历史",
    title_node_logs: "节点日志",
    history_empty: "暂无历史",
    node_logs_empty: "暂无节点日志",
    filter_all: "全部",
    title_violations: "违规记录",
    cmd_open_title: "打开 DAG 工作流面板",
    node_select_hint: "请选择一个节点",
    node_subsession_unavailable: "[暂不可进入子会话]",
    node_enter_subsession: "[进入子会话 ->]",
    action_close: "[关闭]",
    hint_hotkey_bar: "[Tab] 切换窗格  [j/k] 移动  [Enter] 选择  [/] 搜索  [Leader+v] 切换视图  [Leader+p] 暂停  [[/]] 侧边栏  [Esc] 返回",
    label_focus: "焦点：",
    focus_history: "列表",
    focus_graph: "图形",
    label_node: "节点：",
    ticker_live: "实时：",
    ticker_idle: "空闲",
    ticker_reasoning: "推理中...",
    title_timeline: "时间线",
    label_timeline: "时间线",
    label_stats: "统计",
    label_critical_path: "关键路径",
    label_parallelism: "并行度",
    label_eta: "预计完成",
    timeline_empty: "暂无时间线事件",
    label_tool_calls: "工具调用",
    label_violations: "违规",
    label_no_violations: "无违规",
    ctrl_start: "[启动]",
    ctrl_pause: "[暂停]",
    ctrl_resume: "[恢复]",
    ctrl_cancel: "[取消]",
    ctrl_replan: "[调整并发]",
    ctrl_step: "[单步]",
    ctrl_new: "[+ 新建]",
    dlg_cancel_title: "取消工作流",
    dlg_cancel_msg: "取消不可逆，确认继续？",
    dlg_replan_title: "重新规划工作流",
    dlg_replan_ph: "1-10",
    replan_concurrency: "修改并发数",
    replan_add_node: "添加节点",
    replan_remove_node: "移除节点",
    replan_update_node: "更新节点配置",
    dlg_concurrency_title: "设置最大并发数 (1-10)",
    dlg_concurrency_ph: "输入 1-10 的数字",
    dlg_add_node_title: "添加节点（JSON 配置）",
    dlg_add_node_ph: '{"id":"new","dependencies":["A"],"worker_type":"general","worker_config":{"prompt":"task"}}',
    dlg_remove_node_title: "选择要移除的节点",
    dlg_update_node_title: "选择要更新的节点",
    dlg_update_node_prompt: "更新节点配置（JSON 补丁）",
    dlg_update_node_ph: '{"worker_config":{"prompt":"new task"}}',
    dlg_confirm_remove_title: "确认移除",
    dlg_confirm_remove_msg: "移除节点 '{node}'？运行中节点将被级联影响。",
    toast_node_added: "节点已添加",
    toast_node_removed: "节点已移除",
    toast_node_updated: "节点已更新",
    toast_invalid_json: "JSON 格式无效",
    toast_missing_node_id: "节点配置需要 'id' 字段",
    toast_no_nodes: "没有可用节点",
    toast_replan_error: "重规划失败",
    dlg_create_title: "选择模板",
    dlg_goal_title: "工作流目标",
    dlg_goal_ph: "描述目标",
    dlg_scope_title: "范围（可选）",
    dlg_scope_ph: "例如：仅前端、API层",
    dlg_context_title: "上下文（可选）",
    dlg_context_ph: "例如：使用React 19、TypeScript严格模式",
    toast_created: "工作流已创建（待启动），请通过对话轮启动。",
    toast_created_pending_start: "工作流已创建（待启动），请使用 [Start] 运行。",
    toast_replan_range: "并发数必须在 1 到 10 之间",
    toast_create_error: "创建工作流失败",
    toast_action_error: "操作失败",
    recoverable_action_hint: "使用 dagworker replan 替换此节点",
  },
} as const

const WORKFLOW_STATUS_ZH: Record<WorkflowStatus, string> = {
  pending: "等待中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  paused: "已暂停",
}

const NODE_STATUS_ZH: Record<NodeStatus, string> = {
  pending: "等待中",
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
  recoverable: "可恢复",
}

export type ViolationType = DAGViolationType

export type ViolationSeverity = "info" | "warning" | "error" | "critical"

const VIOLATION_TYPE_LABEL: Record<Lang, Record<ViolationType, string>> = {
  en: {
    required_node_skipped: "Required node skipped",
    required_node_failed: "Required node failed",
    max_nodes_exceeded: "Max nodes exceeded",
    max_concurrency_exceeded: "Max concurrency exceeded",
    timeout_exceeded: "Timeout exceeded",
    execution_failed: "Execution failed",
    process_orphan: "Process orphan (recovered at startup)",
    condition_skipped: "Condition evaluated to false",
    subdag_depth_exceeded: "Sub-DAG recursion depth exceeded (max 3)",
    subdag_timeout: "Sub-DAG did not converge within timeout",
  },
  zh: {
    required_node_skipped: "必需节点被跳过",
    required_node_failed: "必需节点失败",
    max_nodes_exceeded: "超出最大节点数",
    max_concurrency_exceeded: "超出最大并发数",
    timeout_exceeded: "超时",
    execution_failed: "执行失败",
    process_orphan: "进程孤儿（启动时恢复）",
    condition_skipped: "条件求值为假",
    subdag_depth_exceeded: "子 DAG 递归深度超限（最大 3 层）",
    subdag_timeout: "子 DAG 未在超时时间内收敛",
  },
}

const VIOLATION_SEVERITY_LABEL: Record<Lang, Record<ViolationSeverity, string>> = {
  en: { info: "info", warning: "warning", error: "error", critical: "critical" },
  zh: { info: "提示", warning: "警告", error: "错误", critical: "严重" },
}

export function violationTypeLabel(lang: Lang, type: ViolationType): string {
  return VIOLATION_TYPE_LABEL[lang][type] ?? type
}

export function violationSeverityLabel(lang: Lang, severity: ViolationSeverity): string {
  return VIOLATION_SEVERITY_LABEL[lang][severity] ?? severity
}

export type I18nKey = keyof typeof DICT.en

export type I18n = {
  readonly lang: Lang
  readonly t: (key: I18nKey) => string
  readonly workflowStatus: (s: WorkflowStatus) => string
  readonly nodeStatus: (s: NodeStatus) => string
}

export function t(lang: Lang, key: I18nKey): string {
  return DICT[lang][key]
}

export function workflowStatusLabel(lang: Lang, s: WorkflowStatus): string {
  return lang === "zh" ? WORKFLOW_STATUS_ZH[s] : s
}

export function nodeStatusLabel(lang: Lang, s: NodeStatus): string {
  return lang === "zh" ? NODE_STATUS_ZH[s] : s
}

/**
 * 将节点 error_info 渲染为用户可读的错误说明（TUI-ERR 友好化）。
 *
 * error_info 在 DB 里实际是字符串（引擎存的是 error.message），
 * 形如 "node exceeded timeout_ms=1800000"。直接显示英文技术消息对中文用户
 * 不可读（用户反馈"点进去就是一串英文"）。本函数：
 * 1. 防御性处理：兼容 string / DAGNodeError 对象 / null
 * 2. 按已知模式匹配，给出中英文友好描述 + 提取关键参数（如超时毫秒→分钟）
 * 3. 未知错误回退到原始消息（不丢失信息）
 *
 * 返回单行字符串，供 NodeDialog 直接渲染。
 */
export function formatNodeError(lang: Lang, errorInfo: unknown): string {
  // 提取原始消息文本
  let raw = ""
  if (typeof errorInfo === "string") {
    raw = errorInfo
  } else if (errorInfo && typeof errorInfo === "object") {
    const obj = errorInfo as { message?: string; type?: string; details?: unknown }
    raw = obj.message ?? obj.type ?? JSON.stringify(obj)
  }
  if (!raw) return ""

  // 已知错误模式的友好映射
  // 超时：node exceeded timeout_ms=NNNN
  const timeoutMatch = raw.match(/node exceeded timeout_ms[=\s]*(\d+)/i)
  if (timeoutMatch) {
    const ms = Number(timeoutMatch[1])
    const dur = ms > 0 ? formatMsHuman(ms) : `${ms}ms`
    return lang === "zh"
      ? `节点超时（配置阈值 ${dur}）。可在节点配置中调大 timeout_ms，或设置 timeout_policy='notify' 让超时仅通知而不失败。`
      : `Node timeout (threshold ${dur}). Increase timeout_ms in node config, or set timeout_policy='notify' to make timeout advisory.`
  }

  // timed out（prompt 超时）
  if (/timed out/i.test(raw)) {
    const tm = raw.match(/(\d+)\s*ms/)
    const dur = tm ? formatMsHuman(Number(tm[1])) : ""
    return lang === "zh"
      ? `执行超时${dur ? `（${dur}）` : ""}。agent 未在时限内完成，可重试或调整任务复杂度。`
      : `Execution timed out${dur ? ` (${dur})` : ""}. Retry or reduce task complexity.`
  }

  // 未知 worker_type
  const workerMatch = raw.match(/unknown worker_type:\s*(\S+)/i)
  if (workerMatch) {
    const wt = workerMatch[1]
    return lang === "zh"
      ? `未知的 worker_type "${wt}"。请在 opencode.json 的 agent.* 中注册该 agent，或修改节点的 worker_type。`
      : `Unknown worker_type "${wt}". Register it in opencode.json agent.* or change node's worker_type.`
  }

  // worktree 创建失败
  if (/worktree creation failed/i.test(raw)) {
    return lang === "zh"
      ? `工作树创建失败。可能是磁盘空间不足或 git 分支冲突，检查 git 状态后重试。`
      : `Worktree creation failed. Check disk space / git branch conflicts.`
  }

  // 孤儿进程
  if (/orphaned by process restart|orphan/i.test(raw)) {
    return lang === "zh"
      ? `进程重启导致节点成为孤儿（未正常完成）。可重新运行或从子会话恢复。`
      : `Node orphaned by process restart. Re-run or resume from sub-session.`
  }

  // subdag 配置
  if (/subDagConfig|worker_type.*dag/i.test(raw)) {
    return lang === "zh"
      ? `子 DAG 配置错误：worker_type="dag" 需要有效的 worker_config.subDagConfig。`
      : `Sub-DAG config error: worker_type="dag" requires valid worker_config.subDagConfig.`
  }

  // 未知错误：保留原始英文（不丢失诊断信息），加前缀说明
  return lang === "zh"
    ? `节点执行失败：${raw}`
    : raw
}

/**
 * 毫秒 → 人类可读时长（整数秒精度）。
 * 供 formatNodeError 把 timeout_ms 渲染为 "30m 0s" 而非 "1800000ms"。
 */
function formatMsHuman(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 1) return `${ms}ms`
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function resolveLang(api: TuiPluginApi): Lang {
  const v = (api.tuiConfig as { lang?: unknown }).lang
  return v === "zh" ? "zh" : "en"
}

export function useLang(api: TuiPluginApi): () => I18n {
  const lang = () => resolveLang(api)
  return createMemo(() => {
    const l = lang()
    const dict = DICT[l]
    return {
      lang: l,
      t: (key: I18nKey) => dict[key],
      workflowStatus: (s: WorkflowStatus) => (l === "zh" ? WORKFLOW_STATUS_ZH[s] : s),
      nodeStatus: (s: NodeStatus) => (l === "zh" ? NODE_STATUS_ZH[s] : s),
    }
  })
}
