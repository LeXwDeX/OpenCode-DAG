/** @jsxImportSource @opentui/solid */
/**
 * DAG Workflow TUI Plugin Entry
 *
 * - 注册 "dag-workflow" Console Route
 * - 注册 "dag.workflow.open" 命令（用于键盘快捷键）
 */
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { ConsoleRoute } from "./console-route"
import { resolveLang, t } from "./i18n"

const id = "internal:dag-workflow"
const ROUTE = "dag-workflow"

const tui: TuiPlugin = async (api) => {
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
