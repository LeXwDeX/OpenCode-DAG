/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show, createSignal } from "solid-js"

const id = "internal:sidebar-dag"

function DagIndicator(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const dags = createMemo(() => props.api.state.session.dag(props.session_id))
  const active = createMemo(() => dags().filter((d) => d.status === "running" || d.status === "paused" || d.status === "stepping"))

  const statusColor = (status: string) => {
    if (status === "completed") return theme().success
    if (status === "failed") return theme().error
    if (status === "cancelled") return theme().textMuted
    if (status === "running") return theme().textMuted
    if (status === "paused") return theme().warning
    if (status === "stepping") return theme().warning
    return theme().textMuted
  }

  return (
    <Show when={active().length > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => active().length > 2 && setOpen((x) => !x)}>
          <Show when={active().length > 2}>
            <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme().text}>
            <b>DAG System</b>
            <Show when={!open() || active().length <= 2}>
              <span style={{ fg: theme().textMuted }}>
                {" "}
                ({active().length} workflow{active().length > 1 ? "s" : ""})
              </span>
            </Show>
          </text>
        </box>
        <Show when={active().length <= 2 || open()}>
          <For each={active()}>
            {(dag) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: statusColor(dag.status),
                  }}
                >
                  •
                </text>
                <text fg={theme().text} wrapMode="word">
                  {dag.title}{" "}
                  <span style={{ fg: theme().textMuted }}>
                    ({Number(dag.completedNodes)}/{Number(dag.nodeCount)}
                    {Number(dag.runningNodes) > 0 ? `, ${Number(dag.runningNodes)} running` : ""}
                    {Number(dag.failedNodes) > 0 ? `, ${Number(dag.failedNodes)} failed` : ""})
                  </span>
                </text>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 450,
    slots: {
      session_prompt_right(_ctx, props) {
        return <DagIndicator api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
