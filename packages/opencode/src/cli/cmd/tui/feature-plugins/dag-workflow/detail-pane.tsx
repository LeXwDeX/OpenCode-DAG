/** @jsxImportSource @opentui/solid */
/**
 * DetailPane — selected-node detail group (scrollbox panels + LiveTicker)
 *
 * Single source for the right-column content reused by console-route in both
 * wide (inline) and narrow (absolute drawer) layouts. Pure presentation: it
 * receives already-resolved props and renders the panel group. It does NOT own
 * data hooks or state and does NOT import data.ts/SDK at runtime — it only
 * forwards the `route` (for NodeDialog) and `event` (for LiveTicker) props.
 *
 * Architecture constraints:
 * - ReadOnly: no state ownership, no write-back
 * - Zero data.ts/SDK runtime import; type-only imports for shapes are allowed
 * - Group boundary: scrollbox(NodeDialog + WorkflowHistoryPanel + NodeLogsPanel
 *   + TimelinePanel) followed by a sibling LiveTicker outside the scrollbox.
 *   The outer container (border/width/position) stays in console-route.
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { JSX } from "solid-js"
import type { DAGNodeSession } from "@/dag/session/types"
import type { WorkflowHistory, NodeLog, Timeline, InspectDiagnosticsApi } from "./data"
import { LiveTicker } from "./live-ticker"
import { NodeDialog } from "./node-dialog"
import { WorkflowHistoryPanel } from "./history-panel"
import { NodeLogsPanel } from "./node-logs-panel"
import { TimelinePanel } from "./timeline-panel"
import { InspectPanel } from "./inspect-panel"
import type { Lang } from "./i18n"

export function DetailPane(props: {
  lang: Lang
  node: DAGNodeSession | null
  toolCounts: () => Record<string, number>
  route: TuiPluginApi["route"]
  onNodeClose: () => void
  history: WorkflowHistory[]
  historyError: string | null
  historyLoading: boolean
  logs: NodeLog[]
  logsError: string | null
  logsLoading: boolean
  timeline: Timeline | null
  timelineError: string | null
  timelineLoading: boolean
  inspect: InspectDiagnosticsApi
  event: TuiPluginApi["event"]
  nodes: DAGNodeSession[]
}): JSX.Element {
  return (
    <>
      <scrollbox flexGrow={1} minHeight={0}>
        <NodeDialog
          lang={props.lang}
          node={props.node}
          onClose={props.onNodeClose}
          route={props.route}
          toolCounts={props.toolCounts}
        />
        <WorkflowHistoryPanel
          lang={props.lang}
          history={props.history}
          error={props.historyError}
          loading={props.historyLoading}
        />
        <NodeLogsPanel
          lang={props.lang}
          logs={props.logs}
          error={props.logsError}
          loading={props.logsLoading}
        />
        <TimelinePanel
          lang={props.lang}
          timeline={props.timeline}
          loading={props.timelineLoading}
          error={props.timelineError}
        />
        <InspectPanel
          lang={props.lang}
          block={props.inspect.block()}
          topology={props.inspect.topology()}
          snapshot={props.inspect.snapshot()}
          cascade={props.inspect.cascade()}
          selectedNodeId={props.node?.node_id ?? null}
          loading={props.inspect.loading()}
          error={props.inspect.error()}
        />
      </scrollbox>
      <LiveTicker lang={props.lang} event={props.event} nodes={props.nodes} />
    </>
  )
}
