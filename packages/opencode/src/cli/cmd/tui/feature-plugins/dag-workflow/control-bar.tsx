/** @jsxImportSource @opentui/solid */
/**
 * ControlBar — TUI component for DAG workflow lifecycle control.
 *
 * Renders lifecycle buttons gated by the current workflow status, plus the
 * live status text.
 *
 * Pure callback injection (mirrors the original PauseResumeBar):
 * - NO SDK / data.ts wrapper imports here.
 * - Every action emits an intent via `onAction`; the parent (console-route)
 *   owns the dialogs (DialogConfirm / DialogPrompt / DialogSelect) and the
 *   data.ts wrapper calls.
 *
 * Status gating (terminal statuses disable every action — irreversible):
 * - running → [Pause] [Cancel] [Replan]
 * - paused  → [Resume] [Step] [Cancel]
 * - pending → [Start]
 * - completed / failed / cancelled → all disabled
 */

import { createMemo, Show, type JSX } from "solid-js"
import type { DAGWorkflowStatus } from "@/dag/session/types"
import { useTheme } from "@tui/context/theme"
import { t, workflowStatusLabel, type I18nKey, type Lang } from "./i18n"
import { RGBA } from "@opentui/core"

export type ControlAction = "start" | "pause" | "resume" | "cancel" | "replan" | "step"

export type ControlBarActions = {
  start: boolean
  pause: boolean
  resume: boolean
  cancel: boolean
  replan: boolean
  step: boolean
}

/**
 * controlBarActions — pure status → enabled-actions map.
 *
 * - running → pause + cancel + replan
 * - paused  → resume + step + cancel
 * - pending → start
 * - completed / failed / cancelled → all disabled (terminal is irreversible)
 */
export function controlBarActions(status: DAGWorkflowStatus): ControlBarActions {
  if (status === "running") return { start: false, pause: true, resume: false, cancel: true, replan: true, step: false }
  // P2-B: step is enabled when paused (executes exactly 1 ready node)
  if (status === "paused") return { start: false, pause: false, resume: true, cancel: true, replan: false, step: true }
  return { start: status === "pending", pause: false, resume: false, cancel: false, replan: false, step: false }
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

/**
 * ActionButton — WP4-A: internal helper for the 6 lifecycle buttons.
 * When isDisabled (parent is executing an async action), the button renders dimmed
 * (theme.textMuted) with a " ..." suffix and the onMouseUp handler is suppressed.
 */
function ActionButton(props: {
  when: boolean
  action: ControlAction
  label: I18nKey
  color: RGBA
  lang: Lang
  disabled: () => boolean
  onAction: (a: ControlAction) => void
}): JSX.Element {
  const { theme } = useTheme()
  return (
    <Show when={props.when}>
      <text
        fg={props.disabled() ? theme.textMuted : props.color}
        onMouseUp={() => !props.disabled() && props.onAction(props.action)}
      >
        {t(props.lang, props.label)}{props.disabled() ? " ..." : ""}
      </text>
    </Show>
  )
}

export function ControlBar(props: {
  lang: Lang
  workflowId: string
  currentStatus: () => DAGWorkflowStatus
  onAction: (action: ControlAction) => void
  actionLoading?: () => boolean
}): JSX.Element {
  const { theme } = useTheme()
  const actions = createMemo(() => controlBarActions(props.currentStatus()))
  const isDisabled = () => !!props.actionLoading?.()

  return (
    <box flexDirection="row" gap={2} paddingTop={1}>
      <ActionButton
        when={actions().start}
        action="start"
        label="ctrl_start"
        color={theme.primary}
        lang={props.lang}
        disabled={isDisabled}
        onAction={props.onAction}
      />
      <ActionButton
        when={actions().pause}
        action="pause"
        label="ctrl_pause"
        color={theme.primary}
        lang={props.lang}
        disabled={isDisabled}
        onAction={props.onAction}
      />
      <ActionButton
        when={actions().resume}
        action="resume"
        label="ctrl_resume"
        color={theme.primary}
        lang={props.lang}
        disabled={isDisabled}
        onAction={props.onAction}
      />
      <ActionButton
        when={actions().step}
        action="step"
        label="ctrl_step"
        color={theme.primary}
        lang={props.lang}
        disabled={isDisabled}
        onAction={props.onAction}
      />
      <ActionButton
        when={actions().cancel}
        action="cancel"
        label="ctrl_cancel"
        color={theme.error}
        lang={props.lang}
        disabled={isDisabled}
        onAction={props.onAction}
      />
      <ActionButton
        when={actions().replan}
        action="replan"
        label="ctrl_replan"
        color={theme.text}
        lang={props.lang}
        disabled={isDisabled}
        onAction={props.onAction}
      />
      <text fg={theme.textMuted}>status:</text>
      <text fg={props.currentStatus() === "paused" ? theme.primary : theme.text}>
        {workflowStatusLabel(props.lang, props.currentStatus())}
      </text>
    </box>
  )
}
