/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, Show } from "solid-js"
import type { DAGWorkflowSession, DAGWorkflowStatus } from "@/dag/session/types"
import { calculateWorkflowProgress } from "@/dag/session/types"
import { DAGProgressBar } from "./renderer"

function workflowStatusIcon(status: DAGWorkflowStatus): string {
  switch (status) {
    case "running":
      return "●"
    case "completed":
      return "✓"
    case "failed":
      return "✗"
    case "cancelled":
      return "⊘"
    case "pending":
    default:
      return "○"
  }
}

export function DAGSidebarView(props: {
  api: TuiPluginApi
  session_id: string
}) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current

  const workflows = createMemo<DAGWorkflowSession[]>(() => {
    const data = props.api.kv.get<DAGWorkflowSession[]>("dag_workflows_" + props.session_id, [])
    return data
  })

  const hasWorkflows = createMemo(() => workflows().length > 0)
  const runningCount = createMemo(() =>
    workflows().filter((w) => w.status === "running").length
  )

  return (
    <Show when={hasWorkflows()}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => workflows().length > 2 && setOpen((x) => !x)}>
          <Show when={workflows().length > 2}>
            <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme().text}>
            <b>DAG Workflow</b>
            <Show when={!open()}>
              <span style={{ fg: theme().textMuted }}>
                {" "}{runningCount()} running
              </span>
            </Show>
          </text>
        </box>
        <Show when={workflows().length <= 2 || open()}>
          <For each={workflows()}>
            {(workflow) => {
              const progress = createMemo(() => calculateWorkflowProgress(workflow))
              const statusColor = workflowStatusIcon(workflow.status)

              return (
                <box
                  flexDirection="row"
                  gap={1}
                  paddingLeft={1}
                  onMouseUp={() =>
                    props.api.route.navigate("dag-console", {
                      workflowId: workflow.id,
                      sessionID: props.session_id,
                    })
                  }
                >
                  <text flexShrink={0} fg={
                    workflow.status === "running" ? theme().warning :
                    workflow.status === "completed" ? theme().success :
                    workflow.status === "failed" ? theme().error :
                    theme().textMuted
                  }>
                    {statusColor}
                  </text>
                  <text fg={theme().text} wrapMode="word">
                    {workflow.config?.name ?? workflow.id}
                  </text>
                  <text fg={theme().textMuted}>
                    {progress().all_nodes.completed}/{progress().all_nodes.total}
                  </text>
                </box>
              )
            }}
          </For>
        </Show>
      </box>
    </Show>
  )
}
