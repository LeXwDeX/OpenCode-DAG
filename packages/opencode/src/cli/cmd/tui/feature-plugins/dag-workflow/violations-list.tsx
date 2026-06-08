/** @jsxImportSource @opentui/solid */
/**
 * Violations List — standalone list of DAG violations
 *
 * Mirrors history-panel.tsx structure.
 * Renders violations from useViolations hook, view-agnostic
 * (displayed in middle panel regardless of tree/ascii-dag view mode).
 *
 * Architecture constraints:
 * - ReadOnly: receives data via props, no direct store calls
 * - Severity colors map to theme.error / theme.warning / theme.info
 */
import { For, Show, type JSX } from "solid-js"
import type { DAGViolation } from "@/dag/session/types"
import { useTheme } from "@tui/context/theme"
import type { Lang } from "./i18n"
import { t, violationSeverityLabel, violationTypeLabel } from "./i18n"

export function ViolationsList(props: {
  lang: Lang
  violations: DAGViolation[]
}): JSX.Element {
  const { theme } = useTheme()
  return (
    <box gap={1}>
      <text fg={theme.text}>
        <b>{t(props.lang, "label_violations")}</b>
      </text>
      <Show
        when={props.violations.length > 0}
        fallback={<text fg={theme.textMuted}>{t(props.lang, "label_no_violations")}</text>}
      >
        <For each={props.violations}>
          {(v) => (
            <box flexDirection="row" gap={1} paddingLeft={1}>
              <text fg={theme.error}>{"\u26a0"}</text>
              <text fg={severityColor(v.severity, theme)}>
                [{violationSeverityLabel(props.lang, v.severity)}]
              </text>
              <text fg={theme.text}>{violationTypeLabel(props.lang, v.type)}:</text>
              <text fg={theme.textMuted}>{v.message}</text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

function severityColor(
  severity: DAGViolation["severity"],
  theme: ReturnType<typeof useTheme>["theme"],
) {
  if (severity === "error" || severity === "critical") return theme.error
  if (severity === "warning") return theme.warning
  return theme.info
}
