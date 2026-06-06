/** @jsxImportSource @opentui/solid */
/**
 * Sidebar — global history search + status filter
 *
 * Lists all workflow sessions with status radio filters and name search.
 * Status values come from DAGWorkflowStatus type (not hardcoded).
 *
 * Architecture constraints:
 * - ReadOnly: no state mutations
 * - Status enum imported from types (no hardcoding)
 */
import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import type {
  DAGWorkflowSession,
  DAGWorkflowStatus,
} from "@/dag/session/types"
import { useTheme } from "@tui/context/theme"
import { workflowStatusColor, workflowStatusIconChar } from "./status"

/** All valid workflow statuses for the filter radio buttons. */
export const WORKFLOW_STATUSES: DAGWorkflowStatus[] = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]

/**
 * Status icon character for a workflow status.
 */
export function workflowStatusIcon(status: DAGWorkflowStatus): string {
  return workflowStatusIconChar(status)
}

/**
 * Sidebar component — workflow history list with filters.
 */
export function Sidebar(props: {
  workflows: DAGWorkflowSession[]
  currentWorkflowID?: string
  onSelect: (id: string) => void
}): JSX.Element {
  const { theme } = useTheme()
  const [statusFilter, setStatusFilter] = createSignal<DAGWorkflowStatus | null>(null)
  const [search, setSearch] = createSignal("")

  const filtered = createMemo(() => {
    let list = props.workflows
    const sf = statusFilter()
    if (sf) list = list.filter((w) => w.status === sf)
    const q = search().toLowerCase()
    if (q) list = list.filter((w) => w.config?.name?.toLowerCase().includes(q))
    return list
  })

  return (
    <box gap={1}>
      {/* Status filter buttons (wrap to avoid overflow in narrow sidebar) */}
      <box flexDirection="row" gap={1} flexWrap="wrap">
        <For each={[null, ...WORKFLOW_STATUSES]}>
          {(s) => (
            <text
              fg={statusFilter() === s ? theme.primary : theme.textMuted}
              onMouseUp={() => setStatusFilter(s)}
            >
              {s ?? "All"}
            </text>
          )}
        </For>
      </box>

      {/* Search input (plain text; actual input binding in Phase ④ or keymap) */}
      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted}>Search:</text>
        <input
          flexGrow={1}
          onInput={(val) => setSearch(val)}
        />
      </box>

      {/* Filtered list */}
      <Show
        when={filtered().length > 0}
        fallback={<text fg={theme.textMuted}>No workflows</text>}
      >
        <For each={filtered()}>
          {(wf) => {
            const isSelected = () => props.currentWorkflowID === wf.id
            return (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                backgroundColor={isSelected() ? theme.backgroundElement : undefined}
                onMouseUp={() => props.onSelect(wf.id)}
              >
                <text fg={workflowStatusColor(wf.status, theme)}>
                  {workflowStatusIcon(wf.status)}
                </text>
                <text fg={theme.text} wrapMode="word">
                  {wf.config?.name ?? wf.id}
                </text>
              </box>
            )
          }}
        </For>
      </Show>
    </box>
  )
}
