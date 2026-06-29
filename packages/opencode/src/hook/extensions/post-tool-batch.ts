/**
 * [FORK:hook-ext] Batch tool completion tracking — not in upstream
 *
 * Tracks tool executions within a single LLM step and provides
 * batch-level visibility via ForkHooks.afterRunEntry.
 *
 * Architecture:
 * - The AI SDK executes tools concurrently within a single step
 * - Each tool fires PostToolUse individually through settings.ts trigger()
 * - This module counts PostToolUse events and exposes the batch state
 *
 * NOTE: This does NOT fire a synthetic "PostToolBatch" event (that would
 * require knowing when the batch ends, which the AI SDK doesn't expose).
 * Instead, it provides a queryable state that other fork extensions can
 * inspect.
 *
 * Future: If the AI SDK adds a "step complete" callback, we can fire
 * a real PostToolBatch event at that point.
 */

import type { HookCommand, HookEvent, HookJSONOutput } from "../settings"

export interface BatchEntry {
  toolName: string
  success: boolean
  exitBlock?: string
}

const batches = new Map<string, BatchEntry[]>()

/**
 * Record a tool execution for batch tracking.
 * Called from ForkHooks.afterRunEntry for PostToolUse events.
 */
export function recordToolExecution(
  sessionID: string,
  _entry: HookCommand,
  envelope: Record<string, unknown>,
  event: HookEvent,
  result: { json?: HookJSONOutput; exitBlock?: string },
): void {
  if (event !== "PostToolUse") return

  const toolName = (envelope.tool_name as string) ?? "unknown"
  const batch = batches.get(sessionID) ?? []
  batch.push({
    toolName,
    success: !result.exitBlock && result.json?.decision !== "block",
    exitBlock: result.exitBlock,
  })
  batches.set(sessionID, batch)
}

/**
 * Get the current batch state for a session.
 * Returns readonly array of tool executions since last reset.
 */
export function getBatch(sessionID: string): readonly BatchEntry[] {
  return batches.get(sessionID) ?? []
}

/**
 * Reset batch state for a session.
 * Call at step boundary (e.g., after LLM response is complete).
 */
export function resetBatch(sessionID: string): void {
  batches.delete(sessionID)
}

/**
 * Get batch count for a session.
 */
export function getBatchCount(sessionID: string): number {
  return batches.get(sessionID)?.length ?? 0
}
