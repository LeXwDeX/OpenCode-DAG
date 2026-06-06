/** @jsxImportSource @opentui/solid */
/**
 * DAG Workflow 工作台 Console Route
 *
 * 三区布局：
 * - 顶部：[对话 | DAG Workflow] Tab 切换
 * - 左侧：workflow 历史列表
 * - 中间：进度条 + 节点树
 * - 右侧：选中 workflow 详情
 *
 * 架构约束：
 * - TUI 只读：任何写必须经 server API
 * - 通过 data.ts hooks 访问数据（禁止直接调 SDK）
 * - signals + event subscription（禁止 createResource）
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, Show, type JSX } from "solid-js"
import type { DAGWorkflowSession } from "@/dag/session/types"
import { useTheme } from "@tui/context/theme"
import {
  useWorkflowList,
  useWorkflow,
  useNodes,
  useViolations,
} from "./data"
import {
  DagWorkflowRenderer,
  DagProgressBar,
  DagWorkflowSidebar,
  DagWorkflowDetail,
} from "./renderer"

const ROUTE = "dag-workflow"

export function ConsoleRoute(props: { api: TuiPluginApi }): JSX.Element {
  const { theme } = useTheme()

  const routeParams = createMemo(
    () =>
      ("params" in props.api.route.current
        ? props.api.route.current.params
        : undefined) as
        | { sessionID?: string; workflowId?: string; returnRoute?: { name: string } }
        | undefined,
  )

  const sessionID = createMemo(() => routeParams()?.sessionID ?? "")
  const [currentWorkflowID, setCurrentWorkflowID] = createSignal<string | undefined>(
    routeParams()?.workflowId,
  )
  const [selectedNodeID, setSelectedNodeID] = createSignal<string | null>(null)
  const [isLoading, setIsLoading] = createSignal(false)

  const { list: workflowList } = useWorkflowList({
    kv: props.api.kv,
    session_id: sessionID,
  })

  const { workflow: currentWorkflow } = useWorkflow({
    kv: props.api.kv,
    workflowId: currentWorkflowID,
  })

  const { nodes } = useNodes({
    kv: props.api.kv,
    workflowId: currentWorkflowID,
  })

  const { violations } = useViolations({
    kv: props.api.kv,
    workflowId: currentWorkflowID,
  })

  const progress = createMemo(() => {
    const wf = currentWorkflow()
    if (!wf) return { completed: 0, total: 0, status: "pending" as const }
    const completed = Object.values(wf.node_sessions).filter(
      (n) => n.status === "completed",
    ).length
    const total = Object.values(wf.node_sessions).length
    return { completed, total, status: wf.status }
  })

  function goToSessionTab() {
    const returnRoute = routeParams()?.returnRoute
    if (returnRoute?.name) {
      props.api.route.navigate(returnRoute.name)
    } else if (sessionID()) {
      props.api.route.navigate("session", { sessionID: sessionID() })
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
            对话
          </text>
          <text fg={theme.text}>
            <b>DAG Workflow</b>
          </text>
        </box>
        <text fg={theme.textMuted} onMouseUp={goToSessionTab}>
          [Esc] Back
        </text>
      </box>

      {/* 主体：左/中/右三区 */}
      <box flexDirection="row" flexGrow={1} minHeight={0}>
        {/* Left: workflow 历史列表 */}
        <box
          flexGrow={0}
          flexShrink={0}
          width={30}
          paddingLeft={1}
          paddingTop={1}
          paddingBottom={1}
          border={["right"]}
          borderColor={theme.border}
        >
          <scrollbox flexGrow={1} minHeight={0}>
            <DagWorkflowSidebar
              workflows={workflowList()}
              selectedId={currentWorkflowID() ?? null}
              onSelect={(id) => {
                setCurrentWorkflowID(id)
                setSelectedNodeID(null)
              }}
            />
          </scrollbox>
        </box>

        {/* Middle: 进度条 + 节点树 */}
        <box flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2} paddingTop={1} gap={1}>
          <Show
            when={currentWorkflow()}
            fallback={
              <box flexGrow={1} alignItems="center" justifyContent="center">
                <text fg={theme.textMuted}>
                  {isLoading() ? "Loading workflow..." : "Select a workflow from the list"}
                </text>
              </box>
            }
          >
            {(wf) => (
              <box flexGrow={1} minHeight={0} gap={1}>
                <DagProgressBar
                  completed={progress().completed}
                  total={progress().total}
                  status={progress().status}
                />
                <scrollbox flexGrow={1} minHeight={0} stickyScroll={false} stickyStart="top">
                  <DagWorkflowRenderer
                    workflow={wf()}
                    nodes={nodes()}
                    violations={violations()}
                    selectedNodeId={selectedNodeID()}
                    onNodeSelect={(nodeId) => setSelectedNodeID(nodeId)}
                  />
                </scrollbox>
              </box>
            )}
          </Show>
        </box>

        {/* Right: 选中 workflow 详情 */}
        <box
          flexGrow={0}
          flexShrink={0}
          width={40}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
          border={["left"]}
          borderColor={theme.border}
        >
          <scrollbox flexGrow={1} minHeight={0}>
            <DagWorkflowDetail workflow={currentWorkflow() ?? null} />
          </scrollbox>
        </box>
      </box>

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
        <text fg={theme.textMuted}>[Tab] Navigate  [Enter] Select  [Esc] Back to Session</text>
        <Show when={selectedNodeID()}>
          <text fg={theme.primary}>Selected: {selectedNodeID()}</text>
        </Show>
      </box>
    </box>
  )
}
