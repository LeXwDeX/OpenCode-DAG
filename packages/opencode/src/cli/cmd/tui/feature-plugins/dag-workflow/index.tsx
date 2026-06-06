/** @jsxImportSource @opentui/solid */
/**
 * DAG Workflow TUI Plugin Entry
 *
 * - 注册 "dag-workflow" Console Route
 * - 在 session_topbar 插槽渲染 Tab 切换控件
 * - 注册 "dag.workflow.open" 命令（用于键盘快捷键）
 */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import type { JSX } from "solid-js"
import { ConsoleRoute } from "./console-route"

const id = "internal:dag-workflow"
const ROUTE = "dag-workflow"

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 500,
    slots: {
      session_topbar() {
        return <DagWorkflowTab api={api} />
      },
    },
  })

  api.route.register([
    {
      name: ROUTE,
      render: () => <ConsoleRoute api={api} />,
    },
  ])

  api.keymap.registerLayer({
    commands: [
      {
        name: "dag.workflow.open",
        title: "打开 DAG 工作流面板",
        category: "DAG",
        namespace: "palette",
        run() {
          const current = api.route.current
          if (current.name === "session" && "params" in current) {
            api.route.navigate(ROUTE, {
              sessionID: current.params?.sessionID,
              returnRoute: current,
            })
          } else {
            api.route.navigate(ROUTE, { returnRoute: current })
          }
          api.ui.dialog.clear()
        },
      },
    ],
  })
}

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin

/** 暴露给 session_topbar 渲染的 Tab 控件: [对话 | DAG 工作流] */
export function DagWorkflowTab(props: { api: TuiPluginApi }): JSX.Element {
  const theme = () => props.api.theme.current
  const isDagRoute = () => props.api.route.current.name === ROUTE

  function getCurrentSessionID(): string | undefined {
    const cur = props.api.route.current
    if (cur.name !== "session" || !("params" in cur)) return undefined
    const id = cur.params?.sessionID
    return typeof id === "string" ? id : undefined
  }

  function navigateToDagWorkflow() {
    const current = props.api.route.current
    props.api.route.navigate(ROUTE, {
      sessionID: getCurrentSessionID(),
      returnRoute: current,
    })
  }

  function navigateToSession() {
    const sessionID = getCurrentSessionID()
    if (sessionID) {
      props.api.route.navigate("session", { sessionID })
    }
  }

  return (
    <box flexDirection="row" gap={2} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <text
        fg={!isDagRoute() ? theme().text : theme().textMuted}
        onMouseUp={isDagRoute() ? navigateToSession : undefined}
      >
        {!isDagRoute() ? <b>对话</b> : "对话"}
      </text>
      <text fg={theme().textMuted}>│</text>
      <text
        fg={isDagRoute() ? theme().text : theme().textMuted}
        onMouseUp={isDagRoute() ? undefined : navigateToDagWorkflow}
      >
        {isDagRoute() ? <b>DAG 工作流</b> : "DAG 工作流"}
      </text>
    </box>
  )
}
