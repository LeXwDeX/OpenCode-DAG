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

export type NodeStatus = "pending" | "queued" | "running" | "completed" | "failed" | "skipped"

const DICT = {
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
    label_loading: "Loading\u2026",
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
    node_enter_subsession: "[Enter Sub-Session \u2192]",
    action_close: "[Close]",
    hint_hotkey_bar: "[Tab] Switch pane  [j/k] Move  [Enter] Select  [Leader+v] Toggle  [Esc] Back",
    label_focus: "Focus:",
    focus_history: "History",
    focus_graph: "Graph",
    label_node: "Node:",
    ticker_live: "Live:",
    ticker_idle: "Idle",
    ticker_reasoning: "reasoning\u2026",
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
    ctrl_pause: "[Pause]",
    ctrl_resume: "[Resume]",
    ctrl_cancel: "[Cancel]",
    ctrl_replan: "[Replan]",
    ctrl_new: "[+ New]",
    dlg_cancel_title: "Cancel workflow",
    dlg_cancel_msg: "Cancelling is irreversible. Continue?",
    dlg_replan_title: "Set max concurrency",
    dlg_replan_ph: "1-10",
    dlg_create_title: "Choose a template",
    dlg_goal_title: "Workflow goal",
    dlg_goal_ph: "Describe the goal",
    toast_created: "Workflow created (pending). Start it via a chat turn.",
    toast_replan_range: "Concurrency must be between 1 and 10",
    toast_create_error: "Failed to create workflow",
    toast_action_error: "Action failed",
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
    label_loading: "加载中\u2026",
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
    node_enter_subsession: "[进入子会话 \u2192]",
    action_close: "[关闭]",
    hint_hotkey_bar: "[Tab] 切换窗格  [j/k] 移动  [Enter] 选择  [Leader+v] 切换视图  [Esc] 返回",
    label_focus: "焦点：",
    focus_history: "列表",
    focus_graph: "图形",
    label_node: "节点：",
    ticker_live: "实时：",
    ticker_idle: "空闲",
    ticker_reasoning: "推理中\u2026",
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
    ctrl_pause: "[暂停]",
    ctrl_resume: "[恢复]",
    ctrl_cancel: "[取消]",
    ctrl_replan: "[调整并发]",
    ctrl_new: "[+ 新建]",
    dlg_cancel_title: "取消工作流",
    dlg_cancel_msg: "取消不可逆，确认继续？",
    dlg_replan_title: "设置最大并发数",
    dlg_replan_ph: "1-10",
    dlg_create_title: "选择模板",
    dlg_goal_title: "工作流目标",
    dlg_goal_ph: "描述目标",
    toast_created: "工作流已创建（待启动），请通过对话轮启动。",
    toast_replan_range: "并发数必须在 1 到 10 之间",
    toast_create_error: "创建工作流失败",
    toast_action_error: "操作失败",
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
  },
  zh: {
    required_node_skipped: "必需节点被跳过",
    required_node_failed: "必需节点失败",
    max_nodes_exceeded: "超出最大节点数",
    max_concurrency_exceeded: "超出最大并发数",
    timeout_exceeded: "超时",
    execution_failed: "执行失败",
    process_orphan: "进程孤儿（启动时恢复）",
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
