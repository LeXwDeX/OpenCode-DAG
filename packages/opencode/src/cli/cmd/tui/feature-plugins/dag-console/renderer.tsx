/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, Show } from "solid-js"
import type {
  DAGNodeSession,
  DAGNodeStatus,
  DAGViolation,
  DAGWorkflowSession,
  DAGWorkflowStatus,
} from "@/dag/session/types"
import { calculateWorkflowProgress } from "@/dag/session/types"
import { useTheme } from "@tui/context/theme"

function statusIcon(status: DAGNodeStatus, theme: ReturnType<typeof useTheme>["theme"]) {
  switch (status) {
    case "completed":
      return { icon: "\u2713", color: theme.success }
    case "running":
      return { icon: "\u25cf", color: theme.warning }
    case "queued":
      return { icon: "\u25ce", color: theme.warning }
    case "pending":
      return { icon: "\u25cb", color: theme.textMuted }
    case "failed":
      return { icon: "\u2717", color: theme.error }
    case "skipped":
      return { icon: "\u2298", color: theme.error }
    default:
      return { icon: "?", color: theme.textMuted }
  }
}

function workflowStatusColor(status: DAGWorkflowStatus, theme: ReturnType<typeof useTheme>["theme"]) {
  switch (status) {
    case "running":
      return theme.warning
    case "completed":
      return theme.success
    case "failed":
    case "failed_with_violations":
      return theme.error
    case "cancelled":
      return theme.textMuted
    case "pending":
    default:
      return theme.textMuted
  }
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "\u2014"
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = Math.round(seconds % 60)
  return `${minutes}m ${remaining}s`
}

function DAGNodeRow(props: {
  node: DAGNodeSession
  depth: number
  selected: boolean
  onSelect: () => void
  expanded: boolean
  onToggle: () => void
}) {
  const { theme } = useTheme()
  const connector = () => {
    if (props.depth === 0) return "\u251c\u2500"
    return "\u2502  \u251c\u2500"
  }

  const sIcon = createMemo(() => statusIcon(props.node.status, theme))

  return (
    <box
      onMouseUp={props.onSelect}
      paddingLeft={props.depth > 0 ? 2 : 0}
      backgroundColor={props.selected ? theme.backgroundElement : undefined}
    >
      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted}>{connector()}</text>
        <text fg={sIcon().color}>{sIcon().icon}</text>
        <text fg={theme.text}>{props.node.config?.name ?? props.node.node_id}</text>
        <Show when={props.node.duration_ms !== null}>
          <text fg={theme.textMuted}>{formatDuration(props.node.duration_ms)}</text>
        </Show>
        <Show when={props.node.error_info}>
          <text fg={theme.error}>{props.node.error_info!.message?.slice(0, 40)}</text>
        </Show>
      </box>
      <Show when={props.expanded}>
        <box paddingLeft={4}>
          <text fg={theme.textMuted}>id: {props.node.node_id}</text>
          <text fg={theme.textMuted}>status: {props.node.status}</text>
          <Show when={props.node.dependencies.length > 0}>
            <text fg={theme.textMuted}>depends on: {props.node.dependencies.join(", ")}</text>
          </Show>
          <Show when={props.node.retry_count > 0}>
            <text fg={theme.warning}>retries: {props.node.retry_count}/{props.node.max_retries}</text>
          </Show>
          <Show when={props.node.logs.length > 0}>
            <box paddingTop={1}>
              <text fg={theme.textMuted}>logs ({props.node.logs.length}):</text>
              <For each={props.node.logs.slice(-3)}>
                {(log) => (
                  <text fg={theme.textMuted} wrapMode="word">
                    {"  "}{log}
                  </text>
                )}
              </For>
            </box>
          </Show>
        </box>
      </Show>
    </box>
  )
}

