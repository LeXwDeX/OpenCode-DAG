/**
 * WP4 i18n 翻译测试
 *
 * 测试:
 * - nodeStatusLabel: 每个 DAGNodeStatus 都有 en/zh 两种翻译
 * - workflowStatusLabel: 每个 DAGWorkflowStatus 都有 en/zh 两种翻译
 * - t(): 字典 lookup 在两种语言下都能返回正确字符串
 */
import { describe, it, expect } from "bun:test"
import { nodeStatusLabel, workflowStatusLabel, t } from "./i18n"
import { formatNodeDuration, formatNodeTime, truncateNodeText } from "./node-dialog"
import type { I18nKey } from "./i18n"
import type { DAGNodeStatus, DAGWorkflowStatus } from "@/dag/session/types"

describe("WP4 i18n — nodeStatusLabel", () => {
  const enExpected: Record<DAGNodeStatus, string> = {
    pending: "pending",
    queued: "queued",
    running: "running",
    completed: "completed",
    failed: "failed",
    skipped: "skipped",
  }
  const zhExpected: Record<DAGNodeStatus, string> = {
    pending: "等待中",
    queued: "排队中",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    skipped: "已跳过",
  }

  for (const s of Object.keys(enExpected) as DAGNodeStatus[]) {
    it(`en: '${enExpected[s]}' for ${s}`, () => {
      expect(nodeStatusLabel("en", s)).toBe(enExpected[s])
    })
    it(`zh: '${zhExpected[s]}' for ${s}`, () => {
      expect(nodeStatusLabel("zh", s)).toBe(zhExpected[s])
    })
  }

  it("covers all DAGNodeStatus values", () => {
    const allStatuses: DAGNodeStatus[] = ["pending", "queued", "running", "completed", "failed", "skipped"]
    for (const s of allStatuses) {
      const en = nodeStatusLabel("en", s)
      const zh = nodeStatusLabel("zh", s)
      expect(en.length).toBeGreaterThan(0)
      expect(zh.length).toBeGreaterThan(0)
    }
  })
})

describe("WP4 i18n — workflowStatusLabel", () => {
  const enExpected: Record<DAGWorkflowStatus, string> = {
    pending: "pending",
    running: "running",
    completed: "completed",
    failed: "failed",
    cancelled: "cancelled",
    paused: "paused",
  }
  const zhExpected: Record<DAGWorkflowStatus, string> = {
    pending: "等待中",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    paused: "已暂停",
  }

  for (const s of Object.keys(enExpected) as DAGWorkflowStatus[]) {
    it(`en: '${enExpected[s]}'`, () => {
      expect(workflowStatusLabel("en", s)).toBe(enExpected[s])
    })
    it(`zh: '${zhExpected[s]}'`, () => {
      expect(workflowStatusLabel("zh", s)).toBe(zhExpected[s])
    })
  }
})

