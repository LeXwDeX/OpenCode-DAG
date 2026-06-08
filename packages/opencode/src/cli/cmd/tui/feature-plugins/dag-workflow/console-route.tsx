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
import { createEffect, createMemo, createSignal, Show, type JSX } from "solid-js"
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
  filterWorkflows,
  nextIndex,
  pauseWorkflow,
  resumeWorkflow,
} from "./data"
import {
  DagWorkflowRenderer,
  DagProgressBar,
} from "./renderer"
import { AsciiDag } from "./ascii-dag"
import { LiveTicker } from "./live-ticker"
import { NodeDialog } from "./node-dialog"
import { WorkflowHistoryPanel } from "./history-panel"
import { NodeLogsPanel } from "./node-logs-panel"
import { Sidebar } from "./sidebar"
import { PauseResumeBar } from "./pause-resume-bar"
import { useBindings } from "../../keymap"
import { useLang } from "./i18n"
import { useToast } from "@tui/ui/toast"

const ROUTE = "dag-workflow"

type ViewMode = "tree" | "ascii-dag"

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
            returnRoute?: { name: string; params?: Record<string, unknown> }
          }
        | undefined,
  )

  const sessionID = createMemo(() => routeParams()?.sessionID ?? "")
  const [currentWorkflowID, setCurrentWorkflowID] = createSignal<string | undefined>(
    routeParams()?.workflowId,
  )
  const [selectedNodeID, setSelectedNodeID] = createSignal<string | null>(null)
  const [viewMode, setViewMode] = createSignal<ViewMode>("tree")
  const [focusPane, setFocusPane] = createSignal<"list" | "graph">("list")
  const [actionError, setActionError] = createSignal<string | null>(null)

  // Responsive breakpoint: wide (>120) → 3-column layout; narrow (≤120) → overlay panels
  const dimensions = useTerminalDimensions()
  const wide = createMemo(() => dimensions().width > 120)
  const [sidebarExpanded, setSidebarExpanded] = createSignal(false)
  const [detailExpanded, setDetailExpanded] = createSignal(false)

  // Filter/search state lives here (lifted from Sidebar) so that keyboard
  // navigation operates on the SAME filtered list the sidebar displays.
  const [statusFilter, setStatusFilter] = createSignal<DAGWorkflowStatus | null>(null)
  const [search, setSearch] = createSignal("")

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
      setActionError(null)
      if (action === "pause") {
        await pauseWorkflow(props.api.client, workflowId)
        return
      }
      await resumeWorkflow(props.api.client, workflowId)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    }
  }

  function togglePauseResume() {
    const wf = currentWorkflow()
    if (!wf) return
    if (wf.status === "running") {
      void pauseResume("pause", wf.id)
      return
    }
    if (wf.status === "paused") void pauseResume("resume", wf.id)
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

  useBindings(() => ({
    bindings: [
      { key: "escape", desc: "Back to session", group: "DAG", cmd() { goToSessionTab() } },
      { key: "tab", desc: "Switch pane (list ↔ graph)", group: "DAG", cmd() { setFocusPane((p) => (p === "list" ? "graph" : "list")) } },
      { key: "j,down", desc: "Next", group: "DAG", cmd() { moveSelection(1) } },
      { key: "k,up", desc: "Previous", group: "DAG", cmd() { moveSelection(-1) } },
      { key: "return", desc: "Select / Enter sub-session", group: "DAG", cmd() { confirmSelection() } },
      { key: "<leader>p", desc: "Pause / resume workflow", group: "DAG", cmd() { togglePauseResume() } },
      { key: "<leader>v", desc: "Toggle DAG view (tree ↔ ASCII)", group: "DAG", cmd() { toggleView() } },
      { key: "[", desc: "Toggle sidebar (narrow)", group: "DAG", cmd() { if (!wide()) setSidebarExpanded((v) => !v) } },
      { key: "]", desc: "Toggle detail (narrow)", group: "DAG", cmd() { if (!wide()) setDetailExpanded((v) => !v) } },
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
    const params = routeParams()
    const returnRoute = params?.returnRoute
    const fallbackSessionID = params?.sessionID
    if (returnRoute?.name === "session") {
      // routeNavigate silently no-ops if sessionID is missing; merge the
      // top-level sessionID param as a backup so Back always works.
      const sid =
        (returnRoute.params?.["sessionID"] as string | undefined) ?? fallbackSessionID
      if (sid) {
        props.api.route.navigate("session", { sessionID: sid })
        return
      }
    }
    if (returnRoute?.name) {
      props.api.route.navigate(returnRoute.name, returnRoute.params)
    } else if (fallbackSessionID) {
      props.api.route.navigate("session", { sessionID: fallbackSessionID })
    } else {
      props.api.route.navigate("home")
    }
  }

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      {/* TOP BAR: Tab 切换 */}
      <box
        flexDirection="row"
        justifyContent="space-between"
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
          <text fg={theme.textMuted}>│</text>
          <text fg={theme.text}>
            <b>{i18n().t("tab_workflow")}</b>
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
                currentWorkflowID={currentWorkflowID()}
                onStatusFilter={(s) => setStatusFilter(s)}
                onSearch={(q) => setSearch(q)}
                onSelect={(id: string) => {
                  setCurrentWorkflowID(id)
                  setSelectedNodeID(null)
                }}
              />
            </scrollbox>
          </box>
        </Show>

        {/* Middle: 进度条 + 节点树 */}
        <box flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2} paddingTop={1} gap={1}>
            <Show
              when={!workflowError() && !actionError()}
              fallback={
                <box flexGrow={1} alignItems="center" justifyContent="center">
                  <text fg={theme.error}>{i18n().t("label_load_error")}: {workflowError() ?? actionError()}</text>
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
                />
                <PauseResumeBar
                  workflowId={wf().id}
                  currentStatus={() => wf().status}
                  onAction={(action) => void pauseResume(action, wf().id)}
                />
                <scrollbox flexGrow={1} minHeight={0} stickyScroll={false} stickyStart="top">
                  <Show
                    when={viewMode() === "ascii-dag"}
                    fallback={
                      <DagWorkflowRenderer
                        lang={i18n().lang}
                        workflow={wf()}
                        nodes={nodes()}
                        violations={violations()}
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
                      onSelect={(id) => {
                        setSelectedNodeID(id)
                        if (!wide()) setDetailExpanded(true)
                      }}
                    />
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
            <scrollbox flexGrow={1} minHeight={0}>
              <NodeDialog
                lang={i18n().lang}
                node={selectedNode()}
                onClose={() => setSelectedNodeID(null)}
                route={props.api.route}
              />
              <WorkflowHistoryPanel
                lang={i18n().lang}
                history={workflowHistory()}
                error={workflowHistoryError()}
                loading={workflowHistoryLoading()}
              />
              <NodeLogsPanel
                lang={i18n().lang}
                logs={nodeLogs()}
                error={nodeLogsError()}
                loading={nodeLogsLoading()}
              />
            </scrollbox>
            <LiveTicker lang={i18n().lang} event={props.api.event} nodes={nodes()} />
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
              currentWorkflowID={currentWorkflowID()}
              onStatusFilter={(s) => setStatusFilter(s)}
              onSearch={(q) => setSearch(q)}
              onSelect={(id: string) => {
                setCurrentWorkflowID(id)
                setSelectedNodeID(null)
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
          <scrollbox flexGrow={1} minHeight={0}>
            <NodeDialog
              lang={i18n().lang}
              node={selectedNode()}
              onClose={() => {
                setSelectedNodeID(null)
                setDetailExpanded(false)
              }}
              route={props.api.route}
            />
            <WorkflowHistoryPanel
              lang={i18n().lang}
              history={workflowHistory()}
              error={workflowHistoryError()}
              loading={workflowHistoryLoading()}
            />
            <NodeLogsPanel
              lang={i18n().lang}
              logs={nodeLogs()}
              error={nodeLogsError()}
              loading={nodeLogsLoading()}
            />
          </scrollbox>
          <LiveTicker lang={i18n().lang} event={props.api.event} nodes={nodes()} />
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
  )
}
