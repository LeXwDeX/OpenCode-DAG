/** @jsxImportSource @opentui/solid */
/**
 * DAG Workflow 工作台渲染组件
 *
 * 复用 dag-console 的设计模式但独立实现，避免修改原文件。
 * 包含：DagWorkflowRenderer（节点树） / DagProgressBar（进度条）
 *       DagWorkflowSidebar（左侧历史列表） / DagWorkflowDetail（右侧详情）
 */
import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import type {
  DAGNodeSession,
  DAGNodeStatus,
  DAGViolation,
  DAGWorkflowSession,
  DAGWorkflowStatus,
} from "@/dag/session/types"
import { calculateWorkflowProgress } from "@/dag/session/types"
import { useTheme } from "@tui/context/theme"

function statusIcon(status: DAGNodeStatus) {
  const { theme } = useTheme()
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

function workflowStatusColor(status: DAGWorkflowStatus) {
  const { theme } = useTheme()
  switch (status) {
    case "running":
      return theme.warning
    case "completed":
      return theme.success
    case "failed":
      return theme.error
    case "cancelled":
      return theme.textMuted
    case "pending":
    default:
      return theme.textMuted
  }
}

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "\u2014"
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = Math.round(seconds % 60)
  return `${minutes}m ${remaining}s`
}

function DagNodeRow(props: {
  node: DAGNodeSession
  depth: number
  selected: boolean
  onSelect: () => void
}) {
  const { theme } = useTheme()
  const connector = () => (props.depth === 0 ? "\u251c\u2500" : "\u2502  \u251c\u2500")
  const sIcon = createMemo(() => statusIcon(props.node.status))

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
        <Show when={props.node.error_info?.message}>
          <text fg={theme.error}>{props.node.error_info!.message.slice(0, 40)}</text>
        </Show>
      </box>
    </box>
  )
}

/**
 * DagWorkflowRenderer — 节点树视图（中间区）
 */
export function DagWorkflowRenderer(props: {
  workflow: DAGWorkflowSession
  nodes: DAGNodeSession[]
  violations: DAGViolation[]
  selectedNodeId: string | null
  onNodeSelect: (nodeId: string) => void
}): JSX.Element {
  const { theme } = useTheme()
  const progress = createMemo(() => calculateWorkflowProgress(props.workflow))
  const wfColor = createMemo(() => workflowStatusColor(props.workflow.status))

  const rootNodes = createMemo(() =>
    props.nodes.filter((n) => n.dependencies.length === 0),
  )

  return (
    <box gap={1}>
      <box
        border={["top"]}
        borderColor={wfColor()}
        title={` ${props.workflow.config?.name ?? props.workflow.id} `}
        titleAlignment="center"
      />

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
          {(node) => (
            <DagNodeRow
              node={node}
              depth={0}
              selected={props.selectedNodeId === node.node_id}
              onSelect={() => props.onNodeSelect(node.node_id)}
            />
          )}
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

/**
 * DagProgressBar — workflow 进度条
 */
export function DagProgressBar(props: {
  completed: number
  total: number
  status: DAGWorkflowStatus
}): JSX.Element {
  const { theme } = useTheme()
  const percent = createMemo(() =>
    props.total > 0 ? Math.round((props.completed / props.total) * 100) : 0,
  )
  const barLength = 20
  const filled = createMemo(() => Math.round((percent() / 100) * barLength))
  const empty = createMemo(() => barLength - filled())
  const barColor = createMemo(() => workflowStatusColor(props.status))

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

/**
 * DagWorkflowSidebar — 左侧 workflow 历史列表
 */
export function DagWorkflowSidebar(props: {
  workflows: DAGWorkflowSession[]
  selectedId: string | null
  onSelect: (id: string) => void
}): JSX.Element {
  const { theme } = useTheme()

  function wfStatusIcon(status: DAGWorkflowStatus): string {
    switch (status) {
      case "running":
        return "\u25cf"
      case "completed":
        return "\u2713"
      case "failed":
        return "\u2717"
      case "cancelled":
        return "\u2298"
      case "pending":
      default:
        return "\u25cb"
    }
  }

  return (
    <box gap={1} paddingRight={1}>
      <text fg={theme.text}>
        <b>Workflow History</b>
      </text>
      <Show
        when={props.workflows.length > 0}
        fallback={
          <text fg={theme.textMuted}>No workflows yet</text>
        }
      >
        <For each={props.workflows}>
          {(workflow) => {
            const progress = createMemo(() => calculateWorkflowProgress(workflow))
            const isSelected = () => props.selectedId === workflow.id
            return (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                backgroundColor={isSelected() ? theme.backgroundElement : undefined}
                onMouseUp={() => props.onSelect(workflow.id)}
              >
                <text
                  flexShrink={0}
                  fg={
                    workflow.status === "running"
                      ? theme.warning
                      : workflow.status === "completed"
                        ? theme.success
                        : workflow.status === "failed"
                          ? theme.error
                          : theme.textMuted
                  }
                >
                  {wfStatusIcon(workflow.status)}
                </text>
                <text fg={theme.text} wrapMode="word">
                  {workflow.config?.name ?? workflow.id}
                </text>
                <text fg={theme.textMuted}>
                  {progress().all_nodes.completed}/{progress().all_nodes.total}
                </text>
              </box>
            )
          }}
        </For>
      </Show>
    </box>
  )
}

/**
 * DagWorkflowDetail — 右侧 workflow 详情
 */
export function DagWorkflowDetail(props: {
  workflow: DAGWorkflowSession | null
}): JSX.Element {
  const { theme } = useTheme()

  return (
    <Show
      when={props.workflow}
      fallback={
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg={theme.textMuted}>Select a workflow</text>
        </box>
      }
    >
      {(wf) => {
        const progress = createMemo(() => calculateWorkflowProgress(wf()))
        const wfColor = createMemo(() => workflowStatusColor(wf().status))
        return (
          <box gap={1} paddingLeft={1}>
            <text fg={wfColor()}>
              <b>{wf().config?.name ?? wf().id}</b>
            </text>
            <Show when={wf().config?.description}>
              <text fg={theme.textMuted}>{wf().config!.description}</text>
            </Show>
            <box border={["top"]} borderColor={theme.border} title=" Info " titleAlignment="center" />
            <box gap={1}>
              <text fg={theme.textMuted}>Status: <span style={{ fg: wfColor() }}>{wf().status}</span></text>
              <text fg={theme.textMuted}>
                ID: {wf().id}
              </text>
              <text fg={theme.textMuted}>
                Progress: {progress().all_nodes.completed}/{progress().all_nodes.total} nodes
              </text>
              <text fg={theme.textMuted}>
                Start: {new Date(wf().start_time).toLocaleTimeString()}
              </text>
              <Show when={wf().duration_ms !== null}>
                <text fg={theme.textMuted}>
                  Duration: {formatDuration(wf().duration_ms)}
                </text>
              </Show>
              <text fg={theme.textMuted}>
                Concurrency: {progress().current_concurrency}/{progress().max_concurrency}
              </text>
            </box>
            <Show when={wf().violations.length > 0}>
              <box border={["top"]} borderColor={theme.error} title=" Violations " titleAlignment="center" />
              <For each={wf().violations}>
                {(v) => (
                  <box flexDirection="row" gap={1}>
                    <text fg={theme.error}>{"\u26a0"}</text>
                    <text fg={theme.error}>[{v.severity}]</text>
                    <text fg={theme.textMuted}>{v.message}</text>
                  </box>
                )}
              </For>
            </Show>
          </box>
        )
      }}
    </Show>
  )
}
