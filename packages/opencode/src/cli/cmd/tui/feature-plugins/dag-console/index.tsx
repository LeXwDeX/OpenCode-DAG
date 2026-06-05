/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { DAGSidebarView } from "./sidebar"
import { DAGConsoleView } from "./console-route"

const id = "internal:dag-console"
const ROUTE = "dag-console"

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 500,
    slots: {
      sidebar_content(_ctx, props) {
        return <DAGSidebarView api={api} session_id={props.session_id} />
      },
    },
  })

  api.route.register([
    {
      name: ROUTE,
      render: () => <DAGConsoleView api={api} />,
    },
  ])

  api.keymap.registerLayer({
    commands: [
      {
        name: "dag.console.open",
        title: "Open DAG Console",
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
