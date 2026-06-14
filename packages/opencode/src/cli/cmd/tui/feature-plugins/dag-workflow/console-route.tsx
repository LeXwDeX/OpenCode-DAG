/** @jsxImportSource @opentui/solid */
/**
 * DAG Workflow 工作台 Console Route
 *
 * 三区布局：
 * - 顶部：[对话 | DAG Workflow] Tab 切换 + [Tree | ASCII DAG] 视图切换
 * - 左侧：workflow 历史列表（含搜索 + 状态过滤）
 * - 中间：进度条 + 节点树或 ASCII DAG（按 viewMode 切换）
 * - 右下：选中节点详情 + 实时 ticker
 *
 * 架构约束：
 * - TUI 只读：任何写必须经 server API
 * - 通过 data.ts hooks 访问数据（禁止直接调 SDK）
 * - signals + event subscription（禁止 createResource）
 * - viewMode 通过 signal（不硬编码）
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, createSignal, ErrorBoundary, onCleanup, Show, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { DAGNodeSession, DAGWorkflowStatus } from "@/dag/session/types"
import { calculateWorkflowProgress } from "@/dag/session/types"
import { useTheme } from "@tui/context/theme"
import {
  useWorkflowList,
  useWorkflowDetail,
  useWorkflowHistory,
  useNodeLogs,
  useViolations,
  useNodeAskMain,
  useWorkflowTimeline,
  useWorkflowStats,
  useInspectDiagnostics,
  useNodeToolCounts,
  filterWorkflows,
  nextIndex,
  pauseWorkflow,
  resumeWorkflow,
  cancelWorkflow,
  startWorkflow,
  replanWorkflow,
  replanPreview,
  createWorkflow,
  stepWorkflow,
  type ReplanPatchInput,
} from "./data"
import {
  listDAGTemplates,
  instantiateDAGTemplate,
  type DAGTemplateInput,
} from "@/dag/integration/templates"
import {
  DagWorkflowRenderer,
  DagProgressBar,
} from "./renderer"
import { AsciiDag } from "./ascii-dag"
import { DetailPane } from "./detail-pane"
import { ViolationsList } from "./violations-list"
import { Sidebar } from "./sidebar"
import { ControlBar, parseReplanConcurrency, type ControlAction } from "./control-bar"
import { GLYPH } from "./glyphs"
import { useBindings, useOpencodeModeStack, OPENCODE_BASE_MODE } from "../../keymap"
import { useLang } from "./i18n"
import { useToast } from "@tui/ui/toast"

const ROUTE = "dag-workflow"

/**
 * Keymap mode pushed while the sidebar search input is focused.
 * Scopes console nav bindings (base mode) out and makes escape blur the
 * search instead of navigating back to the session.
 */
export const DAG_SEARCH_MODE = "dag-search"

type ViewMode = "tree" | "ascii-dag"

export function DagErrorFallback(props: { error: unknown }): JSX.Element {
  const { theme } = useTheme()
  return (
    <box flexGrow={1} alignItems="center" justifyContent="center">
      <box gap={1} padding={2}>
        <text fg={theme.error}>{GLYPH.warning} UI Error</text>
        <text fg={theme.textMuted}>{props.error instanceof Error ? props.error.message : String(props.error)}</text>
        <text fg={theme.textMuted}>Refresh or switch views to recover.</text>
      </box>
    </box>
  )
}

function asciiDagAvailableWidth(width: number, wide: boolean): number {
  return Math.max(8, width - (wide ? 80 : 4))
}

// ── Pure utility: convert raw dialog fields to a template input ──────────
// Empty/whitespace-only scope and context become undefined (omitted from input).
export function buildTemplateInput(fields: {
  goal: string
  scope: string
  context: string
}): DAGTemplateInput {
  const input: DAGTemplateInput = { goal: fields.goal }
  const scopeTrimmed = fields.scope?.trim()
  const contextTrimmed = fields.context?.trim()
  if (scopeTrimmed) input.scope = scopeTrimmed
  if (contextTrimmed) input.context = contextTrimmed
  return input
}

type ReplanPreviewMessageInput =
  | {
      ok: true
      workflow_id: string
      pre: { config?: unknown; node_ids?: string[]; max_concurrency: number; total_nodes: number }
      post: { config?: unknown; node_ids?: string[]; max_concurrency: number; total_nodes: number }
      delta: {
        nodes_added: number
        nodes_removed: number
        nodes_updated: number
        final_total: number
        max_concurrency_changed?: boolean
      }
    }
  | { ok: false; reason: string; detail?: unknown }

