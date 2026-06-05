/** @jsxImportSource @opentui/solid */
import { createMemo, Show, For } from "solid-js"
import type { DAGNodeSession, DAGNodeStatus } from "@/dag/session/types"
import { useTheme } from "@tui/context/theme"
import { Dialog } from "@tui/ui/dialog"

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "\u2014"
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = Math.round(seconds % 60)
  return `${minutes}m ${remaining}s`
}

function nodeStatusColor(status: DAGNodeStatus, theme: ReturnType<typeof useTheme>["theme"]) {
  switch (status) {
    case "completed":
      return theme.success
    case "running":
      return theme.warning
    case "queued":
      return theme.warning
    case "pending":
      return theme.textMuted
    case "failed":
      return theme.error
    case "skipped":
      return theme.error
    default:
      return theme.textMuted
  }
}

export function DAGNodeDialog(props: { node: DAGNodeSession; onClose: () => void }) {
  const { theme } = useTheme()
  const statusColor = createMemo(() => nodeStatusColor(props.node.status, theme))
  const name = () => props.node.config?.name ?? props.node.node_id

  return (
    <Dialog size="large" onClose={props.onClose}>
      <box padding={2} gap={1}>
        <box flexDirection="row" gap={2}>
          <text fg={theme.text}><b>Node: {name()}</b></text>
          <text fg={statusColor()}>{props.node.status}</text>
        </box>

        <box border={["top"]} borderColor={theme.border} title=" Details " titleAlignment="center" />

        <box gap={1} paddingLeft={1}>
          <text fg={theme.textMuted}>ID: {props.node.node_id}</text>
          <text fg={theme.textMuted}>Workflow: {props.node.workflow_id}</text>
          <text fg={theme.textMuted}>
            Duration: {formatDuration(props.node.duration_ms)}
          </text>
          <text fg={theme.textMuted}>
            Retries: {props.node.retry_count} / {props.node.max_retries}
          </text>
          <Show when={props.node.config?.description}>
            <text fg={theme.text}>{props.node.config!.description}</text>
          </Show>
          <Show when={props.node.dependencies.length > 0}>
            <text fg={theme.textMuted}>
              Dependencies: {props.node.dependencies.join(", ")}
            </text>
          </Show>
          <Show when={props.node.required_nodes.length > 0}>
            <text fg={theme.textMuted}>
              Required Nodes: {props.node.required_nodes.join(", ")}
            </text>
          </Show>
        </box>

        <Show when={props.node.error_info}>
          <box border={["top"]} borderColor={theme.error} title=" Error " titleAlignment="center" />
          <box paddingLeft={1} gap={1}>
            <text fg={theme.error}>Type: {props.node.error_info!.type}</text>
            <text fg={theme.error}>Message: {props.node.error_info!.message}</text>
            <text fg={theme.textMuted}>
              Retryable: {props.node.error_info!.retryable ? "yes" : "no"}
            </text>
          </box>
        </Show>

        <Show when={props.node.logs.length > 0}>
          <box border={["top"]} borderColor={theme.border} title=" Logs " titleAlignment="center" />
          <box paddingLeft={1} maxHeight={10}>
            <For each={props.node.logs}>
              {(log) => (
                <text fg={theme.textMuted} wrapMode="word">{log}</text>
              )}
            </For>
          </box>
        </Show>

        <Show when={props.node.metrics}>
          <box border={["top"]} borderColor={theme.border} title=" Metrics " titleAlignment="center" />
          <box flexDirection="row" gap={2} paddingLeft={1}>
            <Show when={props.node.metrics?.cpu_percent}>
              <text fg={theme.textMuted}>CPU: {props.node.metrics!.cpu_percent}%</text>
            </Show>
            <Show when={props.node.metrics?.memory_mb}>
              <text fg={theme.textMuted}>Memory: {props.node.metrics!.memory_mb}MB</text>
            </Show>
          </box>
        </Show>

        <box flexDirection="row" justifyContent="flex-end" paddingTop={1}>
          <text fg={theme.primary} onMouseUp={props.onClose}>
            [Close - Esc]
          </text>
        </box>
      </box>
    </Dialog>
  )
}
