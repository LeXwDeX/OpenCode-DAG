// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

import { Cause, Effect, Result } from "effect"
import { DAGSessionService, emitWorkflowReplannedEvent } from "./session-service"
import type {
  AppendNodeLogInput,
  CreateNodeInput,
  UpdateNodeConfigInput,
  UpdateNodeStatusInput,
} from "./session-service"
import { validateWorkflowConfigLimits } from "./limits"
import { ViolationQueryAPI } from "./violation-query"
import { RequiredNodesValidator } from "./required-nodes-validator"
import type {
  DAGConfig,
  DAGNodeConfig,
  DAGNodeSession,
  DAGNodeStatus,
  DAGViolation,
  DAGViolationType,
  DAGWorkflowStatus,
  ReplanPatch,
  ReplanResult,
} from "./types"
import type { PromptOps } from "@/session/prompt-ops"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { WorktreeManagerTag } from "../layer"
import type { IWorktreeManager } from "../worktree-manager/IWorktreeManager"
import type { WorktreeInfo } from "../worktree-manager/types"

/**
 * Dual-Path Architecture
 *
 * The DAG module uses an explicit "Core vs Session" dual-path design
 * (documented in ARCHITECTURE.md §8).
 *
 * This file (`workflow-engine.ts`) is the **Session path** — the current
 * production runtime that orchestrates DAG execution via the SQLite-backed
 * `DAGSessionService`.
 *
 * The **Core path** (`state-machine/`, `scheduler/`, `group-manager/`) is
 * deliberately isolated from this file. It is NOT dead code; it serves as a
 * capability reservoir for future integration (shadow execution, tool path,
 * dry-run, richer transitions like FAILED→RUNNING retry).
 *
 * Integration between the two paths is intentionally avoided to preserve
 * testability of each independently (see ARCHITECTURE.md:281-282, decision D-PLAN).
 *
 * If you find yourself tempted to call `NodeStateMachine`, `Scheduler`, or
 * `GroupManager` from here — STOP. That breaks the dual-path design.
 * File a design review first.
 */

/**
 * Workflow Status 快照接口
 * 
 * 命名为 Snapshot 以避免与 state-machine/types.ts 的 enum WorkflowStatus 冲突
 */
export interface WorkflowStatusSnapshot {
  workflowId: string
  status: DAGWorkflowStatus
  totalNodes: number
  completedNodes: number
  failedNodes: number
  runningNodes: number
  readyNodes: number
  violations: DAGViolation[]
  violations_count: number
  timestamp: number
}

/**
 * DAG 工作流引擎接口
 */
export interface WorkflowEngine {
  startWorkflow(workflowId: string, config: DAGConfig): Effect.Effect<unknown>
  scheduleReadyNodes(workflowId: string): Effect.Effect<unknown>
  handleNodeCompletion(workflowId: string, nodeId: string, output: unknown): Effect.Effect<unknown>
  handleNodeFailure(workflowId: string, nodeId: string, error: Error): Effect.Effect<unknown>
  cancelWorkflow(workflowId: string): Effect.Effect<unknown>
  getWorkflowStatus(workflowId: string): Effect.Effect<WorkflowStatusSnapshot>
  replanWorkflow(workflowId: string, patch: ReplanPatch): Effect.Effect<ReplanResult>
  pauseWorkflow(workflowId: string): Effect.Effect<DAGWorkflowStatus, never>
  resumeWorkflow(workflowId: string): Effect.Effect<DAGWorkflowStatus, never>
}

// ============================================================================
// Module-Level Engine Registry (mirrors session-service.ts:26 _eventBus pattern)
// Enables static WorkflowEngine.get() lookups from tool layer without Effect context
//
// Concurrency Model:
// - engineRegistry / spawnedNodes / concurrencyRegistry / replanInFlight rely
//   on Bun's single-threaded event loop for atomicity of read-modify-write sequences.
// - No explicit mutex or lock protects these module-level structures.
// - DO NOT port to multi-thread runtimes (Node.js worker_threads, Deno workers,
//   or any environment with shared-memory threads) without introducing
//   Effect.Ref / AsyncLocalStorage / OS-level mutex for each registry mutation.
// - Within Bun's cooperative scheduler, all Effect.sync / Effect.promise blocks
//   are serialized between await points — this is the implicit correctness guarantee.
// ============================================================================

const engineRegistry = new Map<string, WorkflowEngine>()
const spawnedNodes = new Set<string>()
const concurrencyRegistry = new Map<string, number>()
const replanInFlight = new Set<string>()

// ============================================================================
// Replan Pure Helpers (exported for unit testing — no Effect dependencies)
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
 * - Strips removed nodes by configId (reverse namespace lookup).
 * - Applies update patches (new_config shallow merge, new_dependencies override).
 * - Appends added nodes.
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

// Re-export for backward compatibility: all existing `from "./workflow-engine"` imports
// of validateWorkflowConfigLimits (including test files) continue to work unchanged.
// Canonical implementation lives in ./limits.ts (breaks session-service↔workflow-engine cycle).
export { validateWorkflowConfigLimits } from "./limits"

/**
 * Validates the post-patch config: node cap (20), concurrency range (1..10),
 * dependency resolution, required-node integrity, and cycle absence.
 */
