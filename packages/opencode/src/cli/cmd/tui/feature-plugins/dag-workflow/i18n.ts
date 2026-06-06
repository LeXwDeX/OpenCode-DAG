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

export type Lang = "en" | "zh"

export type WorkflowStatus = "pending" | "running" | "completed" | "failed" | "cancelled"

export type NodeStatus = "pending" | "queued" | "running" | "completed" | "failed" | "skipped"

const DICT = {
  en: {
    tab_dialogue: "对话",
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
    label_search: "Search:",
    label_retries: "Retries",
    label_deps: "Deps",
    label_error: "Error",
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
    label_search: "搜索：",
    label_retries: "重试",
    label_deps: "依赖",
    label_error: "错误",
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
  },
} as const

const WORKFLOW_STATUS_ZH: Record<WorkflowStatus, string> = {
  pending: "等待中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
}

const NODE_STATUS_ZH: Record<NodeStatus, string> = {
  pending: "等待中",
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
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
