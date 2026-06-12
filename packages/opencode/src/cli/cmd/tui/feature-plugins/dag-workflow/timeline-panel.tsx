/** @jsxImportSource @opentui/solid */
/**
 * TimelinePanel — WP-TUI-4 时间线面板
 *
 * 四态展示：
 * - empty:    无 timeline 数据时显示空状态提示
 * - loading:  首次加载中
 * - error:    加载失败时显示错误
 * - non-empty: 按 timestamp 升序渲染每条事件
 *
 * 每条事件格式：[HH:MM:SS] <nodeName>: <type> (<duration>)
 */
import { For, Show, type JSX } from "solid-js"
import type { Timeline, TimelineEvent } from "./data"
import { useTheme } from "@tui/context/theme"
import type { Lang } from "./i18n"
import { t } from "./i18n"
import { GLYPH } from "./glyphs"

interface TimelinePanelProps {
  lang: Lang
  timeline: Timeline | null
  loading?: boolean
  error?: string | null
  maxHeight?: number
}

export function TimelinePanel(props: TimelinePanelProps): JSX.Element {
  const { theme } = useTheme()
  const sortedEvents = () =>
    props.timeline
      ? [...props.timeline.events].sort((a, b) => a.timestamp - b.timestamp)
      : []

  return (
    <box gap={1}>
      <text fg={theme.text}>
        <b>{t(props.lang, "title_timeline")}</b>
      </text>
      <Show
        when={!props.error}
        fallback={
          <text fg={theme.error}>
            {t(props.lang, "label_load_error")}: {props.error}
          </text>
        }
      >
        <Show
          when={sortedEvents().length > 0}
          fallback={
            <text fg={theme.textMuted}>
              {props.loading
                ? t(props.lang, "label_loading")
                : t(props.lang, "timeline_empty")}
            </text>
          }
        >
          <For each={sortedEvents()}>
            {(ev) => (
              <box gap={0}>
                <text fg={theme.text}>
                  [{"\u200B"}
                  {formatTime(ev.timestamp)}]{" "}
                  <span style={{ fg: theme.text }}>
                    {resolveNodeName(props.timeline!, ev.nodeId)}
                  </span>
                  : {eventTypeLabel(props.lang, ev.type)}
                </text>
                <Show when={ev.duration !== null}>
                  <text fg={theme.textMuted}>
                    {formatEventDuration(ev.duration!)}
                  </text>
                </Show>
              </box>
            )}
          </For>
        </Show>
      </Show>
    </box>
  )
}

function resolveNodeName(timeline: Timeline, nodeId: string): string {
  return timeline.nodeExecutionTimes[nodeId]?.nodeName ?? nodeId
}

function eventTypeLabel(
  lang: Lang,
  type: TimelineEvent["type"],
): string {
  if (lang === "zh") {
    switch (type) {
      case "node_start":
        return "开始"
      case "node_complete":
        return "完成"
      case "node_failed":
        return "失败"
      case "edge_traversal":
        return "边遍历"
    }
  }
  return type
}

/** Format epoch ms → HH:MM:SS (UTC). Returns "-" for invalid values. */
export function formatTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return GLYPH.emDash
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return GLYPH.emDash
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

/** Format event duration (ms) with compact rules (<1s → Xms, else Xs / Xm Xs). */
export function formatEventDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = Math.round(seconds % 60)
  return `${minutes}m ${remaining}s`
}