export function validateReplanPostConfig(
  newConfigNodes: DAGNodeConfig[],
  patch: ReplanPatch,
  workflow: { config: DAGConfig },
): ReplanValidateResult {
  const newMaxConcurrency = patch.new_max_concurrency ?? workflow.config.max_concurrency
  const limits = validateWorkflowConfigLimits({ nodes: newConfigNodes, max_concurrency: newMaxConcurrency })
  if (!limits.ok) {
    return { ok: false, reason: limits.reason }
  }
  const cfgIdSet = new Set(newConfigNodes.map(n => n.id))
  for (const n of newConfigNodes) {
    for (const dep of n.dependencies) {
      if (!cfgIdSet.has(dep)) {
        return { ok: false, reason: `unresolved dependency: node '${n.id}' references '${dep}'` }
      }
    }
  }
  const requiredValidator = new RequiredNodesValidator()
  const { valid, errors } = requiredValidator.validate({ ...workflow.config, nodes: newConfigNodes })
  if (!valid) {
    return { ok: false, reason: `Validation errors:\n${errors.join('\n')}` }
  }
  // Reject removals of required nodes
  const removeCfgIds = new Set((patch.remove_nodes ?? []).map(ns => ns.split('::').slice(1).join('::')))
  const removedRequireds = workflow.config.nodes
    .filter(n => n.required && removeCfgIds.has(n.id))
    .map(n => n.id)
  if (removedRequireds.length > 0) {
    return { ok: false, reason: `Cannot remove required nodes: ${removedRequireds.join(', ')}` }
  }
  // Cycle check
  if (detectCycle(newConfigNodes)) {
    return { ok: false, reason: `patch introduces a cycle` }
  }
  return { ok: true }
}

/**
 * Builds DB-ready inputs from the validated patch. Namespaces all dependency references
 * and produces the UpdateNodeConfigInput[] and CreateNodeInput[] arrays consumed by
 * sessionService.atomicReplan.
 *
 * `currentMaxConcurrency` is required because `newMaxConcurrency = patch.new_max_concurrency ?? currentMaxConcurrency`.
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

/**
 * Inline cycle detector over a list of node configs (DFS-based).
 * Returns true when ANY cycle exists in the `dependencies[]` graph.
 *
 * @internal test-only — exported for unit tests to exercise validateReplanPostConfig's
 * cycle-detection path directly. Production callers should use WorkflowEngine.replanWorkflow.
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
 * 纯函数：从 failedNodeId 出发，沿 dependencies 反向图 BFS，收集所有 status === 'pending'
 * 的可达下游节点（被失败阻塞的节点）。用于 handleNodeFailure 中级联 skip。
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

export function registerEngine(workflowId: string, engine: WorkflowEngine): void {
  engineRegistry.set(workflowId, engine)
}

export function unregisterEngine(workflowId: string): void {
  engineRegistry.delete(workflowId)
  concurrencyRegistry.delete(workflowId)
  for (const k of Array.from(spawnedNodes)) {
    if (k.startsWith(`${workflowId}::`)) spawnedNodes.delete(k)
  }
}

/** @internal test-only — exposes module-private spawnedNodes set for unit testing */
export const __internal_spawnedNodes = (): Set<string> => spawnedNodes
/** @internal test-only — exposes module-private replanInFlight set for unit testing */
export const __internal_replanInFlight = (): Set<string> => replanInFlight
/** @internal test-only — exposes module-private concurrencyRegistry map for unit testing */
export const __internal_concurrencyRegistry = (): Map<string, number> => concurrencyRegistry

