/** Pure topology helpers for the DAG inspector. Extracted for unit testing,
 * mirroring the diff-viewer-file-tree-utils pattern in this directory. */

import type { DagNode } from "@opencode-ai/sdk/v2"

export type { DagNode }

/**
 * Group nodes into topological "waves": wave N contains every node whose
 * dependencies are all satisfied by waves 0..N-1. A wave is a rendering
 * grouping (same topological depth), NOT an execution barrier.
 *
 * Nodes inside a wave are sorted by name for stable rendering. Nodes that are
 * part of a dependency cycle (or depend on a missing node) can never be
 * satisfied and are dropped — the loop stops at the first empty wave rather
 * than spinning forever.
 */
export function computeWaves(nodes: readonly DagNode[]): DagNode[][] {
  if (nodes.length === 0) return []
  const done = new Set<string>()
  const remaining = new Set(nodes.map((n) => n.id))
  const deps = new Map(nodes.map((n) => [n.id, n.depends_on]))
  const byID = new Map(nodes.map((n) => [n.id, n]))
  const result: DagNode[][] = []
  while (remaining.size > 0) {
    const wave: DagNode[] = []
    for (const id of remaining) {
      const d = deps.get(id) ?? []
      if (d.every((dep) => done.has(dep) || !byID.has(dep))) {
        const node = byID.get(id)
        if (node) wave.push(node)
      }
    }
    if (wave.length === 0) break
    wave.sort((a, b) => a.name.localeCompare(b.name))
    result.push(wave)
    for (const n of wave) {
      done.add(n.id)
      remaining.delete(n.id)
    }
  }
  return result
}

export function formatDagError(error: string) {
  return error
    .replace(/^Cause\(\[Die\((.*)\)\]\)$/, "$1")
    .replace(/^ProviderModelNotFoundError:\s*/, "")
}

export type DagControlOperation = "pause" | "resume" | "cancel"

export function dagControlUnavailableMessage(status: string | undefined, operation: DagControlOperation) {
  const allowed =
    operation === "pause"
      ? status === "running" || status === "stepping"
      : operation === "resume"
        ? status === "paused" || status === "stepping"
        : status === "running" || status === "stepping" || status === "paused"
  if (allowed) return undefined
  const action = operation === "pause" ? "paused" : operation === "resume" ? "resumed" : "cancelled"
  return `Workflow is ${status ?? "unavailable"} and cannot be ${action}`
}

export function dagControlProgressMessage(operation: DagControlOperation) {
  if (operation === "pause") return "Pausing workflow..."
  if (operation === "resume") return "Resuming workflow..."
  return "Cancelling workflow..."
}