describe("WP4 i18n — t() dict lookup", () => {
  const cases: Record<I18nKey, [string, string]> = {
    tab_dialogue: ["Chat", "对话"],
    tab_workflow: ["DAG Workflow", "DAG 工作流"],
    view_tree: ["Tree View", "树状视图"],
    view_ascii: ["ASCII DAG", "ASCII 图"],
    esc_back: ["[Esc] Back", "[Esc] 返回"],
    label_status: ["Status", "状态"],
    label_progress: ["Progress", "进度"],
    label_duration: ["Duration", "耗时"],
    label_no_nodes: ["No nodes in this workflow", "当前工作流没有节点"],
    label_no_workflows: ["No workflows", "没有工作流"],
    label_select_workflow: ["Select a workflow from the list", "请从左侧列表选择一个工作流"],
    label_loading: ["Loading\u2026", "加载中\u2026"],
    label_load_error: ["Failed to load", "加载失败"],
    label_search: ["Search:", "搜索："],
    label_retries: ["Retries", "重试"],
    label_deps: ["Deps", "依赖"],
    label_error: ["Error", "错误"],
    label_timing: ["Timing", "时间"],
    label_start_time: ["Start", "开始"],
    label_end_time: ["End", "结束"],
    label_completed_at: ["Completed", "完成"],
    label_output: ["Output", "输出"],
    label_snapshot_logs: ["Snapshot logs", "快照日志"],
    title_workflow_history: ["Workflow History", "工作流历史"],
    title_node_logs: ["Node Logs", "节点日志"],
    history_empty: ["No history", "暂无历史"],
    node_logs_empty: ["No node logs", "暂无节点日志"],
    filter_all: ["All", "全部"],
    title_violations: ["Violations", "违规记录"],
    cmd_open_title: ["Open DAG Workflow", "打开 DAG 工作流面板"],
    node_select_hint: ["Select a node", "请选择一个节点"],
    node_subsession_unavailable: ["[Sub-session not available]", "[暂不可进入子会话]"],
    node_enter_subsession: ["[Enter Sub-Session \u2192]", "[进入子会话 \u2192]"],
    action_close: ["[Close]", "[关闭]"],
    hint_hotkey_bar: [
      "[Tab] Switch pane  [j/k] Move  [Enter] Select  [Leader+v] Toggle  [Esc] Back",
      "[Tab] 切换窗格  [j/k] 移动  [Enter] 选择  [Leader+v] 切换视图  [Esc] 返回",
    ],
    label_focus: ["Focus:", "焦点："],
    focus_history: ["History", "列表"],
    focus_graph: ["Graph", "图形"],
    label_node: ["Node:", "节点："],
    ticker_live: ["Live:", "实时："],
    ticker_idle: ["Idle", "空闲"],
    ticker_reasoning: ["reasoning\u2026", "推理中\u2026"],
    title_timeline: ["Timeline", "时间线"],
    label_timeline: ["Timeline", "时间线"],
    label_stats: ["Stats", "统计"],
    label_critical_path: ["Critical", "关键路径"],
    label_parallelism: ["Parallel", "并行度"],
    label_eta: ["ETA", "预计完成"],
    timeline_empty: ["No timeline events", "暂无时间线事件"],
    label_tool_calls: ["Tool Calls", "工具调用"],
    label_violations: ["Violations", "违规"],
    label_no_violations: ["No violations", "无违规"],
    ctrl_pause: ["[Pause]", "[暂停]"],
    ctrl_resume: ["[Resume]", "[恢复]"],
    ctrl_cancel: ["[Cancel]", "[取消]"],
    ctrl_replan: ["[Replan]", "[调整并发]"],
    ctrl_new: ["[+ New]", "[+ 新建]"],
    dlg_cancel_title: ["Cancel workflow", "取消工作流"],
    dlg_cancel_msg: ["Cancelling is irreversible. Continue?", "取消不可逆，确认继续？"],
    dlg_replan_title: ["Set max concurrency", "设置最大并发数"],
    dlg_replan_ph: ["1-10", "1-10"],
    dlg_create_title: ["Choose a template", "选择模板"],
    dlg_goal_title: ["Workflow goal", "工作流目标"],
    dlg_goal_ph: ["Describe the goal", "描述目标"],
    toast_created: ["Workflow created (pending). Start it via a chat turn.", "工作流已创建（待启动），请通过对话轮启动。"],
    toast_replan_range: ["Concurrency must be between 1 and 10", "并发数必须在 1 到 10 之间"],
    toast_create_error: ["Failed to create workflow", "创建工作流失败"],
  }

  for (const key of Object.keys(cases) as I18nKey[]) {
    it(`${key}: en/zh`, () => {
      expect(t("en", key)).toBe(cases[key][0])
      expect(t("zh", key)).toBe(cases[key][1])
    })
  }
})

describe("WP4 NodeDialog — output and timing helpers", () => {
  it("formats missing times as '-'", () => {
    expect(formatNodeTime(null)).toBe("-")
    expect(formatNodeTime(undefined)).toBe("-")
  })

  it("formats numeric and ISO times deterministically", () => {
    expect(formatNodeTime(0)).toBe("1970-01-01T00:00:00.000Z")
    expect(formatNodeTime("2026-01-01T00:00:00.000Z")).toBe("2026-01-01T00:00:00.000Z")
  })

  it("formats missing and present durations", () => {
    expect(formatNodeDuration(null)).toBe("-")
    expect(formatNodeDuration(42)).toBe("42ms")
  })

  it("truncates long output deterministically", () => {
    const result = truncateNodeText("x".repeat(2_100))
    expect(result.length).toBeLessThanOrEqual(2_001)
    expect(result.endsWith("…")).toBe(true)
  })

  it("truncates output to twenty lines", () => {
    const result = truncateNodeText(Array.from({ length: 25 }, (_, i) => `line-${i}`).join("\n"))
    expect(result.split("\n")).toHaveLength(21)
    expect(result.endsWith("…")).toBe(true)
  })
})
