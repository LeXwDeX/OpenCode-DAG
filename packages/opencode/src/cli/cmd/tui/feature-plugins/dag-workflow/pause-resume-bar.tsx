/** @jsxImportSource @opentui/solid */
/**
 * PauseResumeBar — TUI component for DAG workflow pause/resume control.
 *
 * Renders [Pause] [Resume] buttons and current workflow status.
 * The parent wires up the HTTP calls (POST /dag/workflows/:workflowId/pause or /resume).
 * Listens for dag.workflow.updated events to keep status in sync.
 */

import { createMemo, type JSX } from "solid-js"
import type { DAGWorkflowStatus } from "@/dag/session/types"
import { useTheme } from "@tui/context/theme"

export function PauseResumeBar(props: {
  workflowId: string
  currentStatus: () => DAGWorkflowStatus
  onAction: (action: "pause" | "resume") => void
}): JSX.Element {
  const { theme } = useTheme()

  const isRunning = createMemo(() => props.currentStatus() === "running")
  const isPaused = createMemo(() => props.currentStatus() === "paused")

  return (
    <box flexDirection="row" gap={2} paddingTop={1}>
      <text
        fg={isPaused() ? theme.textMuted : theme.primary}
        onMouseUp={() => {
          if (isRunning()) props.onAction("pause")
        }}
      >
        [Pause]
      </text>
      <text
        fg={isPaused() ? theme.primary : theme.textMuted}
        onMouseUp={() => {
          if (isPaused()) props.onAction("resume")
        }}
      >
        [Resume]
      </text>
      <text fg={theme.textMuted}>status:</text>
      <text fg={isPaused() ? theme.primary : theme.text}>
        {props.currentStatus()}
      </text>
    </box>
  )
}
