/** @jsxImportSource @opentui/solid */
import { For, Show, type JSX } from "solid-js"
import type { NodeLog } from "./data"
import { useTheme } from "@tui/context/theme"
import { GLYPH } from "./glyphs"
import type { Lang } from "./i18n"
import { t } from "./i18n"

export function NodeLogsPanel(props: {
  lang: Lang
  logs: NodeLog[]
  error?: string | null
  loading?: boolean
}): JSX.Element {
  const { theme } = useTheme()
  return (
    <box gap={1}>
      <text fg={theme.text}><b>{t(props.lang, "title_node_logs")}</b></text>
      <Show when={!props.error} fallback={<text fg={theme.error}>{t(props.lang, "label_load_error")}: {props.error}</text>}>
        <Show
          when={props.logs.length > 0}
          fallback={<text fg={theme.textMuted}>{props.loading ? t(props.lang, "label_loading") : t(props.lang, "node_logs_empty")}</text>}
        >
          <For each={props.logs}>
            {(row) => (
              <box gap={0}>
                <text fg={theme.text}>[{row.log_level}] {row.execution_phase ?? "-"}</text>
                <text fg={theme.textMuted}>{formatLogTime(row.created_at)}</text>
                <text fg={theme.textMuted} wrapMode="word">{formatLogDetails(row.log_message, row.log_data)}</text>
              </box>
            )}
          </For>
        </Show>
      </Show>
    </box>
  )
}

export function formatLogTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "-"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "-" : date.toISOString()
}

export function formatLogDetails(message: string, data: unknown): string {
  const details = data === null || data === undefined ? message : `${message} ${stringifyUnknown(data)}`
  return truncateText(details)
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
