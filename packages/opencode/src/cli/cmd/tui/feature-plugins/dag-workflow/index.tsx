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
import { GLYPH } from "./glyphs"
import { resolveLang, t, useLang } from "./i18n"

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
        title: t(resolveLang(api), "cmd_open_title"),
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
  const i18n = useLang(props.api)
  const isDagRoute = () => props.api.route.current.name === ROUTE

  function getCurrentSessionID(): string | undefined {
    const cur = props.api.route.current
    // On session route: read directly.
    if (cur.name === "session" && "params" in cur) {
      const id = cur.params?.sessionID
      if (typeof id === "string") return id
    }
    // On DAG route we persist sessionID in route params — read it back.
    if (cur.name === ROUTE && "params" in cur && cur.params) {
      const id = cur.params.sessionID
      if (typeof id === "string") return id
      // Fallback: extract from persisted returnRoute (legacy / stale).
      const rr = cur.params.returnRoute as
        | { name: string; params?: Record<string, unknown> }
        | undefined
      if (rr?.name === "session") {
        const s = rr.params?.sessionID
        if (typeof s === "string") return s
      }
    }
    return undefined
  }

  function navigateToDagWorkflow() {
    const sessionID = getCurrentSessionID()
    const current = props.api.route.current
    // Never write returnRoute that points back to DAG itself (loop).
    const returnRoute = current.name === ROUTE ? undefined : current
    props.api.route.navigate(ROUTE, {
      ...(sessionID ? { sessionID } : {}),
      ...(returnRoute ? { returnRoute } : {}),
    })
  }

  function navigateToSession() {
    const sessionID = getCurrentSessionID()
    if (sessionID) {
      props.api.route.navigate("session", { sessionID })
    } else {
      props.api.route.navigate("home")
    }
  }

  return (
    <box flexDirection="row" gap={2} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <text
        fg={!isDagRoute() ? theme().text : theme().textMuted}
        onMouseUp={isDagRoute() ? navigateToSession : undefined}
      >
        {!isDagRoute() ? <b>{i18n().t("tab_dialogue")}</b> : i18n().t("tab_dialogue")}
      </text>
      <text fg={theme().textMuted}>{GLYPH.vbar}</text>
      <text
        fg={isDagRoute() ? theme().text : theme().textMuted}
        onMouseUp={isDagRoute() ? undefined : navigateToDagWorkflow}
      >
        {isDagRoute() ? <b>{i18n().t("tab_workflow")}</b> : i18n().t("tab_workflow")}
      </text>
    </box>
  )
}
