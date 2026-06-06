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

/**
 * Subset of theme colors needed for status rendering.
 * Generic over the color value type (RGBA in opentui, string in tests).
 */
export type StatusThemeColors<C = unknown> = {
  success: C
  warning: C
  error: C
  textMuted: C
}

export const NODE_STATUS_ICON: Record<DAGNodeStatus, string> = {
  completed: "\u2713", // ✓
  running: "\u25cf", // ●
  queued: "\u25ce", // ◎
  pending: "\u25cb", // ○
  failed: "\u2717", // ✗
  skipped: "\u2298", // ⊘
}

export const WORKFLOW_STATUS_ICON: Record<DAGWorkflowStatus, string> = {
  running: "\u25cf", // ●
  completed: "\u2713", // ✓
  failed: "\u2717", // ✗
  cancelled: "\u2298", // ⊘
  pending: "\u25cb", // ○
}

/** Icon character for a node status (falls back to "?"). */
export function nodeStatusIconChar(status: DAGNodeStatus): string {
  return NODE_STATUS_ICON[status] ?? "?"
}

/** Icon character for a workflow status (falls back to ○). */
export function workflowStatusIconChar(status: DAGWorkflowStatus): string {
  return WORKFLOW_STATUS_ICON[status] ?? "\u25cb"
}

/** Theme color for a node status. */
export function nodeStatusColor<C>(status: DAGNodeStatus, theme: StatusThemeColors<C>): C {
  switch (status) {
    case "completed":
      return theme.success
    case "running":
    case "queued":
      return theme.warning
    case "failed":
    case "skipped":
      return theme.error
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
    default:
      return theme.textMuted
  }
}