export function DAGRenderer(props: {
  workflow: DAGWorkflowSession
  nodes: DAGNodeSession[]
  violations: DAGViolation[]
  selectedNodeId: string | null
  onNodeSelect: (nodeId: string) => void
}) {
  const { theme } = useTheme()
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set())

  const progress = createMemo(() => calculateWorkflowProgress(props.workflow))
  const wfColor = createMemo(() => workflowStatusColor(props.workflow.status, theme))

  const rootNodes = createMemo(() =>
    props.nodes.filter((n) => n.dependencies.length === 0)
  )

  const childNodes = createMemo(() => {
    const map = new Map<string, DAGNodeSession[]>()
    for (const node of props.nodes) {
      for (const dep of node.dependencies) {
        const list = map.get(dep) ?? []
        list.push(node)
        map.set(dep, list)
      }
    }
    return map
  })

  function renderNode(node: DAGNodeSession, depth: number) {
    const children = childNodes().get(node.node_id) ?? []
    const isExpanded = expanded().has(node.node_id)
    const isSelected = props.selectedNodeId === node.node_id

    return (
      <box>
        <DAGNodeRow
          node={node}
          depth={depth}
          selected={isSelected}
          onSelect={() => props.onNodeSelect(node.node_id)}
          expanded={isExpanded}
          onToggle={() => {
            setExpanded((prev) => {
              const next = new Set(prev)
              if (next.has(node.node_id)) next.delete(node.node_id)
              else next.add(node.node_id)
              return next
            })
          }}
        />
        <Show when={isExpanded}>
          <For each={children}>
            {(child) => renderNode(child, depth + 1)}
          </For>
        </Show>
      </box>
    )
  }

  return (
    <box gap={1}>
      <box border={["top"]} borderColor={wfColor()} title={` ${props.workflow.config?.name ?? props.workflow.id} `} titleAlignment="center" />

      <box flexDirection="row" gap={2} paddingLeft={1}>
        <text fg={wfColor()}>Status: {props.workflow.status}</text>
        <text fg={theme.textMuted}>
          Progress: {progress().all_nodes.completed}/{progress().all_nodes.total}
        </text>
        <Show when={props.workflow.duration_ms !== null}>
          <text fg={theme.textMuted}>Duration: {formatDuration(props.workflow.duration_ms)}</text>
        </Show>
      </box>

      <box paddingLeft={1} gap={0}>
        <For each={rootNodes()}>
          {(node) => renderNode(node, 0)}
        </For>
      </box>

      <Show when={props.violations.length > 0}>
        <box border={["top"]} borderColor={theme.error} title=" Violations " titleAlignment="center" />
        <For each={props.violations}>
          {(violation) => (
            <box flexDirection="row" gap={1} paddingLeft={1}>
              <text fg={theme.error}>{"\u26a0"}</text>
              <text fg={theme.error}>[{violation.severity}]</text>
              <text fg={theme.text}>{violation.type}:</text>
              <text fg={theme.textMuted}>{violation.message}</text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

export function DAGProgressBar(props: {
  completed: number
  total: number
  status: DAGWorkflowStatus
}) {
  const { theme } = useTheme()
  const percent = createMemo(() =>
    props.total > 0 ? Math.round((props.completed / props.total) * 100) : 0
  )
  const barLength = 20
  const filled = createMemo(() => Math.round((percent() / 100) * barLength))
  const empty = createMemo(() => barLength - filled())

  const barColor = createMemo(() => workflowStatusColor(props.status, theme))

  return (
    <box flexDirection="row" gap={1}>
      <text fg={theme.textMuted}>Progress:</text>
      <text fg={barColor()}>
        {"["}
        <span style={{ fg: barColor() }}>{"\u25a0".repeat(filled())}</span>
        <span style={{ fg: theme.textMuted }}>{"\u25a1".repeat(empty())}</span>
        {"]"}
      </text>
      <text fg={barColor()}>{percent()}%</text>
    </box>
  )
}
