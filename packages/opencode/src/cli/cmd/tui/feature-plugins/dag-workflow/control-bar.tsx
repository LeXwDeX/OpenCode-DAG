/** @jsxImportSource @opentui/solid */
/**
 * ControlBar — TUI component for DAG workflow lifecycle control.
 *
 * Renders [Pause] [Resume] [Cancel] [Replan] buttons gated by the current
 * workflow status, plus the live status text.
 *
 * Pure callback injection (mirrors the original PauseResumeBar):
 * - NO SDK / data.ts wrapper imports here.
 * - Every action emits an intent via `onAction`; the parent (console-route)
 *   owns the dialogs (DialogConfirm / DialogPrompt / DialogSelect) and the
 *   data.ts wrapper calls.
 *
 * Status gating (terminal statuses disable every action — irreversible):
 * - running → [Pause] [Cancel] [Replan]
 * - paused  → [Resume] [Cancel]
 * - pending / completed / failed / cancelled → all disabled
 */

import { createMemo, Show, type JSX } from "solid-js"
import type { DAGWorkflowStatus } from "@/dag/session/types"
import { useTheme } from "@tui/context/theme"
import { t, workflowStatusLabel, type Lang } from "./i18n"

export type ControlAction = "pause" | "resume" | "cancel" | "replan"

export type ControlBarActions = {
  pause: boolean
  resume: boolean
  cancel: boolean
  replan: boolean
}

/**
 * controlBarActions — pure status → enabled-actions map.
 *
 * - running → pause + cancel + replan
 * - paused  → resume + cancel
 * - pending / completed / failed / cancelled → all disabled (terminal is
 *   irreversible; pending has not started yet)
 */
export function controlBarActions(status: DAGWorkflowStatus): ControlBarActions {
  if (status === "running") return { pause: true, resume: false, cancel: true, replan: true }
  if (status === "paused") return { pause: false, resume: true, cancel: true, replan: false }
  return { pause: false, resume: false, cancel: false, replan: false }
}

/**
 * parseReplanConcurrency — pure guard for the replan max-concurrency prompt.
 *
 * Accepts a raw prompt string and returns the parsed integer only when it is a
 * whole number in 1..10; otherwise `{ ok: false }`. Out-of-range and malformed
 * input must be rejected before reaching the data.ts wrapper (replanWorkflow).
 *
 * Note: `Number("")` and `Number("  ")` are `0`, which fails the `< 1` bound.
 */
export function parseReplanConcurrency(input: string): { ok: true; value: number } | { ok: false } {
  const n = Number(input)
  if (!Number.isInteger(n) || n < 1 || n > 10) return { ok: false }
  return { ok: true, value: n }
}

export function ControlBar(props: {
  lang: Lang
  workflowId: string
  currentStatus: () => DAGWorkflowStatus
  onAction: (action: ControlAction) => void
}): JSX.Element {
  const { theme } = useTheme()
  const actions = createMemo(() => controlBarActions(props.currentStatus()))

  return (
    <box flexDirection="row" gap={2} paddingTop={1}>
      <Show when={actions().pause}>
        <text fg={theme.primary} onMouseUp={() => props.onAction("pause")}>
          {t(props.lang, "ctrl_pause")}
        </text>
      </Show>
      <Show when={actions().resume}>
        <text fg={theme.primary} onMouseUp={() => props.onAction("resume")}>
          {t(props.lang, "ctrl_resume")}
        </text>
      </Show>
      <Show when={actions().cancel}>
        <text fg={theme.error} onMouseUp={() => props.onAction("cancel")}>
          {t(props.lang, "ctrl_cancel")}
        </text>
      </Show>
      <Show when={actions().replan}>
        <text fg={theme.text} onMouseUp={() => props.onAction("replan")}>
          {t(props.lang, "ctrl_replan")}
        </text>
      </Show>
      <text fg={theme.textMuted}>status:</text>
      <text fg={props.currentStatus() === "paused" ? theme.primary : theme.text}>
        {workflowStatusLabel(props.lang, props.currentStatus())}
      </text>
    </box>
  )
}
