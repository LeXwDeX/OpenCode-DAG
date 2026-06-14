/**
 * Shared status → icon/color mapping for DAG Workflow TUI.
 *
 * Single source of truth consumed by renderer.tsx / ascii-dag.tsx / sidebar.tsx
 * to avoid drift between three separate maps.
 *
 * Architecture constraints:
 * - Pure functions, no hooks (callers pass theme colors).
 */
import type { DAGNodeStatus, DAGWorkflowStatus } from "@/dag/session/types"
import { GLYPH } from "./glyphs"

/**
 * Subset of theme colors needed for status rendering.
 * Generic over the color value type (RGBA in opentui, string in tests).
 */
export type StatusThemeColors<C = unknown> = {
  success: C
  warning: C
  error: C
  textMuted: C
  /** optional: falls back to `warning` when absent (backward-compatible) */
  recoverable?: C
}

export const NODE_STATUS_ICON: Record<DAGNodeStatus, string> = {
  completed: GLYPH.iconCompleted,
  running: GLYPH.iconRunning,
  queued: GLYPH.iconQueued,
  pending: GLYPH.iconPending,
  failed: GLYPH.iconFailed,
  skipped: GLYPH.iconSkipped,
  recoverable: GLYPH.iconRecoverable,
}

export const WORKFLOW_STATUS_ICON: Record<DAGWorkflowStatus, string> = {
  running: GLYPH.iconRunning,
  completed: GLYPH.iconCompleted,
  failed: GLYPH.iconFailed,
  cancelled: GLYPH.iconSkipped,
  pending: GLYPH.iconPending,
  paused: GLYPH.iconPaused,
}

/** Icon character for a node status (falls back to "?"). */
export function nodeStatusIconChar(status: DAGNodeStatus): string {
  return NODE_STATUS_ICON[status] ?? "?"
}

/** Icon character for a workflow status (falls back to the pending icon). */
export function workflowStatusIconChar(status: DAGWorkflowStatus): string {
  return WORKFLOW_STATUS_ICON[status] ?? GLYPH.iconPending
}

/** Theme color for a node status. */
export function nodeStatusColor<C>(status: DAGNodeStatus, theme: StatusThemeColors<C>): C {
  switch (status) {
    case "completed":
      return theme.success
    case "running":
    case "queued":
    case "recoverable":
      return theme.recoverable ?? theme.warning
    case "failed":
      return theme.error
    case "skipped":
    case "pending":
    default:
      return theme.textMuted
  }
}

/** Theme color for a workflow status. */
export function workflowStatusColor<C>(status: DAGWorkflowStatus, theme: StatusThemeColors<C>): C {
  switch (status) {
    case "running":
      return theme.warning
    case "completed":
      return theme.success
    case "failed":
      return theme.error
    case "cancelled":
    case "pending":
    case "paused":
    default:
      return theme.textMuted
  }
}
