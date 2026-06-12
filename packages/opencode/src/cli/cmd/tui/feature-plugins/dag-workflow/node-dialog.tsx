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
import { GLYPH } from "./glyphs"
import type { Lang } from "./i18n"
import { t, nodeStatusLabel } from "./i18n"

/**
 * NodeDialog — renders node detail with optional "Enter Sub-Session" action.
 */
export function NodeDialog(props: {
  lang: Lang
  node: DAGNodeSession | null
  onClose: () => void
  route: TuiPluginApi["route"]
  toolCounts?: () => Record<string, number>
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
          <text fg={theme.textMuted}>{t(props.lang, "node_select_hint")}</text>
        </box>
      }
    >
      {(node) => (
        <box gap={1} paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1}>
          <text fg={theme.text}>
            <b>{node().config?.name ?? node().node_id}</b>
          </text>
          <text fg={theme.textMuted}>
            {t(props.lang, "label_status")}: {nodeStatusLabel(props.lang, node().status)}
          </text>
          <text fg={theme.textMuted}>
            {t(props.lang, "label_retries")}: {node().retry_count}/{node().max_retries}
          </text>
          <Show
            when={
              typeof node().metadata?.chat_session_id === "string" && props.toolCounts
            }
          >
            <text fg={theme.textMuted}>
              {t(props.lang, "label_tool_calls")}:{" "}
              {props.toolCounts!()[node().metadata!.chat_session_id as string] ?? 0}
            </text>
          </Show>
          <box gap={0}>
            <text fg={theme.textMuted}>{t(props.lang, "label_timing")}</text>
            <text fg={theme.textMuted}>{t(props.lang, "label_start_time")}: {formatNodeTime(node().start_time)}</text>
            <text fg={theme.textMuted}>{t(props.lang, "label_end_time")}: {formatNodeTime(node().end_time)}</text>
            <text fg={theme.textMuted}>{t(props.lang, "label_completed_at")}: {formatNodeTime(node().completed_at)}</text>
            <text fg={theme.textMuted}>{t(props.lang, "label_duration")}: {formatNodeDuration(node().duration_ms)}</text>
          </box>
          <Show when={node().dependencies.length > 0}>
            <text fg={theme.textMuted}>
              {t(props.lang, "label_deps")}: {node().dependencies.join(", ")}
            </text>
          </Show>
          <Show when={node().output !== null && node().output !== undefined}>
            <box gap={0}>
              <text fg={theme.textMuted}>{t(props.lang, "label_output")}</text>
              <text fg={theme.text} wrapMode="word">{truncateNodeText(node().output)}</text>
            </box>
          </Show>
          <Show when={node().logs.length > 0}>
            <box gap={0}>
              <text fg={theme.textMuted}>{t(props.lang, "label_snapshot_logs")}</text>
              <text fg={theme.text} wrapMode="word">{truncateNodeText(node().logs.join("\n"))}</text>
            </box>
          </Show>
          <Show when={node().error_info}>
            <text fg={theme.error}>
              {t(props.lang, "label_error")}: {node().error_info!.type}: {node().error_info!.message}
            </text>
          </Show>

          {/* Enter Sub-Session button */}
          <Show
            when={subSessionID()}
            fallback={
              <text fg={theme.textMuted}>
                {t(props.lang, "node_subsession_unavailable")}
              </text>
            }
          >
            <text
              fg={theme.primary}
              onMouseUp={enterSubSession}
            >
              {t(props.lang, "node_enter_subsession")}
            </text>
          </Show>

          <text fg={theme.textMuted} onMouseUp={props.onClose}>
            {t(props.lang, "action_close")}
          </text>
        </box>
      )}
    </Show>
  )
}

export function formatNodeTime(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "-"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "-" : date.toISOString()
}

export function formatNodeDuration(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : `${value}ms`
}

export function truncateNodeText(value: unknown): string {
  return truncateText(stringifyUnknown(value))
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function truncateText(value: string): string {
  const byLines = value.split("\n")
  const lineLimited = byLines.length > 20 ? `${byLines.slice(0, 20).join("\n")}\n${GLYPH.ellipsis}` : value
  return lineLimited.length > 2000 ? `${lineLimited.slice(0, 2000)}${GLYPH.ellipsis}` : lineLimited
}
