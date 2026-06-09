// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * DAG Execution Core — A Layer (Pure Algorithmic Logic)
 *
 * This module contains ALL pure, deterministic functions extracted from
 * workflow-engine.ts and session-service.ts. It has ZERO runtime imports
 * from Effect, DB, or logger — only `import type` for structural types.
 *
 * Design contract:
 * - Every exported function is pure (deterministic, no side effects)
 * - Only `import type` from sibling modules (no runtime dependencies)
 * - Independently testable without DB, Effect runtime, or DI
 *
 * Consumers:
 * - workflow-engine.ts (B layer) imports + re-exports for backward compat
 * - session-service.ts (B layer) imports + re-exports for backward compat
 */

import type {
  DAGNodeConfig,
  DAGNodeSession,
  DAGNodeStatus,
  DAGWorkflowStatus,
  ReplanPatch,
} from "./types"
import type {
  CreateNodeInput,
  UpdateNodeConfigInput,
} from "./session-service"

// ============================================================================
// Replan Result Types
// ============================================================================

export type ReplanValidateResult =
  | { ok: true }
  | { ok: false; reason: string; detail?: unknown }

export type ApplyReplanResult =
  | { ok: true; newConfigNodes: DAGNodeConfig[] }
  | { ok: false; reason: string; detail?: unknown }

export type ReplanDbInputs = {
  removeNodeIds: string[]
  updates: UpdateNodeConfigInput[]
  newNodes: CreateNodeInput[]
  newMaxConcurrency: number
}

// ============================================================================
// 1. Dependency & Readiness (extracted from workflow-engine.ts closure)
// ============================================================================

/**
 * Check whether all dependencies of a node are in the completed set.
 * Pure function — no DB, no Effect.
 */
export function areDependenciesSatisfied(
  node: DAGNodeSession,
  completedNodeIds: Set<string>,
): boolean {
  if (!node.dependencies || node.dependencies.length === 0) return true
  return node.dependencies.every((depId: string) => completedNodeIds.has(depId))
}

/**
 * Return all nodes that are ready to execute: dependencies satisfied,
 * not running/completed/failed.
 * Pure function — no DB, no Effect.
 */
export function getReadyNodes(
  nodes: DAGNodeSession[],
  completedNodeIds: Set<string>,
  failedNodeIds: Set<string>,
  runningNodeIds: Set<string>,
): DAGNodeSession[] {
  return nodes.filter(node => {
    const isNotRunning = !runningNodeIds.has(node.node_id)
    const isNotCompleted = !completedNodeIds.has(node.node_id)
    const isNotFailed = !failedNodeIds.has(node.node_id)
    const depsSatisfied = areDependenciesSatisfied(node, completedNodeIds)
    return isNotRunning && isNotCompleted && isNotFailed && depsSatisfied
  })
}

// ============================================================================
// 2. Workflow Terminal Convergence (extracted from maybeFinalizeWorkflow)
// ============================================================================

/**
 * Compute the target workflow status from the current node states.
 * Returns null if the workflow should NOT converge yet (in-progress nodes exist).
 *
 * Decision logic:
 * - If any node is pending/queued/running → null (not ready)
 * - If any required node failed → 'failed'
 * - Otherwise → 'completed'
 */
export function computeFinalWorkflowStatus(
  allNodes: DAGNodeSession[],
): DAGWorkflowStatus | null {
  const hasInProgress = allNodes.some((n: DAGNodeSession) =>
    n.status === 'pending' || n.status === 'queued' || n.status === 'running'
  )
  if (hasInProgress) return null

  const hasRequiredFailed = allNodes.some((n: DAGNodeSession) =>
    n.config.required === true && n.status === 'failed'
  )
  return hasRequiredFailed ? 'failed' : 'completed'
}

// ============================================================================
// 3. Concurrency Budget (extracted from scheduleReadyNodes)
// ============================================================================

/**
 * Compute the spawn budget: how many more nodes can be spawned.
 * Pure arithmetic — no registry access.
 */
export function computeSpawnBudget(
  maxConcurrency: number,
  runningCount: number,
  inFlightCount: number,
): number {
  return maxConcurrency - runningCount - inFlightCount
}

// ============================================================================
// 4. Graph Analysis
// ============================================================================

/**
 * Inline cycle detector over a list of node configs (DFS-based).
 * Returns true when ANY cycle exists in the `dependencies[]` graph.
 */
export function detectCycle(nodes: DAGNodeConfig[]): boolean {
  const graph = new Map<string, string[]>()
  for (const n of nodes) graph.set(n.id, n.dependencies)
  const visited = new Set<string>()
  const inStack = new Set<string>()
  const dfs = (id: string): boolean => {
    if (inStack.has(id)) return true
    if (visited.has(id)) return false
    visited.add(id)
    inStack.add(id)
    for (const dep of graph.get(id) ?? []) if (dfs(dep)) return true
    inStack.delete(id)
    return false
  }
  for (const id of graph.keys()) if (dfs(id)) return true
  return false
}