const make = Effect.gen(function* () {
  const dagSessionService = yield* DAGSessionService.make
  const sessionService = dagSessionService
  const violationAPI = new ViolationQueryAPI(sessionService)

  // §10.e: non-interrupting log helper for node lifecycle events.
  // appendNodeLog failures are swallowed so they never break node execution.
  const safeAppendLog = (input: AppendNodeLogInput): Effect.Effect<void, never, never> =>
    sessionService.appendNodeLog(input).pipe(Effect.catchCause(() => Effect.void))

  let _promptOps: PromptOps | undefined

  const setPromptOps = (ops: PromptOps) => {
    _promptOps = ops
  }

  // ============================================================================
  // 辅助函数
  // ============================================================================

  /**
   * 检查节点的所有依赖是否已完成
   */
  const areDependenciesSatisfied = (node: DAGNodeSession, completedNodeIds: Set<string>): boolean => {
    if (!node.dependencies || node.dependencies.length === 0) {
      return true
    }
    return node.dependencies.every((depId: string) => completedNodeIds.has(depId))
  }

  /**
   * 获取所有就绪的节点（依赖已满足且尚未执行）
   */
  const getReadyNodes = (
    nodes: DAGNodeSession[],
    completedNodeIds: Set<string>,
    failedNodeIds: Set<string>,
    runningNodeIds: Set<string>
  ): DAGNodeSession[] => {
    return nodes.filter(node => {
      const isNotRunning = !runningNodeIds.has(node.node_id)
      const isNotCompleted = !completedNodeIds.has(node.node_id)
      const isNotFailed = !failedNodeIds.has(node.node_id)
      const depsSatisfied = areDependenciesSatisfied(node, completedNodeIds)
      return isNotRunning && isNotCompleted && isNotFailed && depsSatisfied
    })
  }

  // ============================================================================
  // Node Spawn — Full daemon-flow for a single node (§10 compliant)
  // ============================================================================

  const spawnReadyNode = (workflowId: string, node: DAGNodeSession): Effect.Effect<void, never, never> => {
    let worktreeCleanup: (() => Promise<void>) | undefined

    const body = Effect.gen(function* () {
      // 0. Paused guard (§10.e Option C): if workflow is paused, bail out
      //    without changing node status (pending stays pending).
      const wf = yield* sessionService.getWorkflow(workflowId)
      // #1 spawn_start — logged immediately on fiber entry (before paused guard)
      if (wf?.chat_session_id) {
        yield* safeAppendLog({
          nodeId: node.node_id,
          workflowId,
          chatSessionId: wf.chat_session_id,
          logLevel: 'info',
          logMessage: `Spawn started for node ${node.node_id}`,
          executionPhase: 'spawn_start',
          logData: { worker_type: node.config.worker_type },
        })
      }
      if (wf && wf.status === 'paused') {
        return
      }

      // 1. Validate promptOps available
      if (!_promptOps) {
        yield* sessionService.updateNodeStatus({
          sessionId: node.node_id,
          status: 'failed',
          error: 'no promptOps configured for DAG node execution'
        } satisfies UpdateNodeStatusInput).pipe(
          Effect.tapError((err) => Effect.logWarning(`[DAG] status update failed: ${err}`)),
          Effect.ignore
        )
        return
      }

      // 2. Resolve agent
      const agentService = yield* Agent.Service
      const agent = yield* agentService.get(node.config.worker_type)
        .pipe(Effect.catchCause(() => Effect.succeed(undefined as Agent.Info | undefined)))
      if (!agent) {
        yield* sessionService.updateNodeStatus({
          sessionId: node.node_id,
          status: 'failed',
          error: `unknown worker_type: ${node.config.worker_type}`
        } satisfies UpdateNodeStatusInput).pipe(
          Effect.tapError((err) => Effect.logWarning(`[DAG] status update failed: ${err}`)),
          Effect.ignore
        )
        // #2 worker_missing
        if (wf?.chat_session_id) {
          yield* safeAppendLog({
            nodeId: node.node_id,
            workflowId,
            chatSessionId: wf.chat_session_id,
            logLevel: 'error',
            logMessage: `Worker type missing: ${node.config.worker_type} for node ${node.node_id}`,
            executionPhase: 'worker_missing',
            logData: { worker_type: node.config.worker_type },
          })
        }
        return
      }

      // 2.5 WorktreeManager: opt-in isolation via worker_config.use_worktree
      const useWorktree = (node.config.worker_config as { use_worktree?: boolean } | undefined)?.use_worktree === true
      let worktreePath: string | undefined

      if (useWorktree) {
        const maybeManager = yield* Effect.gen(function* () {
          return yield* WorktreeManagerTag
        }).pipe(
          Effect.catchCause(() => Effect.succeed(undefined as IWorktreeManager | undefined))
        )

        if (maybeManager) {
          const branch = `dag-${workflowId}-${node.config.id}`
          const createResult = yield* Effect.promise(() =>
            maybeManager.create(node.node_id, {
              basePath: process.cwd(),
              branch,
            })
          ).pipe(
            Effect.tapError(err => Effect.logWarning(`[DAG] worktree create failed for ${node.node_id}: ${err}`)),
            Effect.catchCause(() => Effect.succeed(undefined as WorktreeInfo | undefined))
          )

          if (!createResult) {
            yield* sessionService.updateNodeStatus({
              sessionId: node.node_id,
              status: 'failed',
              error: 'worktree creation failed',
            } satisfies UpdateNodeStatusInput).pipe(
              Effect.tapError((err) => Effect.logWarning(`[DAG] status update failed: ${err}`)),
              Effect.ignore
            )
            return
          }

          worktreePath = createResult.path
          worktreeCleanup = () => maybeManager.cleanup(createResult.id)
        }
      }

      // 3. Resolve sessions + create child session (§10: before status='running')
      const sessions = yield* Session.Service
      const workflow = yield* sessionService.getWorkflow(workflowId)
      if (!workflow) {
        yield* Effect.logDebug(`spawnReadyNode: workflow ${workflowId} gone, aborting spawn`)
        return
      }
      const childSession = yield* sessions.create({
        parentID: workflow.chat_session_id as SessionID,
        title: node.config.name + ' (DAG node)',
        ...(worktreePath ? { directory: worktreePath } : {}),
      })
      // #3 session_created
      yield* safeAppendLog({
        nodeId: node.node_id,
        workflowId,
        chatSessionId: workflow.chat_session_id,
        logLevel: 'info',
        logMessage: `Child session created: ${childSession.id} for node ${node.node_id}`,
        executionPhase: 'session_created',
        logData: { child_session_id: childSession.id },
      })

      // 4. Persist chat_session_id metadata (§10 timing fix - BEFORE updateNodeStatus('running'))
      if (sessionService.updateNodeMetadata) {
        yield* sessionService.updateNodeMetadata(node.node_id, {
          chat_session_id: childSession.id,
        }).pipe(
          Effect.tapError((err) => Effect.logWarning(`[DAG] node metadata update failed: ${err}`)),
          Effect.ignore
        )
        // #4 metadata_written
        yield* safeAppendLog({
          nodeId: node.node_id,
          workflowId,
          chatSessionId: workflow.chat_session_id,
          logLevel: 'info',
          logMessage: `Metadata written for node ${node.node_id}`,
          executionPhase: 'metadata_written',
          logData: { child_session_id: childSession.id },
        })
      }

      // 5. NOW mark as running (persist-first, before prompt)
      yield* sessionService.updateNodeStatus({
        sessionId: node.node_id,
        status: 'running'
      } satisfies UpdateNodeStatusInput).pipe(
        Effect.tapError((err) => Effect.logWarning(`[DAG] status update failed: ${err}`)),
        Effect.ignore
      )
      // #5 running
      yield* safeAppendLog({
        nodeId: node.node_id,
        workflowId,
        chatSessionId: workflow.chat_session_id,
        logLevel: 'info',
        logMessage: `Node status set to running: ${node.node_id}`,
        executionPhase: 'running',
      })

      // 6. Prepend DAG node instructions + run prompt with timeout and retry
      const promptInstruction = [
        `You are executing a DAG node. Node ID: ${node.node_id}.`,
        `When you have finished your work, you MUST call the \`node_complete\` tool EXACTLY ONCE with your result.`,
        `Use status='completed' and output for success. Use status='failed' and error for fatal errors.`,
        `If you do not call node_complete, the node will be marked failed.`,
        ``,
        `Your task:`,
        (node.config.worker_config?.prompt ?? ''),
      ].join("\n")

      const parts = yield* _promptOps.resolvePromptParts(promptInstruction)
      
      // T1+T2: Retry loop with timeout enforcement
      const maxRetries = node.max_retries ?? 0
      let attempt = 0
      let promptSuccess = false

      while (attempt <= maxRetries && !promptSuccess) {
        if (attempt > 0) {
          yield* sessionService.incrementRetryCount(node.node_id).pipe(
            Effect.tapError((err) => Effect.logWarning(`[DAG] incrementRetryCount failed: ${err}`)),
            Effect.ignore
          )
          yield* Effect.logWarning(`[DAG] retrying node ${node.node_id}, attempt ${attempt + 1}/${maxRetries + 1}`)
          // #7 retry_attempt
          yield* safeAppendLog({
            nodeId: node.node_id,
            workflowId,
            chatSessionId: workflow.chat_session_id,
            logLevel: 'debug',
            logMessage: `Retry attempt ${attempt + 1}/${maxRetries + 1} for node ${node.node_id}`,
            executionPhase: 'retry_attempt',
            logData: { attempt: attempt + 1, max_retries: maxRetries },
          })
        }
        
        const timeoutMs = node.config.timeout_ms ?? 300_000
        // #6 prompt_started
        yield* safeAppendLog({
          nodeId: node.node_id,
          workflowId,
          chatSessionId: workflow.chat_session_id,
          logLevel: 'info',
          logMessage: `Prompt started for node ${node.node_id}, attempt ${attempt + 1}`,
          executionPhase: 'prompt_started',
          logData: { attempt: attempt + 1, timeout_ms: timeoutMs },
        })
        const result = yield* _promptOps.prompt({
          sessionID: childSession.id,
          messageID: MessageID.ascending(),
          agent: agent.name,
          parts,
        }).pipe(
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () => Effect.fail(new Error(`node timed out after ${timeoutMs}ms`))
          }),
          Effect.result
        )
        
        if (Result.isSuccess(result)) {
          promptSuccess = true
        } else {
          const failure = Result.getFailure(result)
          const errMsg = failure._tag === 'Some' ? String(failure.value) : 'unknown error'
          yield* Effect.logWarning(`[DAG] node ${node.node_id} attempt ${attempt + 1} failed: ${errMsg}`)
          // #8/#9 prompt_failed or timeout (detected from error message)
          const isTimeout = errMsg.includes('timed out')
          yield* safeAppendLog({
            nodeId: node.node_id,
            workflowId,
            chatSessionId: workflow.chat_session_id,
            logLevel: 'error',
            logMessage: isTimeout ? `Node prompt timed out: ${errMsg}` : `Node prompt failed: ${errMsg}`,
            executionPhase: isTimeout ? 'timeout' : 'prompt_failed',
            logData: { attempt: attempt + 1, error: errMsg },
          })
          attempt++
          if (attempt > maxRetries) {
            yield* sessionService.updateNodeStatus({
              sessionId: node.node_id,
              status: 'failed',
              error: errMsg,
            } satisfies UpdateNodeStatusInput).pipe(
              Effect.tapError((err) => Effect.logWarning(`[DAG] status update failed: ${err}`)),
              Effect.ignore
            )
          }
        }
      }

      // 7. Post-prompt: if node still 'running' (subagent never called node_complete)
      const finalNodes = yield* sessionService.listNodes(workflowId)
      const thisNode = finalNodes.find((n: DAGNodeSession) => n.node_id === node.node_id)
      if (thisNode && thisNode.status === 'running') {
        yield* sessionService.updateNodeStatus({
          sessionId: node.node_id,
          status: 'failed',
          error: 'node did not call node_complete tool'
        } satisfies UpdateNodeStatusInput).pipe(
          Effect.tapError((err) => Effect.logWarning(`[DAG] status update failed: ${err}`)),
          Effect.ignore
        )
        // #10 node_complete_missing
        yield* safeAppendLog({
          nodeId: node.node_id,
          workflowId,
          chatSessionId: workflow.chat_session_id,
          logLevel: 'warn',
          logMessage: `Node did not call node_complete tool: ${node.node_id}`,
          executionPhase: 'node_complete_missing',
        })
      }
    }).pipe(
      Effect.ensuring(Effect.sync(() => {
        if (worktreeCleanup) {
          worktreeCleanup().catch((err) => console.warn(`[DAG] worktree cleanup failed: ${err}`))
        }
      })),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const errMsg = String(Cause.squash(cause))
          // Mark node failed if still in non-terminal state (spawn infra failure)
          const nodes = yield* sessionService.listNodes(workflowId).pipe(Effect.catchCause(() => Effect.succeed([] as DAGNodeSession[])))
          const current = nodes.find((n: DAGNodeSession) => n.node_id === node.node_id)
          if (current && (current.status === 'pending' || current.status === 'running')) {
            yield* sessionService.updateNodeStatus({
              sessionId: node.node_id,
              status: 'failed',
              error: `spawn failed: ${errMsg}`
            } satisfies UpdateNodeStatusInput).pipe(
              Effect.tapError((err) => Effect.logWarning(`[DAG] status update failed: ${err}`)),
              Effect.ignore
            )
            yield* sessionService.createViolation({
              workflowId,
              nodeId: node.node_id,
              type: 'execution_failed',
              severity: 'error',
              message: `Node spawn failed: ${errMsg}`,
            }).pipe(
              Effect.tapError((err) => Effect.logWarning(`[DAG] violation creation failed for ${node.node_id}: ${err}`)),
              Effect.ignore
            )
          }
          return yield* Effect.logDebug(`spawnReadyNode uncaught: ${errMsg}`)
        })
      )
    ) as Effect.Effect<void, never, never>
    return body
  }

  // ============================================================================
  // Workflow Terminal Convergence Helpers
  // ============================================================================

  /**
   * 级联 skip：将 failedNodeId 所有下游 pending 节点标记为 skipped。
   * pending→skipped 是合法转移（session-service.ts:70）。
   * buildSessionNodeEvent 含 node.skipped case（铁律#3）。
   */
  const cascadeSkipDownstream = (
    workflowId: string,
    failedNodeId: string,
  ): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      const wfForLog = yield* sessionService.getWorkflow(workflowId)
      const allNodes = yield* sessionService.listNodes(workflowId)
      const descendants = findPendingDescendants(allNodes, failedNodeId)
      for (const d of descendants) {
        yield* sessionService.updateNodeStatus({
          sessionId: d.node_id,
          status: 'skipped',
        } satisfies UpdateNodeStatusInput).pipe(
          Effect.tapError((err) => Effect.logWarning(`[DAG] cascade-skip status update failed for ${d.node_id}: ${err}`)),
          Effect.ignore
        )
        // #13 cascade_skip
        if (wfForLog?.chat_session_id) {
          yield* safeAppendLog({
            nodeId: d.node_id,
            workflowId,
            chatSessionId: wfForLog.chat_session_id,
            logLevel: 'warn',
            logMessage: `Cascade skip: ${d.node_id} skipped due to failure of ${failedNodeId}`,
            executionPhase: 'cascade_skip',
            logData: { failed_node_id: failedNodeId },
          })
        }
      }
    }).pipe(Effect.catchCause((cause) => Effect.logWarning(`[DAG] cascadeSkipDownstream(${workflowId}, ${failedNodeId}) failed: ${Cause.squash(cause)}`)))

  /**
   * 检测所有节点是否已进入终态，若是则收敛 workflow.status。
   * workflow 收敛决策：任一 required 节点 failed → 'failed'；否则 → 'completed'。
   * 幂等守卫：先读 workflow.status，若已终态则 no-op（铁律#2 + 并发 fork 竞态）。
   * Session 层隔离：使用 DAGWorkflowStatus 数组，不引用 Core 层 WorkflowStatus。
   */
  const maybeFinalizeWorkflow = (
    workflowId: string,
  ): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      const workflow = yield* sessionService.getWorkflow(workflowId)
      if (!workflow) return

      const SESSION_TERMINAL: DAGWorkflowStatus[] = ['completed', 'failed', 'cancelled']
      if (SESSION_TERMINAL.includes(workflow.status)) return

      const allNodes = yield* sessionService.listNodes(workflowId)
      const hasInProgress = allNodes.some((n: DAGNodeSession) =>
        n.status === 'pending' || n.status === 'queued' || n.status === 'running'
      )
      if (hasInProgress) return

      const hasRequiredFailed = allNodes.some((n: DAGNodeSession) =>
        n.config.required === true && n.status === 'failed'
      )
      const targetStatus: DAGWorkflowStatus = hasRequiredFailed ? 'failed' : 'completed'

      yield* sessionService.updateWorkflowStatus(workflowId, targetStatus)
    }).pipe(Effect.catchCause(() => Effect.void))

  // ============================================================================
  // 核心方法
  // ============================================================================

  /**
   * 启动工作流
   */
  const startWorkflow: WorkflowEngine['startWorkflow'] = (workflowId, config) =>
    Effect.gen(function* () {
      // Store concurrency cap for scheduleReadyNodes budget enforcement
      concurrencyRegistry.set(workflowId, config.max_concurrency)

      // 更新工作流状态为 running
      yield* sessionService.updateWorkflowStatus(workflowId, 'running')
      
      // 调度第一批准备就绪的节点
      yield* scheduleReadyNodes(workflowId)
      
      return { success: true, workflowId }
    }) as Effect.Effect<{ success: boolean; workflowId: string }, never>

  /**
   * 调度所有就绪的节点 — daemon-based spawn (no inline status update)
   */
  const scheduleReadyNodes: WorkflowEngine['scheduleReadyNodes'] = (workflowId) =>
    Effect.gen(function* () {
      // Freeze out concurrent spawn while a replan is in progress (race guard)
      if (replanInFlight.has(workflowId)) return { scheduled: 0 }
      const allNodes = yield* sessionService.listNodes(workflowId)
      const completedNodeIds = new Set<string>(
        allNodes.filter((n: DAGNodeSession) => n.status === 'completed').map((n: DAGNodeSession) => n.node_id)
      )
      const failedNodeIds = new Set<string>(
        allNodes.filter((n: DAGNodeSession) => n.status === 'failed').map((n: DAGNodeSession) => n.node_id)
      )
      const runningNodeIds = new Set<string>(
        allNodes.filter((n: DAGNodeSession) => n.status === 'running').map((n: DAGNodeSession) => n.node_id)
      )
      const skippedNodeIds = new Set<string>(
        allNodes.filter((n: DAGNodeSession) => n.status === 'skipped').map((n: DAGNodeSession) => n.node_id)
      )
      const readyNodes = getReadyNodes(allNodes, completedNodeIds, failedNodeIds, runningNodeIds)

      // T3: Enforce concurrency cap — account for in-flight spawned nodes (spawned but not yet settled)
      const inFlightCount = [...spawnedNodes]
        .filter(id => id.startsWith(`${workflowId}::`))
        .filter(id => !runningNodeIds.has(id) && !completedNodeIds.has(id) && !failedNodeIds.has(id) && !skippedNodeIds.has(id))
        .length
      const maxConcurrency = concurrencyRegistry.get(workflowId) ?? Number.POSITIVE_INFINITY
      const budget = maxConcurrency - runningNodeIds.size - inFlightCount
      if (budget <= 0) return { scheduled: 0 }

      const limit = Math.min(readyNodes.length, budget)
      let scheduled = 0
      for (let i = 0; i < limit; i++) {
        const node = readyNodes[i]
        if (!spawnedNodes.has(node.node_id)) {
          spawnedNodes.add(node.node_id)
          yield* spawnReadyNode(workflowId, node).pipe(Effect.forkDetach)
          scheduled++
        }
      }

      return { scheduled }
    }) as Effect.Effect<{ scheduled: number }, never>

  /**
   * 处理节点完成
   */
  const handleNodeCompletion: WorkflowEngine['handleNodeCompletion'] = (workflowId, nodeId, output) =>
    Effect.gen(function* () {
      // 1. 更新节点状态
      yield* sessionService.updateNodeStatus({
        sessionId: nodeId,
        status: 'completed',
        outputData: output
      })

      // #11 completed
      const wf = yield* sessionService.getWorkflow(workflowId)
      if (wf?.chat_session_id) {
        yield* safeAppendLog({
          nodeId,
          workflowId,
          chatSessionId: wf.chat_session_id,
          logLevel: 'info',
          logMessage: `Node completed: ${nodeId}`,
          executionPhase: 'completed',
        })
      }
      
      // 2. 调度下一批准备就绪的节点
      yield* scheduleReadyNodes(workflowId)

      // 3. Workflow terminal convergence
      yield* maybeFinalizeWorkflow(workflowId)
      
      return { success: true }
    }) as Effect.Effect<{ success: boolean }, never>

  /**
   * 处理节点失败
   */
  const handleNodeFailure: WorkflowEngine['handleNodeFailure'] = (workflowId, nodeId, error) =>
    Effect.gen(function* () {
      // 1. Mark node failed
      yield* sessionService.updateNodeStatus({
        sessionId: nodeId,
        status: 'failed',
        error: error.message
      })

      // #12 failed
      const wfForLog = yield* sessionService.getWorkflow(workflowId)
      if (wfForLog?.chat_session_id) {
        yield* safeAppendLog({
          nodeId,
          workflowId,
          chatSessionId: wfForLog.chat_session_id,
          logLevel: 'error',
          logMessage: `Node failed: ${nodeId} — ${error.message}`,
          executionPhase: 'failed',
          logData: { error: error.message },
        })
      }

      // 2. Conditional violation type (required vs optional)
      const allNodesForViolation = yield* sessionService.listNodes(workflowId)
      const failedNode = allNodesForViolation.find((n: DAGNodeSession) => n.node_id === nodeId)
      const violationType: DAGViolationType = failedNode?.config?.required
        ? 'required_node_failed'
        : 'execution_failed'

      yield* sessionService.createViolation({
        workflowId,
        nodeId,
        type: violationType,
        severity: 'error',
        message: error.message
      })

      // 3. Cascade skip downstream pending nodes BEFORE scheduleReadyNodes
      yield* cascadeSkipDownstream(workflowId, nodeId)

      // 4. Schedule other independent branches
      yield* scheduleReadyNodes(workflowId)

      // 5. Workflow terminal convergence
      yield* maybeFinalizeWorkflow(workflowId)
      
      return { success: true }
    }) as Effect.Effect<{ success: boolean }, never>

  /**
   * 取消工作流
   */
  const cancelWorkflow: WorkflowEngine['cancelWorkflow'] = (workflowId) =>
    Effect.gen(function* () {
      yield* sessionService.updateWorkflowStatus(workflowId, 'cancelled')
      return { success: true }
    }) as Effect.Effect<{ success: boolean }, never>

  /**
   * 暂停工作流 (§10.e Option A+C: pause 不中断 fiber，不改变 node 状态)
   */
  const pauseWorkflow: WorkflowEngine['pauseWorkflow'] = (workflowId) =>
    Effect.gen(function* () {
      yield* sessionService.updateWorkflowStatus(workflowId, 'paused')
      return 'paused' as DAGWorkflowStatus
    }) as Effect.Effect<DAGWorkflowStatus, never>

  /**
   * 恢复工作流：状态改回 running 并显式触发调度
   */
  const resumeWorkflow: WorkflowEngine['resumeWorkflow'] = (workflowId) =>
    Effect.gen(function* () {
      yield* sessionService.updateWorkflowStatus(workflowId, 'running')
      yield* scheduleReadyNodes(workflowId)
      return 'running' as DAGWorkflowStatus
    }) as Effect.Effect<DAGWorkflowStatus, never>

  /**
   * 获取工作流状态
   */
  const getWorkflowStatus: WorkflowEngine['getWorkflowStatus'] = (workflowId) =>
    Effect.gen(function* () {
      const workflow = yield* sessionService.getWorkflow(workflowId)
      if (!workflow) {
        return {
          workflowId,
          status: 'cancelled' as DAGWorkflowStatus,
          totalNodes: 0,
          completedNodes: 0,
          failedNodes: 0,
          runningNodes: 0,
          readyNodes: 0,
          violations: [] as DAGViolation[],
          violations_count: 0,
          timestamp: Date.now(),
        }
      }

      const allNodes = yield* sessionService.listNodes(workflowId)

      const completedNodes = allNodes.filter((n: DAGNodeSession) => n.status === 'completed').length
      const failedNodes = allNodes.filter((n: DAGNodeSession) => n.status === 'failed').length
      const runningNodes = allNodes.filter((n: DAGNodeSession) => n.status === 'running').length

      const completedNodeIds = new Set<string>(
        allNodes.filter((n: DAGNodeSession) => n.status === 'completed').map((n: DAGNodeSession) => n.node_id)
      )
      const failedNodeIds = new Set<string>(
        allNodes.filter((n: DAGNodeSession) => n.status === 'failed').map((n: DAGNodeSession) => n.node_id)
      )
      const runningNodeIds = new Set<string>(
        allNodes.filter((n: DAGNodeSession) => n.status === 'running').map((n: DAGNodeSession) => n.node_id)
      )
      const readyNodes = getReadyNodes(allNodes, completedNodeIds, failedNodeIds, runningNodeIds)

      const violations = yield* violationAPI.getWorkflowViolations(workflowId)
        .pipe(Effect.catchCause(() => Effect.succeed([] as DAGViolation[])))

      return {
        workflowId,
        status: workflow.status,
        totalNodes: allNodes.length,
        completedNodes,
        failedNodes,
        runningNodes,
        readyNodes: readyNodes.length,
        violations,
        violations_count: violations.length,
        timestamp: Date.now(),
      }
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed({
          workflowId,
          status: 'cancelled' as DAGWorkflowStatus,
          totalNodes: 0,
          completedNodes: 0,
          failedNodes: 0,
          runningNodes: 0,
          readyNodes: 0,
          violations: [] as DAGViolation[],
          violations_count: 0,
          timestamp: Date.now(),
        })
      )
    ) as Effect.Effect<WorkflowStatusSnapshot, never>

  // ============================================================================
  // Replan — atomically restructure the tail of a running workflow
  // ============================================================================

  const replanWorkflow: WorkflowEngine['replanWorkflow'] = (workflowId, patch) =>
    Effect.gen(function* () {
      // 0. Freeze out concurrent spawn for the duration of this replan
      // NOTE: replanInFlight only freezes NEW scheduleReadyNodes calls. Already-forked
      // spawnReadyNode fibers from a prior tick continue running. If one of them
      // targets a node this replan removes, the spawn proceeds, runs, and calls
      // updateNodeStatus on a deleted row — a SQLite no-op. The wasted LLM work is
      // accepted as a documented-known; full fiber cancellation is out of scope for
      // this WP (see dag/AGENTS.md "four iron laws": state-machine integrity is
      // preserved — no status field is ever corrupted by this race).
      replanInFlight.add(workflowId)

      // 1. Read current state
      const workflow = yield* sessionService.getWorkflow(workflowId)
      if (!workflow) return yield* Effect.fail(new Error(`Workflow ${workflowId} not found`))
      const currentNodes = yield* sessionService.listNodes(workflowId)

      // 2. Preconditions (terminal + empty patch)
      const preResult = validateReplanPreconditions(workflow, patch)
      if (!preResult.ok) return yield* Effect.fail(new Error(preResult.reason))

      // 3. Classify nodes: frozen vs mutable
      const { frozenIds } = classifyReplanNodes(currentNodes)

      // 4. Frozen + existence guards
      const currentNodeIds = new Set(currentNodes.map((n: DAGNodeSession) => n.node_id))
      const frozenExistResult = validateFrozenAndExistence(patch, frozenIds, currentNodeIds)
      if (!frozenExistResult.ok) return yield* Effect.fail(new Error(frozenExistResult.reason))

      // 5. Snapshot old state for history
      const oldState = {
        config: workflow.config,
        node_ids: currentNodes.map((n: DAGNodeSession) => n.node_id),
      }

      // 6. Apply config patch in-memory
      const applyResult = applyReplanPatchToConfig(workflowId, workflow.config.nodes, patch)
      if (!applyResult.ok) return yield* Effect.fail(new Error(applyResult.reason))
      const { newConfigNodes } = applyResult

      // 7. Post-patch validation
      const postResult = validateReplanPostConfig(newConfigNodes, patch, workflow)
      if (!postResult.ok) return yield* Effect.fail(new Error(postResult.reason))

      // 8. Build DB inputs
      const { updates, newNodes: newNodesForDb, newMaxConcurrency } = buildReplanDbInputs(
        workflowId,
        patch,
        newConfigNodes,
        currentNodes,
        workflow.config.max_concurrency,
      )
      const newConfig: DAGConfig = { ...workflow.config, nodes: newConfigNodes, max_concurrency: newMaxConcurrency }

      // 9. Atomic apply — all 5 DB writes in one transaction
      if (!sessionService.atomicReplan) {
        return yield* Effect.fail(new Error(`atomicReplan unavailable on session service`))
      }
      const historyRow = yield* sessionService.atomicReplan({
        workflowId,
        chatSessionId: workflow.chat_session_id,
        removeNodeIds: patch.remove_nodes ?? [],
        updates,
        newNodes: newNodesForDb,
        newWorkflowConfig: newConfig,
        action: 'replan',
        oldState,
        newState: {
          config: newConfig,
          node_ids: currentNodes
            .filter((n: DAGNodeSession) => !(patch.remove_nodes ?? []).includes(n.node_id))
            .map((n: DAGNodeSession) => n.node_id)
            .concat(newNodesForDb.map(n => n.nodeId!)),
        },
        changeDetails: {
          removed: patch.remove_nodes ?? [],
          updated: (patch.update_nodes ?? []).map(u => u.node_id),
          added: (patch.add_nodes ?? []).map(a => `${workflowId}::${a.id}`),
          max_concurrency: newMaxConcurrency,
        },
        changedBy: patch.changed_by ?? null,
      })

      // 10. Sync concurrencyRegistry with new cap
      if (patch.new_max_concurrency !== undefined) {
        concurrencyRegistry.set(workflowId, patch.new_max_concurrency)
      }

      // 11. Cleanup spawnedNodes for removed nodes
      for (const id of patch.remove_nodes ?? []) spawnedNodes.delete(id)

      // 12. Release replan-in-flight (also guaranteed by Effect.ensuring below)
      replanInFlight.delete(workflowId)

      // 13. Iron Law #3: broadcast replanned event after successful persist
      emitWorkflowReplannedEvent(workflowId, workflow.chat_session_id, {
        added: newNodesForDb.length,
        removed: (patch.remove_nodes ?? []).length,
        updated: updates.length,
        final_total: newConfigNodes.length,
      })

      return {
        ok: true as const,
        workflow_id: workflowId,
        history_id: historyRow.history_id,
        nodes_added: newNodesForDb.length,
        nodes_removed: (patch.remove_nodes ?? []).length,
        nodes_updated: updates.length,
        final_total: newConfigNodes.length,
      }
    }).pipe(
      // Guarantee replanInFlight cleanup on any failure path
      Effect.ensuring(Effect.sync(() => replanInFlight.delete(workflowId))),
      // Collapse any Effect.fail into an { ok: false, reason } result
      Effect.catchCause((cause) =>
        Effect.succeed({
          ok: false as const,
          reason: String(Cause.squash(cause)),
          detail: Cause.squash(cause),
        })
      ),
    ) as Effect.Effect<ReplanResult, never, never>

  return {
    startWorkflow,
    scheduleReadyNodes,
    handleNodeCompletion,
    handleNodeFailure,
    cancelWorkflow,
    getWorkflowStatus,
    replanWorkflow,
    pauseWorkflow,
    resumeWorkflow,
    setPromptOps,
    spawnReadyNode,
  } as WorkflowEngine & {
    setPromptOps: typeof setPromptOps
    spawnReadyNode: typeof spawnReadyNode
  }
})

export const WorkflowEngine = {
  make,
  get: (workflowId: string) => engineRegistry.get(workflowId),
}
