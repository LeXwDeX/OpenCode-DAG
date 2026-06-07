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
import { For, Show, type JSX } from "solid-js"
import type {
  DAGWorkflowSession,
  DAGWorkflowStatus,
} from "@/dag/session/types"
import { useTheme } from "@tui/context/theme"
import { workflowStatusColor, workflowStatusIconChar } from "./status"
import type { Lang } from "./i18n"
import { t, workflowStatusLabel } from "./i18n"

/** All valid workflow statuses for the filter radio buttons. */
export const WORKFLOW_STATUSES: DAGWorkflowStatus[] = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "paused",
]

/**
 * Status icon character for a workflow status.
 */
export function workflowStatusIcon(status: DAGWorkflowStatus): string {
  return workflowStatusIconChar(status)
}

/**
 * Sidebar component — workflow history list with filters.
 *
 * Controlled component: filter/search state is owned by the parent
 * (console-route) so keyboard navigation and the visible list stay in sync.
 * `workflows` is expected to be already filtered by the parent.
 */
export function Sidebar(props: {
  lang: Lang
  workflows: DAGWorkflowSession[]
  statusFilter: DAGWorkflowStatus | null
  search: string
  currentWorkflowID?: string
  onStatusFilter: (s: DAGWorkflowStatus | null) => void
  onSearch: (q: string) => void
  onSelect: (id: string) => void
}): JSX.Element {
  const { theme } = useTheme()

  return (
    <box gap={1}>
      {/* Status filter buttons (wrap to avoid overflow in narrow sidebar) */}
      <box flexDirection="row" gap={1} flexWrap="wrap">
        <For each={[null, ...WORKFLOW_STATUSES]}>
          {(s) => (
            <text
              fg={props.statusFilter === s ? theme.primary : theme.textMuted}
              onMouseUp={() => props.onStatusFilter(s)}
            >
              {s === null ? t(props.lang, "filter_all") : workflowStatusLabel(props.lang, s)}
            </text>
          )}
        </For>
      </box>

      {/* Search input */}
      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted}>{t(props.lang, "label_search")}</text>
        <input
          flexGrow={1}
          value={props.search}
          onInput={(val) => props.onSearch(val)}
        />
      </box>

      {/* Filtered list */}
      <Show
        when={props.workflows.length > 0}
        fallback={<text fg={theme.textMuted}>{t(props.lang, "label_no_workflows")}</text>}
      >
        <For each={props.workflows}>
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