/**
 * From failedNodeId, BFS along reverse-dependency edges, collecting all
 * reachable nodes whose status === 'pending'. Used for cascade skip.
 */
export function findPendingDescendants(
  allNodes: DAGNodeSession[],
  failedNodeId: string,
): DAGNodeSession[] {
  const reverseGraph = new Map<string, string[]>()
  for (const n of allNodes) {
    for (const dep of n.dependencies ?? []) {
      const existing = reverseGraph.get(dep)
      if (existing) existing.push(n.node_id)
      else reverseGraph.set(dep, [n.node_id])
    }
  }
  const pendingMap = new Map<string, DAGNodeSession>()
  for (const n of allNodes) {
    if (n.status === 'pending') pendingMap.set(n.node_id, n)
  }
  const result: DAGNodeSession[] = []
  const seen = new Set<string>([failedNodeId])
  const queue: string[] = [failedNodeId]
  while (queue.length > 0) {
    const cur = queue.shift()!
    const downstream = reverseGraph.get(cur) ?? []
    for (const dId of downstream) {
      if (seen.has(dId)) continue
      seen.add(dId)
      const pendingNode = pendingMap.get(dId)
      if (pendingNode) {
        result.push(pendingNode)
        queue.push(dId)
      }
    }
  }
  return result
}

// ============================================================================
// 5. Replan Pure Helpers
// ============================================================================

/**
 * Validates that a replan can proceed: rejects terminal workflows and empty patches.
 */
export function validateReplanPreconditions(
  workflow: { status: DAGWorkflowStatus },
  patch: ReplanPatch,
): ReplanValidateResult {
  const terminalStatuses: DAGWorkflowStatus[] = ['completed', 'failed', 'cancelled']
  if (terminalStatuses.includes(workflow.status)) {
    return { ok: false, reason: `Cannot replan a terminal workflow (${workflow.status})` }
  }
  const isEmpty =
    !(patch.add_nodes?.length) &&
    !(patch.remove_nodes?.length) &&
    !(patch.update_nodes?.length) &&
    patch.new_max_concurrency === undefined
  if (isEmpty) {
    return { ok: false, reason: `Empty patch: nothing to do` }
  }
  return { ok: true }
}

/**
 * Partitions current nodes into frozen (queued/running/completed/failed/skipped) and
 * mutable (pending) sets. Frozen nodes cannot be removed or updated by a replan patch.
 */
export function classifyReplanNodes(currentNodes: DAGNodeSession[]): {
  frozen: DAGNodeSession[]
  mutable: DAGNodeSession[]
  frozenIds: Set<string>
} {
  const frozenNodeStatuses: DAGNodeStatus[] = ['queued', 'running', 'completed', 'failed', 'skipped']
  const frozenStatusSet = new Set<DAGNodeStatus>(frozenNodeStatuses)
  const frozen = currentNodes.filter((n: DAGNodeSession) => frozenStatusSet.has(n.status))
  const mutable = currentNodes.filter((n: DAGNodeSession) => n.status === 'pending')
  const frozenIds = new Set(frozen.map((n: DAGNodeSession) => n.node_id))
  return { frozen, mutable, frozenIds }
}

/**
 * Rejects patch ops that touch frozen nodes or reference non-existent node IDs.
 */
export function validateFrozenAndExistence(
  patch: ReplanPatch,
  frozenIds: Set<string>,
  currentNodeIds: Set<string>,
): ReplanValidateResult {
  const touchFrozenRemove = (patch.remove_nodes ?? []).filter(id => frozenIds.has(id))
  if (touchFrozenRemove.length > 0) {
    return { ok: false, reason: `Cannot remove frozen nodes: ${touchFrozenRemove.join(', ')}` }
  }
  const touchFrozenUpdate = (patch.update_nodes ?? []).filter(u => frozenIds.has(u.node_id))
  if (touchFrozenUpdate.length > 0) {
    return { ok: false, reason: `Cannot update frozen nodes: ${touchFrozenUpdate.map(u => u.node_id).join(', ')}` }
  }
  const unknownRemoves = (patch.remove_nodes ?? []).filter(id => !currentNodeIds.has(id))
  if (unknownRemoves.length > 0) {
    return { ok: false, reason: `remove_nodes references unknown ids: ${unknownRemoves.join(', ')}` }
  }
  const unknownUpdates = (patch.update_nodes ?? []).filter(u => !currentNodeIds.has(u.node_id))
  if (unknownUpdates.length > 0) {
    return { ok: false, reason: `update_nodes references unknown ids: ${unknownUpdates.map(u => u.node_id).join(', ')}` }
  }
  return { ok: true }
}

