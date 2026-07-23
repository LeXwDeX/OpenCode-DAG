/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { DagNode, DagWorkflowSummary } from "@opencode-ai/sdk/v2"
import type { BuiltinTuiPlugin } from "../builtins"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { Spinner } from "../../component/spinner"

const id = "internal:sidebar-dag-panel"

const ACTIVE_STATUSES = new Set(["running", "paused", "stepping"])
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"])

function statusColor(theme: TuiPluginApi["theme"]["current"], status: string) {
  if (status === "completed") return theme.success
  if (status === "failed") return theme.error
  if (status === "cancelled") return theme.textMuted
  if (status === "running") return theme.textMuted
  if (status === "paused") return theme.warning
  if (status === "stepping") return theme.warning
  return theme.textMuted
}

function WorkflowRow(props: {
  api: TuiPluginApi
  summary: DagWorkflowSummary
  expanded: boolean
  onToggle: () => void
}) {
  const theme = () => props.api.theme.current
  const [nodes, setNodes] = createSignal<DagNode[]>([])

  const total = () => Number(props.summary.nodeCount)
  const completed = () => Number(props.summary.completedNodes)
  const running = () => Number(props.summary.runningNodes)
  const failed = () => Number(props.summary.failedNodes)

  const signature = () => `${total()}:${completed()}:${running()}:${failed()}`

  const fetchNodes = async (dagID: string, sig: string) => {
    try {
      const res = await props.api.client.dag.nodes({ dagID })
      // Stale guard: discard if the summary signature changed (or the row was
      // collapsed) between fetch-start and fetch-resolve.
      if (!props.expanded || signature() !== sig) return
      setNodes((res.data ?? []) as DagNode[])
    } catch {
      if (!props.expanded || signature() !== sig) return
      setNodes([])
    }
  }

  // Signature-triggered fetch: the signature memo only changes value when a
  // node count actually changes, so this effect re-runs (and re-fetches) only
  // on real state changes — never on a no-op summary event. No polling.
  createEffect(() => {
    const sig = signature()
    if (!props.expanded) {
      setNodes([])
      return
    }
    void fetchNodes(props.summary.id, sig)
  })

  const bar = () => {
    const width = 6
    const t = total()
    if (t <= 0) return ""
    const filled = Math.round((completed() / t) * width)
    return "▓".repeat(filled) + "░".repeat(width - filled)
  }

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1} onMouseDown={props.onToggle}>
        <text flexShrink={0} style={{ fg: statusColor(theme(), props.summary.status) }}>
          {props.expanded ? "▼" : "▶"}
        </text>
        <text fg={theme().text} wrapMode="char">
          {props.summary.title}
        </text>
        <text flexShrink={0} fg={theme().textMuted}>
          {bar()} {completed()}/{total()}
          {running() > 0 ? ` ▶${running()}` : ""}
          {failed() > 0 ? ` ✗${failed()}` : ""}
        </text>
      </box>
      <Show when={props.expanded}>
        <box flexDirection="column" paddingLeft={2}>
          <For each={nodes()}>
            {(node) => (
              <box flexDirection="row" gap={1}>
                <Show
                  when={node.status !== "running"}
                  fallback={<Spinner color={theme().textMuted} />}
                >
                  <text flexShrink={0} style={{ fg: statusColor(theme(), node.status) }}>
                    {node.status === "completed"
                      ? "✓"
                      : node.status === "failed"
                        ? "✗"
                        : node.status === "skipped" || node.status === "cancelled"
                          ? "⊘"
                          : "○"}
                  </text>
                </Show>
                <text fg={theme().text} wrapMode="char">
                  {node.name}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

function DagPanel(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const dags = createMemo(() => props.api.state.session.dag(props.session_id))
  const active = createMemo(() => dags().filter((d) => ACTIVE_STATUSES.has(d.status)))
  const terminal = createMemo(() => dags().filter((d) => TERMINAL_STATUSES.has(d.status)))

  const [expandedIDs, setExpandedIDs] = createSignal<Set<string>>(new Set())
  const [showTerminal, setShowTerminal] = createSignal(false)

  // Default-expand the first active workflow so the user immediately sees
  // node-level progress for the workflow that is currently doing work.
  createEffect(() => {
    const list = active()
    if (list.length === 0) return
    setExpandedIDs((prev) => {
      if (prev.size > 0) return prev
      return new Set([list[0]!.id])
    })
  })

  const isExpanded = (wfID: string) => expandedIDs().has(wfID)
  const toggle = (wfID: string) =>
    setExpandedIDs((prev) => {
      const next = new Set(prev)
      if (next.has(wfID)) next.delete(wfID)
      else next.add(wfID)
      return next
    })

  return (
    <Show when={dags().length > 0}>
      <box flexDirection="column" gap={1}>
        <text fg={theme().text}>
          <b>DAG</b>
        </text>
        <For each={active()}>
          {(summary) => (
            <WorkflowRow
              api={props.api}
              summary={summary}
              expanded={isExpanded(summary.id)}
              onToggle={() => toggle(summary.id)}
            />
          )}
        </For>
        <Show when={terminal().length > 0}>
          <box flexDirection="column">
            <box flexDirection="row" gap={1} onMouseDown={() => setShowTerminal((x) => !x)}>
              <text fg={theme().textMuted}>
                {showTerminal() ? "▼" : "▶"} done ({terminal().length})
              </text>
            </box>
            <Show when={showTerminal()}>
              <box flexDirection="column" paddingLeft={1}>
                <For each={terminal()}>
                  {(summary) => (
                    <WorkflowRow
                      api={props.api}
                      summary={summary}
                      expanded={isExpanded(summary.id)}
                      onToggle={() => toggle(summary.id)}
                    />
                  )}
                </For>
              </box>
            </Show>
          </box>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 460,
    slots: {
      sidebar_content(_ctx, props) {
        return <DagPanel api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