export function buildPreviewMessage(preview: ReplanPreviewMessageInput): string {
  if (!preview.ok) {
    return `Preview rejected:\nreason: ${preview.reason}${preview.detail ? `\ndetail: ${JSON.stringify(preview.detail)}` : ""}`
  }
  return [
    `Preview for ${preview.workflow_id}:`,
    `nodes: ${preview.pre.total_nodes} ${GLYPH.arrow} ${preview.post.total_nodes}`,
    `max concurrency: ${preview.pre.max_concurrency} ${GLYPH.arrow} ${preview.post.max_concurrency}`,
    `added: ${preview.delta.nodes_added}, removed: ${preview.delta.nodes_removed}, updated: ${preview.delta.nodes_updated}`,
    `final total: ${preview.delta.final_total}`,
  ].join("\n")
}

export function routeWorkflowId(params: { workflowId?: unknown; workflowID?: unknown } | undefined): string | undefined {
  if (typeof params?.workflowId === "string" && params.workflowId) return params.workflowId
  if (typeof params?.workflowID === "string" && params.workflowID) return params.workflowID
  return undefined
}

export function ConsoleRoute(props: { api: TuiPluginApi }): JSX.Element {
  const { theme } = useTheme()
  const i18n = useLang(props.api)

  const routeParams = createMemo(
    () =>
      ("params" in props.api.route.current
        ? props.api.route.current.params
        : undefined) as
          | {
              sessionID?: string
              workflowId?: string
              workflowID?: string
              returnRoute?: { name: string; params?: Record<string, unknown> }
            }
          | undefined,
  )

  const sessionID = createMemo(() => routeParams()?.sessionID ?? "")
  const [currentWorkflowID, setCurrentWorkflowID] = createSignal<string | undefined>(
    routeWorkflowId(routeParams()),
  )
  const [selectedNodeID, setSelectedNodeID] = createSignal<string | null>(null)
  const [viewMode, setViewMode] = createSignal<ViewMode>("tree")
  const [focusPane, setFocusPane] = createSignal<"list" | "graph">("list")
  const [actionError, setActionError] = createSignal<string | null>(null)
  const [actionLoading, setActionLoading] = createSignal(false)

  createEffect(() => {
    const next = routeWorkflowId(routeParams())
    if (!next || next === currentWorkflowID()) return
    setCurrentWorkflowID(next)
    setSelectedNodeID(null)
  })

  async function withLoading<T>(fn: () => Promise<T>): Promise<T> {
    setActionLoading(true)
    try {
      return await fn()
    } finally {
      setActionLoading(false)
    }
  }

  // actionError toast: operation failures (pause/resume/cancel/replan/create) shown
  // as transient toast rather than occupying the middle-pane layout. Data-load
  // errors (workflowError) still use the mid-pane fallback since no content is available.
  createEffect(() => {
    const err = actionError()
    if (!err) return
    toast.show({
      title: i18n().t("toast_action_error"),
      message: err,
      variant: "error",
      duration: 8000,
    })
    setActionError(null)
  })

  // Responsive breakpoint: wide (>120) → 3-column layout; narrow (≤120) → overlay panels
  const dimensions = useTerminalDimensions()
  const wide = createMemo(() => dimensions().width > 120)
  const [sidebarExpanded, setSidebarExpanded] = createSignal(false)
  const [detailExpanded, setDetailExpanded] = createSignal(false)

  // Filter/search state lives here (lifted from Sidebar) so that keyboard
  // navigation operates on the SAME filtered list the sidebar displays.
  const [statusFilter, setStatusFilter] = createSignal<DAGWorkflowStatus | null>(null)
  const [search, setSearch] = createSignal("")

  // ── Search focus (BUG-2) ──────────────────────────────────────────────────
  // Parent-owned focus signal for the sidebar search input. While focused, a
  // dedicated keymap mode is pushed (dialog.tsx precedent) so the console nav
  // bindings — scoped to base mode — stop firing and escape blurs instead of
  // navigating back to the session.
  const [searchFocused, setSearchFocused] = createSignal(false)
  const modeStack = useOpencodeModeStack()
  createEffect(() => {
    if (!searchFocused()) return
    const popMode = modeStack.push(DAG_SEARCH_MODE)
    onCleanup(popMode)
  })

  function focusSearch() {
    if (!wide()) setSidebarExpanded(true)
    setSearchFocused(true)
  }

  function blurSearch() {
    setSearchFocused(false)
    if (!wide()) setSidebarExpanded(false)
  }

  // ── Data hooks (declared before derived memos to avoid TDZ) ───────────────
  const { list: workflowList } = useWorkflowList({
    client: props.api.client,
    event: props.api.event,
    session_id: sessionID,
  })

  // Single getWorkflow fetch feeds both the workflow detail and its nodes
  // (deduplicates what used to be two independent getWorkflow round-trips).
  const {
    workflow: currentWorkflow,
    nodes,
    error: workflowError,
    loading: workflowLoading,
  } = useWorkflowDetail({
    client: props.api.client,
    event: props.api.event,
    workflowId: currentWorkflowID,
  })

  const { violations } = useViolations({
    client: props.api.client,
    event: props.api.event,
    workflowId: currentWorkflowID,
  })

  const toolCounts = useNodeToolCounts({ event: props.api.event, nodes })

  const {
    history: workflowHistory,
    error: workflowHistoryError,
    loading: workflowHistoryLoading,
  } = useWorkflowHistory({
    client: props.api.client,
    event: props.api.event,
    workflowId: currentWorkflowID,
  })

  const {
    logs: nodeLogs,
    error: nodeLogsError,
    loading: nodeLogsLoading,
  } = useNodeLogs({
    client: props.api.client,
    event: props.api.event,
    nodeId: selectedNodeID,
  })

  // ── WP-TUI-4: timeline & graph stats ─────────────────────────────────────
  const {
    timeline: workflowTimeline,
    error: timelineError,
    loading: timelineLoading,
  } = useWorkflowTimeline({
    client: props.api.client,
    event: props.api.event,
    workflowId: currentWorkflowID,
  })

  const { stats: workflowStats } = useWorkflowStats({
    client: props.api.client,
    event: props.api.event,
    workflowId: currentWorkflowID,
  })

  const inspectDiagnostics = useInspectDiagnostics({
    client: props.api.client,
    event: props.api.event,
    workflowId: currentWorkflowID,
    selectedNodeId: selectedNodeID,
  })

  // ── WP-TUI-2: node ask_main subscription ─────────────────────────────────
  const toast = useToast()
  const { lastQuestion, clear: clearAskMain } = useNodeAskMain({
    event: props.api.event,
    workflowId: currentWorkflowID,
  })
  createEffect(() => {
    const q = lastQuestion()
    if (!q) return
    toast.show({
      title: `Node asks: ${q.nodeID}`,
      message: q.question,
      variant: "info",
      duration: 5000,
    })
    if (q.chatSessionID) {
      props.api.route.navigate("session", { sessionID: q.chatSessionID })
    }
    clearAskMain()
  })

  const filteredWorkflows = createMemo(() =>
    filterWorkflows(workflowList(), statusFilter(), search()),
  )

  const selectedNode = createMemo<DAGNodeSession | null>(() => {
    const id = selectedNodeID()
    if (!id) return null
    return nodes().find((n) => n.node_id === id) ?? null
  })

  function toggleView() {
    setViewMode((v) => (v === "tree" ? "ascii-dag" : "tree"))
  }

  async function pauseResume(action: "pause" | "resume", workflowId: string) {
    try {
      await withLoading(async () => {
        setActionError(null)
        if (action === "pause") {
          await pauseWorkflow(props.api.client, workflowId)
          return
        }
        await resumeWorkflow(props.api.client, workflowId)
      })
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    }
  }

  // P2-B: Step wrapper — runs the data.ts stepWorkflow and surfaces errors as toast.
  async function stepOne(workflowId: string) {
    try {
      await withLoading(async () => {
        setActionError(null)
        await stepWorkflow(props.api.client, workflowId)
      })
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    }
  }

  async function startCurrent(workflowId: string) {
    try {
      await withLoading(async () => {
        setActionError(null)
        await startWorkflow(props.api.client, workflowId)
      })
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    }
  }

  function togglePauseResume() {
    if (actionLoading()) return
    const wf = currentWorkflow()
    if (!wf) return
    if (wf.status === "running") {
      void pauseResume("pause", wf.id)
      return
    }
    if (wf.status === "paused") void pauseResume("resume", wf.id)
  }

  // ── ControlBar action dispatch ───────────────────────────────────────────
  // D-TUI-RESERVE (design-only): future UX capabilities live here as intents only:
  // template preview, replan diff preview, form-based node editor, and inspect panel.
  // They must keep the current boundary: UI emits intent -> data.ts wrapper -> server API -> WorkflowEngine.
  // Do not add direct SDK calls or DAG SQLite access in presentation components.
  // ControlBar emits intents only; this route owns the dialogs (api.ui.*) and
  // the data.ts wrapper calls. pause/resume reuse pauseResume; cancel is gated
  // by a DialogConfirm (terminal is irreversible); replan opens a DialogSelect
  // menu with concurrency / remove node only; no add/update JSON editor is exposed.
  function handleControlAction(action: ControlAction, workflowId: string) {
    if (action === "start") {
      void startCurrent(workflowId)
      return
    }
    if (action === "pause" || action === "resume") {
      void pauseResume(action, workflowId)
      return
    }
    // P2-B: step — no confirmation dialog (idempotent + only runs 1 ready node)
    if (action === "step") {
      void stepOne(workflowId)
      return
    }
    if (action === "cancel") {
      props.api.ui.dialog.replace(() =>
        props.api.ui.DialogConfirm({
          title: i18n().t("dlg_cancel_title"),
          message: i18n().t("dlg_cancel_msg"),
          onConfirm: () => void cancelCurrent(workflowId),
        }),
      )
      return
    }
    // replan → hide add/update JSON editors; TUI exposes safe concurrency/remove only.
    props.api.ui.dialog.replace(() =>
      props.api.ui.DialogSelect<string>({
        title: i18n().t("dlg_replan_title"),
        options: [
          { title: i18n().t("replan_concurrency"), value: "concurrency" },
          { title: i18n().t("replan_remove_node"), value: "remove_node" },
        ],
        onSelect: (option) => handleReplanOption(option.value, workflowId),
      }),
    )
  }

  function handleReplanOption(op: string, workflowId: string) {
    if (op === "concurrency") {
      props.api.ui.dialog.replace(() =>
        props.api.ui.DialogPrompt({
          title: i18n().t("dlg_concurrency_title"),
          placeholder: i18n().t("dlg_concurrency_ph"),
          onConfirm: (value) => void previewConcurrencyReplan(workflowId, value),
        }),
      )
      return
    }
    if (op === "remove_node") {
      const ns = nodes()
      if (ns.length === 0) {
        toast.show({ message: i18n().t("toast_no_nodes"), variant: "error" })
        return
      }
      props.api.ui.dialog.replace(() =>
        props.api.ui.DialogSelect<string>({
          title: i18n().t("dlg_remove_node_title"),
          options: ns.map((n) => ({
            title: n.config.name || n.node_id,
            value: n.config.id,
            description: `${n.status} (${n.config.worker_type})`,
          })),
          onSelect: (opt) => confirmRemoveNode(workflowId, opt.value),
        }),
      )
      return
    }
  }

  async function cancelCurrent(workflowId: string) {
    try {
      await withLoading(async () => {
        setActionError(null)
        await cancelWorkflow(props.api.client, workflowId)
      })
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    }
  }

  async function previewConcurrencyReplan(workflowId: string, value: string) {
    const parsed = parseReplanConcurrency(value)
    if (!parsed.ok) {
      toast.show({ message: i18n().t("toast_replan_range"), variant: "error" })
      return
    }
    await previewReplanThenConfirm(workflowId, { new_max_concurrency: parsed.value }, () =>
      applyReplan(workflowId, { new_max_concurrency: parsed.value }),
    )
  }

  async function applyReplan(workflowId: string, patch: ReplanPatchInput) {
    try {
      await withLoading(async () => {
        setActionError(null)
        await replanWorkflow(props.api.client, workflowId, patch)
      })
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    }
  }

  async function previewReplanThenConfirm(
    workflowId: string,
    patch: ReplanPatchInput,
    apply: () => Promise<void>,
  ) {
    try {
      const preview = await withLoading(async () => {
        setActionError(null)
        return replanPreview(props.api.client, workflowId, patch)
      })
      const data = preview.data as ReplanPreviewMessageInput | undefined
      if (!data?.ok) {
        setActionError(data ? buildPreviewMessage(data) : "Replan preview failed")
        return
      }
      props.api.ui.dialog.replace(() =>
        props.api.ui.DialogConfirm({
          title: i18n().t("dlg_replan_title"),
          message: buildPreviewMessage(data),
          onConfirm: () => void apply(),
        }),
      )
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    }
  }

  function confirmRemoveNode(workflowId: string, nodeId: string) {
    void previewReplanThenConfirm(
      workflowId,
      { remove_nodes: [nodeId], changed_by: "tui-remove-node" },
      () => removeNodeReplan(workflowId, nodeId),
    )
  }

  async function removeNodeReplan(workflowId: string, nodeId: string) {
    try {
      await withLoading(async () => {
        setActionError(null)
        await replanWorkflow(props.api.client, workflowId, {
          remove_nodes: [nodeId],
          changed_by: "tui-remove-node",
        })
        toast.show({ message: i18n().t("toast_node_removed"), variant: "success" })
      })
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
      toast.show({ message: i18n().t("toast_replan_error"), variant: "error" })
    }
  }

  // ── Create workflow from template ─────────────────────────────────────────
  // Three-step dialog chain via api.ui.dialog.replace: select a template, then
  // collect goal → scope → context. create is template-derived only
  // (instantiateDAGTemplate); node add/remove and AI generation are out of
  // scope for the TUI. Scope and context are optional (empty → omitted).
  function handleCreate() {
    props.api.ui.dialog.replace(() =>
      props.api.ui.DialogSelect<string>({
        title: i18n().t("dlg_create_title"),
        options: listDAGTemplates().map((tpl) => ({
          title: tpl.name,
          value: tpl.id,
          description: tpl.description,
        })),
        onSelect: (option) => promptFieldsAndCreate(option.value),
      }),
    )
  }

  // ── Create workflow from template: 3-step field-collection dialog chain ──
  function promptFieldsAndCreate(templateId: string): void {
    props.api.ui.dialog.replace(() =>
      props.api.ui.DialogPrompt({
        title: i18n().t("dlg_goal_title"),
        placeholder: i18n().t("dlg_goal_ph"),
        onConfirm: (goal) => promptScopeAndCreate(templateId, goal),
      }),
    )
  }

  function promptScopeAndCreate(templateId: string, goal: string): void {
    props.api.ui.dialog.replace(() =>
      props.api.ui.DialogPrompt({
        title: i18n().t("dlg_scope_title"),
        placeholder: i18n().t("dlg_scope_ph"),
        onConfirm: (scope) => promptContextAndCreate(templateId, goal, scope),
      }),
    )
  }

  function promptContextAndCreate(templateId: string, goal: string, scope: string): void {
    props.api.ui.dialog.replace(() =>
      props.api.ui.DialogPrompt({
        title: i18n().t("dlg_context_title"),
        placeholder: i18n().t("dlg_context_ph"),
        onConfirm: (context) => void createFromTemplate(templateId, { goal, scope, context }),
      }),
    )
  }

  async function createFromTemplate(
    templateId: string,
    fields: { goal: string; scope: string; context: string },
  ): Promise<void> {
    // BUG-3 fix: immediately dismiss the last DialogPrompt so the user
    // sees the workflow list / progress instead of a stuck context input.
    props.api.ui.dialog.clear()
    const input = buildTemplateInput(fields)
    const result = instantiateDAGTemplate(templateId, input)
    if ("error" in result) {
      setActionError(result.error)
      toast.show({ message: i18n().t("toast_create_error"), variant: "error" })
      return
    }
    try {
      await withLoading(async () => {
        setActionError(null)
        await createWorkflow(props.api.client, {
          name: fields.goal.slice(0, 80),
          chatSessionId: sessionID(),
          config: result,
        })
        toast.show({ message: i18n().t("toast_created_pending_start"), variant: "success" })
      })
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
      toast.show({ message: i18n().t("toast_create_error"), variant: "error" })
    }
  }

  // ── Keyboard navigation helpers ──────────────────────────────────────────
  function moveWorkflowSelection(delta: number) {
    const list = filteredWorkflows()
    if (list.length === 0) return
    const curIdx = list.findIndex((w) => w.id === currentWorkflowID())
    const next = list[nextIndex(list.length, curIdx, delta)]
    if (next) {
      setCurrentWorkflowID(next.id)
      setSelectedNodeID(null)
    }
  }

  function moveNodeSelection(delta: number) {
    const ns = nodes()
    if (ns.length === 0) return
    const curIdx = ns.findIndex((n) => n.node_id === selectedNodeID())
    const next = ns[nextIndex(ns.length, curIdx, delta)]
    if (next) {
      setSelectedNodeID(next.node_id)
      if (!wide()) setDetailExpanded(true)
    }
  }

  function moveSelection(delta: number) {
    if (focusPane() === "list") moveWorkflowSelection(delta)
    else moveNodeSelection(delta)
  }

  function confirmSelection() {
    if (focusPane() === "list") {
      // Move focus into the graph and select the first node for keyboard flow.
      setFocusPane("graph")
      if (!selectedNodeID()) moveNodeSelection(1)
      return
    }
    // graph focus → enter the node's sub-session if available
    const sid = selectedNode()?.metadata?.chat_session_id
    if (typeof sid === "string") {
      props.api.route.navigate("session", { sessionID: sid })
    }
  }

  // Console nav bindings are scoped to the base mode so they stop firing while
  // the search input is focused (DAG_SEARCH_MODE pushed) or a dialog is open.
  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    bindings: [
      { key: "escape", desc: "Back to session", group: "DAG", cmd() { goToSessionTab() } },
      { key: "tab", desc: "Switch pane (list/graph)", group: "DAG", cmd() { setFocusPane((p) => (p === "list" ? "graph" : "list")) } },
      { key: "j,down", desc: "Next", group: "DAG", cmd() { moveSelection(1) } },
      { key: "k,up", desc: "Previous", group: "DAG", cmd() { moveSelection(-1) } },
      { key: "return", desc: "Select / Enter sub-session", group: "DAG", cmd() { confirmSelection() } },
      { key: "/", desc: "Search workflows", group: "DAG", cmd() { focusSearch() } },
      { key: "<leader>p", desc: "Pause / resume workflow", group: "DAG", cmd() { togglePauseResume() } },
      { key: "<leader>v", desc: "Toggle DAG view (tree/ASCII)", group: "DAG", cmd() { toggleView() } },
      { key: "[", desc: "Toggle sidebar (narrow)", group: "DAG", cmd() { if (!wide()) setSidebarExpanded((v) => !v) } },
      { key: "]", desc: "Toggle detail (narrow)", group: "DAG", cmd() { if (!wide()) setDetailExpanded((v) => !v) } },
    ],
  }))

  // Escape dual semantics: while the search input is focused it blurs the
  // search (and closes the narrow overlay) instead of navigating back.
  useBindings(() => ({
    mode: DAG_SEARCH_MODE,
    bindings: [
      { key: "escape", desc: "Close search", group: "DAG", cmd() { blurSearch() } },
    ],
  }))

  // Rich progress model via calculateWorkflowProgress (pure function on workflow session).
  // Returns DAGWorkflowProgress with required/all_nodes stats, concurrency, and ETA.
  const progress = createMemo(() => {
    const wf = currentWorkflow()
    if (!wf) return null
    return calculateWorkflowProgress(wf)
  })

  function goToSessionTab() {
    // Priority (BUG-2 fix): always prefer top-level sessionID in DAG route
    // params. It's populated on every entry into the route and survives
    // returnRoute lossy/missing serialization. ESC + "Chat" click share this
    // function so both return paths behave identically.
    const params = routeParams()
    const fallbackSessionID = params?.sessionID
    const returnRoute = params?.returnRoute as
      | { name: string; params?: Record<string, unknown> }
      | undefined
    const returnSessionID =
      returnRoute?.name === "session"
        ? (returnRoute.params?.["sessionID"] as string | undefined)
        : undefined
    const sid = (typeof fallbackSessionID === "string" ? fallbackSessionID : undefined)
      ?? (typeof returnSessionID === "string" ? returnSessionID : undefined)

    if (sid) {
      props.api.route.navigate("session", { sessionID: sid })
      return
    }
    // Non-session return route (e.g. home) — honour it if present.
    if (returnRoute?.name) {
      props.api.route.navigate(returnRoute.name, returnRoute.params)
      return
    }
    props.api.route.navigate("home")
  }

  return (
    <ErrorBoundary fallback={(err) => <DagErrorFallback error={err} />}>
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      {/* TOP BAR: Tab 切换 — height/flexShrink 钉死高度，防止鼠标点击时
          flex 重排导致背景被遮挡 + 内容抖动（BUG-1） */}
      <box
        flexDirection="row"
        justifyContent="space-between"
        height={3}
        flexShrink={0}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        backgroundColor={theme.backgroundPanel}
      >
        <box flexDirection="row" gap={2}>
          <text fg={theme.textMuted} onMouseUp={goToSessionTab}>
            {i18n().t("tab_dialogue")}
          </text>
          <text fg={theme.textMuted}>{GLYPH.vbar}</text>
          <text fg={theme.text}>
            <b>{i18n().t("tab_workflow")}</b>
          </text>
          <text fg={theme.textMuted}>{GLYPH.vbar}</text>
          <text fg={theme.primary} onMouseUp={handleCreate}>
            {i18n().t("ctrl_new")}
          </text>
        </box>
        <box flexDirection="row" gap={3}>
          <text
            fg={viewMode() === "tree" ? theme.text : theme.textMuted}
            onMouseUp={() => setViewMode("tree")}
          >
            {viewMode() === "tree" ? <b>{i18n().t("view_tree")}</b> : i18n().t("view_tree")}
          </text>
          <text
            fg={viewMode() === "ascii-dag" ? theme.text : theme.textMuted}
            onMouseUp={() => setViewMode("ascii-dag")}
          >
            {viewMode() === "ascii-dag" ? <b>{i18n().t("view_ascii")}</b> : i18n().t("view_ascii")}
          </text>
          <text fg={theme.textMuted} onMouseUp={goToSessionTab}>
            {i18n().t("esc_back")}
          </text>
        </box>
      </box>

      {/* 主体：左/中/右三区 */}
      <box flexDirection="row" flexGrow={1} minHeight={0}>
        {/* Left: workflow 历史列表 — inline when wide, hidden when narrow */}
        <Show when={wide()}>
          <box
            flexGrow={0}
            flexShrink={0}
            width={34}
            paddingLeft={1}
            paddingTop={1}
            paddingBottom={1}
            border={["right"]}
            borderColor={focusPane() === "list" ? theme.primary : theme.border}
          >
            <scrollbox flexGrow={1} minHeight={0}>
              <Sidebar
                lang={i18n().lang}
                workflows={filteredWorkflows()}
                statusFilter={statusFilter()}
                search={search()}
                searchFocused={searchFocused()}
                currentWorkflowID={currentWorkflowID()}
                onStatusFilter={(s) => setStatusFilter(s)}
                onSearch={(q) => setSearch(q)}
                onSearchFocus={() => setSearchFocused(true)}
                onSelect={(id: string) => {
                  setCurrentWorkflowID(id)
                  setSelectedNodeID(null)
                  setSearchFocused(false)
                }}
              />
            </scrollbox>
          </box>
        </Show>

        {/* Middle: 进度条 + 节点树 */}
        <box flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2} paddingTop={1} gap={1}>
            <Show
              when={!workflowError()}
              fallback={
                <box flexGrow={1} alignItems="center" justifyContent="center">
                  <text fg={theme.error}>{i18n().t("label_load_error")}: {workflowError()}</text>
                </box>
              }
          >
            <Show
              when={currentWorkflow()}
              fallback={
                <box flexGrow={1} alignItems="center" justifyContent="center">
                  <text fg={theme.textMuted}>
                    {workflowLoading() && currentWorkflowID()
                      ? i18n().t("label_loading")
                      : i18n().t("label_select_workflow")}
                  </text>
                </box>
              }
            >
            {(wf) => (
              <box flexGrow={1} minHeight={0} gap={1}>
                <DagProgressBar
                  lang={i18n().lang}
                  progress={progress()}
                  status={currentWorkflow()?.status ?? "pending"}
                  stats={workflowStats()}
                />
                <ControlBar
                  lang={i18n().lang}
                  workflowId={wf().id}
                  currentStatus={() => wf().status}
                  onAction={(action) => handleControlAction(action, wf().id)}
                  actionLoading={actionLoading}
                />
                {/* 只保留 stickyScroll={false}：与 sticky 起始锚点同时声明会互相矛盾，曾致点击抖动（BUG-1） */}
                <scrollbox flexGrow={1} minHeight={0} stickyScroll={false}>
                  <Show
                    when={viewMode() === "ascii-dag"}
                    fallback={
                      <DagWorkflowRenderer
                        lang={i18n().lang}
                        workflow={wf()}
                        nodes={nodes()}
                        selectedNodeId={selectedNodeID()}
                        onNodeSelect={(nodeId) => {
                          setSelectedNodeID(nodeId)
                          if (!wide()) setDetailExpanded(true)
                        }}
                      />
                    }
                  >
                    <AsciiDag
                      lang={i18n().lang}
                      nodes={nodes()}
                      selectedNodeID={selectedNodeID() ?? undefined}
                      availableWidth={asciiDagAvailableWidth(dimensions().width, wide())}
                      onSelect={(id) => {
                        setSelectedNodeID(id)
                        if (!wide()) setDetailExpanded(true)
                      }}
                    />
                  </Show>
                  <Show when={violations().length > 0}>
                    <ViolationsList lang={i18n().lang} violations={violations()} />
                  </Show>
                </scrollbox>
              </box>
            )}
            </Show>
          </Show>
        </box>

        {/* Right: 选中节点详情 + 实时 ticker — inline when wide, hidden when narrow */}
        <Show when={wide()}>
          <box
            flexGrow={0}
            flexShrink={0}
            width={42}
            paddingLeft={1}
            paddingRight={1}
            paddingTop={1}
            paddingBottom={1}
            border={["left"]}
            borderColor={theme.border}
            gap={1}
          >
            <DetailPane
              lang={i18n().lang}
              node={selectedNode()}
              toolCounts={toolCounts}
              route={props.api.route}
              onNodeClose={() => setSelectedNodeID(null)}
              history={workflowHistory()}
              historyError={workflowHistoryError()}
              historyLoading={workflowHistoryLoading()}
              logs={nodeLogs()}
              logsError={nodeLogsError()}
              logsLoading={nodeLogsLoading()}
              timeline={workflowTimeline()}
              timelineError={timelineError()}
              timelineLoading={timelineLoading()}
              inspect={inspectDiagnostics}
              event={props.api.event}
              nodes={nodes()}
            />
          </box>
        </Show>
      </box>

      {/* Narrow-mode overlays — sidebar and detail panels as absolute-positioned drawers */}
      <Show when={!wide() && sidebarExpanded()}>
        <box
          position="absolute"
          top={0}
          left={0}
          bottom={0}
          width={34}
          backgroundColor={theme.background}
          border={["right"]}
          borderColor={focusPane() === "list" ? theme.primary : theme.border}
          paddingLeft={1}
          paddingTop={1}
          paddingBottom={1}
          zIndex={100}
        >
          <scrollbox flexGrow={1} minHeight={0}>
            <Sidebar
              lang={i18n().lang}
              workflows={filteredWorkflows()}
              statusFilter={statusFilter()}
              search={search()}
              searchFocused={searchFocused()}
              currentWorkflowID={currentWorkflowID()}
              onStatusFilter={(s) => setStatusFilter(s)}
              onSearch={(q) => setSearch(q)}
              onSearchFocus={() => setSearchFocused(true)}
              onSelect={(id: string) => {
                setCurrentWorkflowID(id)
                setSelectedNodeID(null)
                setSearchFocused(false)
                setSidebarExpanded(false)
              }}
            />
          </scrollbox>
        </box>
      </Show>
      <Show when={!wide() && detailExpanded()}>
        <box
          position="absolute"
          top={0}
          right={0}
          bottom={0}
          width={42}
          backgroundColor={theme.background}
          border={["left"]}
          borderColor={theme.border}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
          gap={1}
          zIndex={100}
        >
          <DetailPane
            lang={i18n().lang}
            node={selectedNode()}
            toolCounts={toolCounts}
            route={props.api.route}
            onNodeClose={() => {
              setSelectedNodeID(null)
              setDetailExpanded(false)
            }}
            history={workflowHistory()}
            historyError={workflowHistoryError()}
            historyLoading={workflowHistoryLoading()}
            logs={nodeLogs()}
            logsError={nodeLogsError()}
            logsLoading={nodeLogsLoading()}
            timeline={workflowTimeline()}
            timelineError={timelineError()}
            timelineLoading={timelineLoading()}
            inspect={inspectDiagnostics}
            event={props.api.event}
            nodes={nodes()}
          />
        </box>
      </Show>

      {/* 底部快捷键提示 */}
      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        backgroundColor={theme.backgroundPanel}
      >
        <text fg={theme.textMuted}>{i18n().t("hint_hotkey_bar")}</text>
        <box flexDirection="row" gap={2}>
          <text fg={theme.primary}>{i18n().t("label_focus")} {focusPane() === "list" ? i18n().t("focus_history") : i18n().t("focus_graph")}</text>
          <Show when={selectedNodeID()}>
            <text fg={theme.primary}>{i18n().t("label_node")} {selectedNodeID()}</text>
          </Show>
        </box>
      </box>
    </box>
    </ErrorBoundary>
  )
}
