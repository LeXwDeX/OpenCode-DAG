/** @jsxImportSource @opentui/solid */
/**
 * Node Dialog — detail panel for selected DAG node
 *
 * Displays node status, dependencies, error info, retry count.
 * Provides "Enter Sub-Session" button when node has a chat_session_id in metadata.
 *
 * Architecture constraints:
 * - ReadOnly: navigation via route.navigate (no direct store calls)
 * - Bridge 单向：no write-back to DAG state
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createMemo, Show, type JSX } from "solid-js"
import type { DAGNodeSession, DAGNodeStatus } from "@/dag/session/types"
import { useTheme } from "@tui/context/theme"

const STATUS_LABELS: Record<DAGNodeStatus, string> = {
  completed: "Completed",
  running: "Running",
  pending: "Pending",
  queued: "Queued",
  failed: "Failed",
  skipped: "Skipped",
}

/**
 * Status label for a node.
 */
export function nodeStatusLabel(status: DAGNodeStatus): string {
  return STATUS_LABELS[status] ?? status
}

/**
 * NodeDialog — renders node detail with optional "Enter Sub-Session" action.
 */
export function NodeDialog(props: {
  node: DAGNodeSession | null
  onClose: () => void
  route: TuiPluginApi["route"]
}): JSX.Element {
  const { theme } = useTheme()

  const subSessionID = createMemo(() => {
    const id = props.node?.metadata?.chat_session_id
    return typeof id === "string" ? id : null
  })

  function enterSubSession() {
    const sid = subSessionID()
    if (!sid) return
    props.route.navigate("session", { sessionID: sid })
  }

  return (
    <Show
      when={props.node}
      fallback={
        <box alignItems="center" justifyContent="center">
          <text fg={theme.textMuted}>Select a node</text>
        </box>
      }
    >
      {(node) => (
        <box gap={1} paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1}>
          <text fg={theme.text}>
            <b>{node().config?.name ?? node().node_id}</b>
          </text>
          <text fg={theme.textMuted}>
            Status: {nodeStatusLabel(node().status)}
          </text>
          <text fg={theme.textMuted}>
            Retries: {node().retry_count}/{node().max_retries}
          </text>
          <Show when={node().dependencies.length > 0}>
            <text fg={theme.textMuted}>
              Deps: {node().dependencies.join(", ")}
            </text>
          </Show>
          <Show when={node().error_info}>
            <text fg={theme.error}>
              Error: {node().error_info!.type}: {node().error_info!.message}
            </text>
          </Show>

          {/* Enter Sub-Session button */}
          <Show
            when={subSessionID()}
            fallback={
              <text fg={theme.textMuted}>
                [Sub-session not available]
              </text>
            }
          >
            <text
              fg={theme.primary}
              onMouseUp={enterSubSession}
            >
              [Enter Sub-Session →]
            </text>
          </Show>

          <text fg={theme.textMuted} onMouseUp={props.onClose}>
            [Close]
          </text>
        </box>
      )}
    </Show>
  )
}
