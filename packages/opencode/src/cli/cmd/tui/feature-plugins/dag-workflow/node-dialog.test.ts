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
  }

  for (const key of Object.keys(cases) as I18nKey[]) {
    it(`${key}: en/zh`, () => {
      expect(t("en", key)).toBe(cases[key][0])
      expect(t("zh", key)).toBe(cases[key][1])
    })
  }
})