/**
 * Builds the proposed new config node list from the patch (in-memory, before any DB writes).
 */
export function applyReplanPatchToConfig(
  workflowId: string,
  currentConfigNodes: DAGNodeConfig[],
  patch: ReplanPatch,
): ApplyReplanResult {
  let newConfigNodes: DAGNodeConfig[] = currentConfigNodes.map(n => ({ ...n }))
  // remove: strip by configId (reverse namespace lookup)
  const removeCfgIds = new Set((patch.remove_nodes ?? []).map(ns => ns.split('::').slice(1).join('::')))
  newConfigNodes = newConfigNodes.filter(n => !removeCfgIds.has(n.id))
  // update: apply patches
  for (const upd of patch.update_nodes ?? []) {
    const cfgId = upd.node_id.split('::').slice(1).join('::')
    const idx = newConfigNodes.findIndex(n => n.id === cfgId)
    if (idx < 0) {
      return { ok: false, reason: `update_nodes references unknown node: ${upd.node_id}` }
    }
    if (upd.new_config) {
      newConfigNodes[idx] = {
        ...newConfigNodes[idx],
        ...upd.new_config,
        id: cfgId,
        dependencies: upd.new_dependencies ?? newConfigNodes[idx].dependencies,
      }
    } else if (upd.new_dependencies) {
      newConfigNodes[idx] = { ...newConfigNodes[idx], dependencies: upd.new_dependencies }
    }
  }
  // add: append new nodes (cfg.id stays un-namespaced in config)
  for (const added of patch.add_nodes ?? []) newConfigNodes.push(added)
  return { ok: true, newConfigNodes }
}

/**
 * Builds DB-ready inputs from the validated patch.
 */
export function buildReplanDbInputs(
  workflowId: string,
  patch: ReplanPatch,
  newConfigNodes: DAGNodeConfig[],
  currentNodes: DAGNodeSession[],
  currentMaxConcurrency: number,
): ReplanDbInputs {
  const wfNs = (cfgId: string) => `${workflowId}::${cfgId}`
  const updates: UpdateNodeConfigInput[] = (patch.update_nodes ?? []).map(u => {
    const cfgId = u.node_id.split('::').slice(1).join('::')
    const updatedCfg = newConfigNodes.find(n => n.id === cfgId)!
    // Namespace new_dependencies if provided; fall back to the node's
    // EXISTING stored (already-namespaced) dependencies when absent.
    const existing = currentNodes.find(n => n.node_id === u.node_id)
    const depsToWrite = u.new_dependencies
      ? u.new_dependencies.map(d => wfNs(d))
      : existing?.dependencies ?? []
    return { nodeId: u.node_id, newConfig: updatedCfg, newDependencies: depsToWrite }
  })
  const newNodes: CreateNodeInput[] = (patch.add_nodes ?? []).map(a => ({
    workflowId,
    nodeId: wfNs(a.id),
    name: a.name,
    nodeName: a.name,
    nodeType: a.worker_type,
    config: a,
    dependencyNodes: a.dependencies.map(d => wfNs(d)),
    timeoutMs: a.timeout_ms,
    maxRetries: a.retry?.max_attempts ?? 0,
  }))
  const newMaxConcurrency = patch.new_max_concurrency ?? currentMaxConcurrency
  return {
    removeNodeIds: patch.remove_nodes ?? [],
    updates,
    newNodes,
    newMaxConcurrency,
  }
}

// ============================================================================
// 6. State Transition Tables (extracted from session-service.ts)
// ============================================================================

/**
 * Session-layer valid next workflow statuses (Iron Law #1/#2).
 * Terminal states: completed, failed, cancelled — no outgoing transitions.
 */
export function getValidNextSessionWorkflowStatuses(
  currentStatus: DAGWorkflowStatus,
): DAGWorkflowStatus[] {
  switch (currentStatus) {
    case "pending":
      return ["running", "failed", "cancelled"]
    case "running":
      return ["completed", "failed", "cancelled", "paused"]
    case "paused":
      return ["running", "cancelled"]
    case "completed":
    case "failed":
    case "cancelled":
      return []
    default:
      return []
  }
}

/**
 * Session-layer valid next node statuses (Iron Law #1/#2).
 * Terminal states: completed, failed, skipped — no outgoing transitions.
 */
export function getValidNextSessionNodeStatuses(
  currentStatus: DAGNodeStatus,
): DAGNodeStatus[] {
  switch (currentStatus) {
    case "pending":
      return ["queued", "running", "skipped"]
    case "queued":
      return ["running", "skipped"]
    case "running":
      return ["completed", "failed", "pending"]
    case "completed":
    case "failed":
    case "skipped":
      return []
    default:
      return []
  }
}
