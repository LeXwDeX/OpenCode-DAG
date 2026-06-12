/** @jsxImportSource @opentui/solid */
import { For, Show, type JSX } from "solid-js"
import type { WorkflowHistory } from "./data"
import { useTheme } from "@tui/context/theme"
import { GLYPH } from "./glyphs"
import type { Lang } from "./i18n"
import { t } from "./i18n"

export function WorkflowHistoryPanel(props: {
  lang: Lang
  history: WorkflowHistory[]
  error?: string | null
  loading?: boolean
}): JSX.Element {
  const { theme } = useTheme()
  return (
    <box gap={1}>
      <text fg={theme.text}><b>{t(props.lang, "title_workflow_history")}</b></text>
      <Show when={!props.error} fallback={<text fg={theme.error}>{t(props.lang, "label_load_error")}: {props.error}</text>}>
        <Show
          when={props.history.length > 0}
          fallback={<text fg={theme.textMuted}>{props.loading ? t(props.lang, "label_loading") : t(props.lang, "history_empty")}</text>}
        >
          <For each={props.history}>
            {(row) => (
              <box gap={0}>
                <text fg={theme.text}>{row.action} <span style={{ fg: theme.textMuted }}>by {row.changed_by ?? "-"}</span></text>
                <text fg={theme.textMuted}>{formatHistoryTime(row.created_at)}</text>
                <text fg={theme.textMuted} wrapMode="word">{formatHistoryDetails(row.change_details)}</text>
              </box>
            )}
          </For>
        </Show>
      </Show>
    </box>
  )
}

export function formatHistoryTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "-"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "-" : date.toISOString()
}

export function formatHistoryDetails(value: unknown): string {
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
