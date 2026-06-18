// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

import { Cause, Effect, Option, Result } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { DAGSessionService, emitWorkflowReplannedEvent, getEventBus } from "./session-service"
import type {
  AppendNodeLogInput,
  CreateViolationInput,
  UpdateNodeStatusInput,
} from "./session-service"
import { DEFAULT_NODE_TIMEOUT_MS, validateFailureHandler, validateInputMapping, validateNodeCondition, validateTimeoutPolicy, validateWorkflowConfigLimits } from "./limits"
import { buildOutputMap, splitByCondition } from "./condition-eval"
import { collectInputMapping } from "./input-mapping-collector"
import { injectCollectedDataToPrompt } from "./prompt-inject"
import { ViolationQueryAPI } from "./violation-query"
import { RequiredNodesValidator } from "./required-nodes-validator"
import type {
  DAGConfig,
  DAGNodeConfig,
  DAGNodeSession,
  DAGViolation,
  DAGViolationType,
  DAGWorkflowStatus,
  DiagnosisDecision,
  FailureDiagnosisInput,
  FailureHandlerConfig,
  ReplanPatch,
  ReplanPreviewResult,
  ReplanResult,
  StepResult,
} from "./types"
import type { PromptOps } from "@/session/prompt-ops"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import * as SessionStatus from "@/session/status"
import { WorktreeManagerTag } from "../worktree-manager/tags"
import type { IWorktreeManager } from "../worktree-manager/IWorktreeManager"
import type { WorktreeInfo } from "../worktree-manager/types"
import { bootstrapWorkflowFromConfig } from "./core-start"
import { readDagDefaultsFromService } from "./dag-config-check"
import { MAX_SUB_DAG_DEPTH, DEFAULT_SUB_DAG_TIMEOUT_MS, MAX_CONCURRENCY } from "./limits"
import type { IEventBus } from "../state-machine/IStateMachine"
import { ProviderID, ModelID } from "@/provider/schema"
import { Config } from "@/config/config"
import {
  areDependenciesSatisfied,
  getReadyNodes,
  computeFinalWorkflowStatus,
  computeSpawnBudget,
  detectCycle,
  findPendingDescendants,
  validateReplanPreconditions,
  classifyReplanNodes,
  validateFrozenAndExistence,
  applyReplanPatchToConfig,
  buildReplanDbInputs,
} from "./execution-core"
import type {
  ReplanValidateResult,
} from "./execution-core"

const log = Log.create({ service: "dag.engine" })

// Re-export execution-core symbols for backward compatibility.
// All existing `from "./workflow-engine"` imports of these symbols continue to work.
export {
  areDependenciesSatisfied,
  getReadyNodes,
  computeFinalWorkflowStatus,
  computeSpawnBudget,
  detectCycle,
  findPendingDescendants,
  validateReplanPreconditions,
  classifyReplanNodes,
  validateFrozenAndExistence,
  applyReplanPatchToConfig,
  buildReplanDbInputs,
} from "./execution-core"
export type {
  ReplanValidateResult,
  ApplyReplanResult,
  ReplanDbInputs,
} from "./execution-core"

/**
 * Session Path — Production Runtime (single source of truth)
 *
 * This file (`workflow-engine.ts`) is the **Session path**: the production
 * runtime that orchestrates DAG execution via the SQLite-backed
 * `DAGSessionService`. Pure scheduling/transition logic is delegated to the
 * A-layer `execution-core.ts`.
 *
 * The legacy **Core path** (`state-machine/` + `scheduler/` + `group-manager/`
 * implementation classes) is approved for RETIREMENT (D-PLAN-RETIRE) — it has
 * zero production references and is range-fenced for deletion. See the DAG
 * `AGENTS.md` (§1.2 + §6 retire/keep table) for the authoritative boundary.
 *
 * If you find yourself tempted to `new NodeStateMachine`, `new Scheduler`, or
 * `new GroupManager` from here — STOP. Those are retiring; the Session path is
 * the only production truth. Keep using `execution-core` pure functions instead.
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
  recoverableCount?: number
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
  previewReplanWorkflow?: (workflowId: string, patch: ReplanPatch) => Effect.Effect<ReplanPreviewResult>
  replanWorkflow(workflowId: string, patch: ReplanPatch): Effect.Effect<ReplanResult>
  pauseWorkflow(workflowId: string): Effect.Effect<DAGWorkflowStatus, never>
  resumeWorkflow(workflowId: string): Effect.Effect<DAGWorkflowStatus, never>
  stepWorkflow(workflowId: string): Effect.Effect<StepResult, never>
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
const recoveryGenerationRegistry = new Map<string, number>()
// P2-B: Module-level registry for step-execution (single-node under paused workflow).
// A workflow is in step mode iff its workflowId is in `stepMode`. While set:
// - spawnReadyNode's paused guard allows spawn for the target workflow
// - handleNodeCompletion/Failure skip scheduleReadyNodes + maybeFinalize
// - maybeFinalize is suppressed (workflow stays paused throughout)
// stepResolve stores the Deferred callback to be called when the stepped node
// reaches a terminal state (completed/failed), resolving the stepWorkflow awaiter.
const stepMode = new Set<string>()
const stepResolve = new Map<string, (result: StepResult) => void>()

// ============================================================================
// WP1-B: Node-level timeout — settled registry
// Tracks which nodes have settled (reached terminal state).
// Key: node_id, Value: boolean (true once node settles).
// Used by setTimeout-based timeout fiber to check if node already done.
// ============================================================================
const nodeSettledRegistry = new Map<string, boolean>()

// ============================================================================
// WP-E1: Failure Diagnosis — recovery attempts registry
// Tracks how many automatic recoveries have been attempted per workflow.
// Module-level (not persisted) — acceptable since diagnosis is best-effort
// and restarts reset all in-flight workflows anyway.
// ============================================================================
const recoveryAttemptsRegistry = new Map<string, number>()

// ============================================================================
// WP-D3: Sub-DAG Lifecycle Bridge — extracted to ./subdag-bridge.ts (Step 4).
// Re-exported here for backward compatibility with all existing consumers
// (workflow-engine.ts internal calls + scenario-27-subdag-lifecycle.test.ts).
// Imported separately for internal use within this file.
// ============================================================================

import {
  cleanupSubscriptions,
  installSubdagLifecycleBridge,
} from "./subdag-bridge"

export {
  type SubdagSubscriptionState,
  __internal_subdagSubscriptions,
  cleanupSubscriptions,
  installSubdagLifecycleBridge,
} from "./subdag-bridge"

// ============================================================================
// Replan Pure Helpers — canonical implementations in ./execution-core.ts.
// Re-exported above for backward compatibility.
// ============================================================================

// Re-export for backward compatibility: all existing `from "./workflow-engine"` imports
// of validateWorkflowConfigLimits (including test files) continue to work unchanged.
// Canonical implementation lives in ./limits.ts (breaks session-service↔workflow-engine cycle).
export { validateWorkflowConfigLimits } from "./limits"

/**
 * Validates the post-patch config: node cap, concurrency range (1..10),
 * dependency resolution, required-node integrity, and cycle absence.
 *
 * NOTE: Stays in workflow-engine.ts (Advisory A1 方案 b) because it depends on
 * RequiredNodesValidator which has Effect import — not eligible for execution-core.
 */
export function validateReplanPostConfig(
  newConfigNodes: DAGNodeConfig[],
  patch: ReplanPatch,
  workflow: { config: DAGConfig },
  currentNodes?: DAGNodeSession[],
): ReplanValidateResult {
  const newMaxConcurrency = patch.new_max_concurrency ?? workflow.config.max_concurrency
  const limits = validateWorkflowConfigLimits({ nodes: newConfigNodes, max_concurrency: newMaxConcurrency })
  if (!limits.ok) {
    return { ok: false, reason: limits.reason }
  }
  const handlerResult = validateFailureHandler(workflow.config.failure_handler)
  if (!handlerResult.ok) {
    return { ok: false, reason: handlerResult.reason }
  }
  // §2.2: 工作流级 timeout_policy 校验
  const wfTimeoutPolicyResult = validateTimeoutPolicy(workflow.config.timeout_policy)
  if (!wfTimeoutPolicyResult.ok) {
    return { ok: false, reason: `workflow: ${wfTimeoutPolicyResult.reason}` }
  }
  const cfgIdSet = new Set(newConfigNodes.map(n => n.id))
  for (const n of newConfigNodes) {
    for (const dep of n.dependencies) {
      if (!cfgIdSet.has(dep)) {
        return { ok: false, reason: `unresolved dependency: node '${n.id}' references '${dep}'` }
      }
    }
  }
  // WP-B1 (INFO 2): per-node condition schema validation on post-replan config.
  // Without this, replanned configs could bypass the required↔condition 互斥 check.
  // WP-C1 (约束 4): per-node input_mapping schema validation on post-replan config.
  // Without this, replanned configs could bypass the ref ⊆ dependencies check.
  for (const n of newConfigNodes) {
    const condResult = validateNodeCondition(n)
    if (!condResult.ok) {
      return { ok: false, reason: `node '${n.id}': ${condResult.reason}` }
    }
    const mapResult = validateInputMapping(n)
    if (!mapResult.ok) {
      return { ok: false, reason: `node '${n.id}': ${mapResult.reason}` }
    }
    // §2.2: 节点级 timeout_policy 校验
    const nodeTimeoutPolicyResult = validateTimeoutPolicy(n.timeout_policy)
    if (!nodeTimeoutPolicyResult.ok) {
      return { ok: false, reason: `node '${n.id}': ${nodeTimeoutPolicyResult.reason}` }
    }
  }
  const requiredValidator = new RequiredNodesValidator()
  const { valid, errors } = requiredValidator.validate({ ...workflow.config, nodes: newConfigNodes })
  if (!valid) {
    return { ok: false, reason: `Validation errors:\n${errors.join('\n')}` }
  }
  // WP-P1: Reject removals of required nodes except those in recoverable state.
  // When currentNodes is provided, recoverable required nodes can be removed
  // (retry/replacement pattern). When absent (backward-compat), all required
  // node removals are rejected unconditionally.
  const removeCfgIds = new Set((patch.remove_nodes ?? []).map(ns => ns.split('::').slice(1).join('::')))
  const runtimeStatusMap = new Map(
    (currentNodes ?? []).map(n => {
      const cfgId = n.node_id.split('::').slice(1).join('::')
      return [cfgId, n.status] as const
    }),
  )
  const removedRequiredNonRecoverable = workflow.config.nodes
    .filter(n => n.required && removeCfgIds.has(n.id))
    .filter(n => runtimeStatusMap.get(n.id) !== 'recoverable')
    .map(n => n.id)
  if (removedRequiredNonRecoverable.length > 0) {
    return { ok: false, reason: `Cannot remove required nodes: ${removedRequiredNonRecoverable.join(', ')} (only recoverable required nodes can be removed for retry/replacement)` }
  }
  // Cycle check — uses execution-core detectCycle
  if (detectCycle(newConfigNodes)) {
    return { ok: false, reason: `patch introduces a cycle` }
  }
  return { ok: true }
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
  for (const k of Array.from(recoveryGenerationRegistry.keys())) {
    if (k.startsWith(`${workflowId}::`)) recoveryGenerationRegistry.delete(k)
  }
}

function markNodeRecovery(nodeId: string): void {
  recoveryGenerationRegistry.set(nodeId, (recoveryGenerationRegistry.get(nodeId) ?? 0) + 1)
}

function hasNodeRecoveredSinceSpawn(nodeId: string, generationAtSpawn: number): boolean {
  return (recoveryGenerationRegistry.get(nodeId) ?? 0) !== generationAtSpawn
}

/**
 * Sets the concurrency cap for a workflow in the module-level registry.
 * Used by recovery assembly (WP-A2) to restore the cap without calling
 * startWorkflow (which would attempt an illegal running→running transition).
 */
export function setWorkflowConcurrency(workflowId: string, maxConcurrency: number): void {
  concurrencyRegistry.set(workflowId, maxConcurrency)
}

/** @internal test-only — exposes module-private spawnedNodes set for unit testing */
export const __internal_spawnedNodes = (): Set<string> => spawnedNodes
/** @internal test-only — exposes module-private replanInFlight set for unit testing */
export const __internal_replanInFlight = (): Set<string> => replanInFlight
/** @internal test-only — exposes module-private concurrencyRegistry map for unit testing */
export const __internal_concurrencyRegistry = (): Map<string, number> => concurrencyRegistry
/** @internal test-only — exposes module-private stepMode set for unit testing */
export const __internal_stepMode = (): Set<string> => stepMode
/** @internal test-only — exposes module-private nodeSettled registry for unit testing (WP1) */
export const __internal_nodeSettled = (): Map<string, boolean> => nodeSettledRegistry
/** @internal test-only — exposes recovery generation registry for stale-spawn regression tests */
export const __internal_recoveryGeneration = (): Map<string, number> => recoveryGenerationRegistry
/** @internal test-only — advances the recovery generation for stale-spawn regression tests */
export const __internal_markNodeRecovery = (nodeId: string): void => markNodeRecovery(nodeId)
/** @internal test-only — mirrors spawnReadyNode's post-prompt recovery guard */
export const __internal_hasNodeRecoveredSinceSpawn = (nodeId: string, generationAtSpawn: number): boolean =>
  hasNodeRecoveredSinceSpawn(nodeId, generationAtSpawn)

const make = Effect.gen(function* () {
  const dagSessionService = yield* DAGSessionService.make
  const sessionService = dagSessionService
  const violationAPI = new ViolationQueryAPI(sessionService)

  // WP-E1: Capture Agent.Service and Session.Service at the make level so
  // handleNodeFailure's inner failure-diagnosis path can use them without
  // adding Effect context requirements (handleNodeFailure is called from
  // setTimeout callbacks via Effect.runPromise which has no service context).
  // Uses serviceOption (no requirement propagation) — undefined when absent.
  const capturedAgentService = Option.getOrUndefined(yield* Effect.serviceOption(Agent.Service))
  const capturedChatSessions = Option.getOrUndefined(yield* Effect.serviceOption(Session.Service))
  // WP1: Capture SessionStatus.Service at the make level so notifyParentOfFailure
  // can inspect parent session busy/idle state without adding Effect context
  // requirements (the call site is inside maybeFinalizeWorkflow, which runs
  // under setTimeout-based fiber dispatch with no service context).
  // Uses serviceOption (no requirement propagation) — undefined when absent.
  const capturedSessionStatus = Option.getOrUndefined(yield* Effect.serviceOption(SessionStatus.Service))

  // §10.e: non-interrupting log helper for node lifecycle events.
  // appendNodeLog failures are swallowed so they never break node execution.
  const safeAppendLog = (input: AppendNodeLogInput): Effect.Effect<void, never, never> =>
    sessionService.appendNodeLog(input).pipe(Effect.catchCause(() => Effect.void))

  let _promptOps: PromptOps | undefined

  const setPromptOps = (ops: PromptOps) => {
    _promptOps = ops
  }

  // ============================================================================
  // 辅助函数 — areDependenciesSatisfied / getReadyNodes / computeFinalWorkflowStatus
  // are now imported from ./execution-core.ts (A layer, pure logic)
  // ============================================================================

  /**
   * P2-B stepMode guard for early-failure paths inside spawnReadyNode.
   * When a node fails via direct updateNodeStatus (NOT via handleNodeFailure),
   * the stepMode Deferred must still be resolved to prevent stepWorkflow from hanging.
   * Idempotent: only fires when stepMode is active for this workflow; the first
   * caller wins (delete-before-callback prevents double-resolution).
   */
  const resolveStepFailed = (wid: string, nodeId: string, errorMsg: string): void => {
    if (stepMode.has(wid)) {
      const resolve = stepResolve.get(wid)
      if (resolve) {
        stepResolve.delete(wid)
        stepMode.delete(wid)
        resolve({ ok: false, reason: 'node_failed', node_id: nodeId, error: errorMsg })
      }
    }
  }

  // ============================================================================
  // Node Spawn — Full daemon-flow for a single node (§10 compliant)
  // ============================================================================

  const spawnReadyNode = (
    workflowId: string,
    node: DAGNodeSession,
    outputMap?: Map<string, unknown>,
  ): Effect.Effect<void, never, never> => {
    let worktreeCleanup: (() => Promise<void>) | undefined

    // WP1-B: register node as not-yet-settled. Effect.ensuring sets it to true
    // when the node reaches any terminal state (clears the timeout).
    nodeSettledRegistry.set(node.node_id, false)
    const recoveryGenerationAtSpawn = recoveryGenerationRegistry.get(node.node_id) ?? 0

    // WP1-B: timeout state in closure scope so Effect.ensuring can access it.
    let nodeSettledFlag = false
    let nodeTimeoutId: ReturnType<typeof setTimeout> | undefined

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
      // P2-B: step-mode relaxation — when stepMode is active for this workflow,
      // spawn is allowed even under 'paused' (stepWorkflow is driving a single-node execution).
      if (wf && wf.status === 'paused' && !stepMode.has(workflowId)) {
        spawnedNodes.delete(node.node_id)
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
        // P2-B: resolve stepMode Deferred so stepWorkflow does not hang
        resolveStepFailed(workflowId, node.node_id, 'no promptOps configured for DAG node execution')
        return
      }

      // 1.5 WP-D2: Sub-DAG dispatch — short-circuit before agent resolution.
      // "dag" is a reserved worker_type (009-dag-capability-expansion.md §7 WP-D2).
      // Dispatch chain: extract subDagConfig → depth check → child session →
      // mark running → recursive bootstrapWorkflowFromConfig. On bootstrap failure,
      // mark node failed. On success, node stays running (WP-D3 lifecycle bridge).
      if (node.config.worker_type === "dag") {
        const subDagConfig = (node.config.worker_config as Record<string, unknown> | undefined)
          ?.subDagConfig as DAGConfig | undefined
        if (!subDagConfig || typeof subDagConfig !== "object" || !Array.isArray(subDagConfig.nodes)) {
          yield* sessionService.updateNodeStatus({
            sessionId: node.node_id,
            status: "failed",
            error: `worker_type="dag" requires valid worker_config.subDagConfig (DAGConfig)`,
          } satisfies UpdateNodeStatusInput).pipe(
            Effect.tapError((err) => Effect.logWarning(`[DAG] status update failed: ${err}`)),
            Effect.ignore,
          )
          resolveStepFailed(workflowId, node.node_id, `worker_type="dag" requires valid worker_config.subDagConfig (DAGConfig)`)
          return
        }

        // Verify depth limit (§3.3: MAX_SUB_DAG_DEPTH = 3)
        const parentWf = yield* sessionService.getWorkflow(workflowId)
        if (!parentWf) {
          yield* Effect.logDebug(`spawnReadyNode: workflow ${workflowId} gone, aborting sub-DAG spawn`)
          return
        }
        const parentDepth = ((parentWf.metadata as { depth?: number } | undefined)?.depth) ?? 0
        const childDepth = parentDepth + 1
        if (childDepth > MAX_SUB_DAG_DEPTH) {
          yield* sessionService.updateNodeStatus({
            sessionId: node.node_id,
            status: "failed",
            error: `recursion depth exceeded: depth ${childDepth} > max ${MAX_SUB_DAG_DEPTH}`,
          } satisfies UpdateNodeStatusInput).pipe(
            Effect.tapError((err) => Effect.logWarning(`[DAG] status update failed: ${err}`)),
            Effect.ignore,
          )
          yield* sessionService.createViolation({
            workflowId,
            nodeId: node.node_id,
            type: "subdag_depth_exceeded",
            severity: "error",
            message: `recursion depth exceeded: ${childDepth} > ${MAX_SUB_DAG_DEPTH}`,
            details: { depth: childDepth, max: MAX_SUB_DAG_DEPTH },
            chatSessionId: parentWf.chat_session_id,
          }).pipe(
            Effect.tapError((err) => Effect.logWarning(`[DAG] violation create failed: ${err}`)),
            Effect.ignore,
          )
          resolveStepFailed(workflowId, node.node_id, `recursion depth exceeded: depth ${childDepth} > max ${MAX_SUB_DAG_DEPTH}`)
          return
        }

        // Child session (INFO-5: same pattern as agent-type nodes)
        const subSessions = yield* Session.Service
        const subChildSession = yield* subSessions.create({
          parentID: parentWf.chat_session_id as SessionID,
          title: node.config.name + " (sub-DAG)",
        })

        // Mark running (WP-D2: stays running until WP-D3 event bridge signals)
        // The running-status DB write runs through Effect.result. If it fails
        // the node stays pending in DB — spawning a recursive child workflow
        // would orphan it (no parent-node completion signal would ever arrive).
        // Convert to handleSpawnFailure (pending → skipped + cascade). Any
        // subChildSession created above is left for the existing orphan-session
        // GC to collect (accepted graceful degradation).
        const subdagRunningResult = yield* sessionService.updateNodeStatus({
          sessionId: node.node_id,
          status: "running",
        } satisfies UpdateNodeStatusInput).pipe(Effect.result)

        if (Result.isFailure(subdagRunningResult)) {
          const failure = Result.getFailure(subdagRunningResult)
          const reason = failure._tag === 'Some' ? String(failure.value) : 'unknown error'
          yield* handleSpawnFailure({
            workflowId,
            nodeId: node.node_id,
            reason,
            executionPhase: 'subdag_running_write_failed',
            workflowChatSessionId: parentWf?.chat_session_id,
          })
          return
        }

        // WP-D3: Persist `chat_session_id` metadata on the "dag" node so that
        // the `cancelWorkflow` cascade path can locate the child workflow by
        // querying `listWorkflowsByChatSession(node.metadata.chat_session_id)`.
        // This mirrors the regular-node pattern at line ~900.
        if (sessionService.updateNodeMetadata) {
          yield* sessionService.updateNodeMetadata(node.node_id, {
            chat_session_id: subChildSession.id,
          }).pipe(
            Effect.tapError((err) => Effect.logWarning(`[DAG] dag-node metadata update failed: ${err}`)),
            Effect.ignore,
          )
        }

        // Agent service required by validateWorkerTypes in the sub-workflow bootstrap
        const subAgentService = yield* Agent.Service

        // Recursive bootstrap — wrapped in Effect.result for graceful failure handling
        const bootstrapEffect = bootstrapWorkflowFromConfig({
          dagConfig: subDagConfig,
          chatSessionId: subChildSession.id,
          promptOps: _promptOps!,
          dagSessionService: sessionService,
          agentService: subAgentService,
          parentWorkflowId: workflowId,
          parentNodeId: node.node_id,
          depth: childDepth,
        }).pipe(Effect.result)
        const bootstrapResult = yield* bootstrapEffect

        if (Result.isFailure(bootstrapResult)) {
          const bootstrapFailure = Result.getFailure(bootstrapResult)
          const errMsg = bootstrapFailure._tag === 'Some' ? String(bootstrapFailure.value) : 'unknown error'
          yield* sessionService.updateNodeStatus({
            sessionId: node.node_id,
            status: "failed",
            error: errMsg,
          } satisfies UpdateNodeStatusInput).pipe(
            Effect.tapError((err) => Effect.logWarning(`[DAG] status update failed: ${err}`)),
            Effect.ignore,
          )
          resolveStepFailed(workflowId, node.node_id, errMsg)
          return
        }
        // WP-D2: sub-DAG node stays in "running" state after bootstrap success.

        // WP-D3: Install the parent↔child lifecycle bridge. This subscribes to
        // the child workflow's terminal events and starts a timeout fallback.
        // If no EventBus is available (e.g. no SharedEventBus wired for this
        // process), the bridge is not installed — the parent node remains
        // running until process death (acceptable graceful degradation).
        const eventBus = getEventBus()
        if (eventBus) {
          // bootstrapResult is known-success here (failure path returned above)
          const childWorkflowId = (Result.getSuccess(bootstrapResult) as unknown as { workflowId: string }).workflowId
          // subDagConfig.timeout_ms takes precedence over global DEFAULT_SUB_DAG_TIMEOUT_MS (§7 WP-D3)
          const bridgeTimeoutMs = subDagConfig.timeout_ms ?? DEFAULT_SUB_DAG_TIMEOUT_MS
          installSubdagLifecycleBridge({
            parentWorkflowId: workflowId,
            parentNodeId: node.node_id,
            childWorkflowId,
            timeoutMs: bridgeTimeoutMs,
            eventBus,
            sessionService,
            onChildCompleted: (w, n, o) => handleNodeCompletion(w, n, o),
            onChildFailed: (w, n, e) => handleNodeFailure(w, n, e),
            onCancelChild: (id) => cancelWorkflow(id),
            onCreateViolation: (input) => sessionService.createViolation(input),
          })
        }

        return
      }

      // WP1-B: Node-level timeout fiber (kill switch).
      // Uses setTimeout + Deferred (mirrors installSubdagLifecycleBridge pattern).
      // The timeout fires a violation + marks node failed.
      // nodeSettled Deferred is resolved in Effect.ensuring (ALL exit paths),
      // WP1-B: Uses setTimeout + cleared in Effect.ensuring (mirrors installSubdagLifecycleBridge pattern).
      // The timeout fires a violation + marks node failed.
      // nodeSettledFlag is set to true in Effect.ensuring (ALL exit paths),
      // which also clears the timeout timer so stale firing is prevented.
      // Only active for non-dag nodes (dag nodes use installSubdagLifecycleBridge timeout).
      //
      // §2.2 timeout_policy: 当 timeout_policy === 'notify' 时，超时不调用
      // handleNodeFailure。节点保持 running，仅记录违规 + 向 child session
      // 注入通知消息，由 agent 自主决定后续走向。
      //
      // §4.1 I1: timeout_ms / timeout_policy 缺省时回退到 Config.dag.default_*。
      // best-effort 读 Config.Service；服务不可用或字段缺失 → 回退硬编码默认。
      const dagDefaults = yield* readDagDefaultsFromService()
      const nodeTimeoutMs = node.config.timeout_ms ?? dagDefaults.defaultNodeTimeoutMs
      const nodeTimeoutPolicy = (node.config.timeout_policy as 'fail' | 'notify' | undefined)
        ?? dagDefaults.defaultTimeoutPolicy
        ?? 'fail'

      if (nodeTimeoutMs) {
        nodeTimeoutId = setTimeout(() => {
          if (nodeSettledFlag) return // Already settled, don't fire
          Effect.runPromise(
            Effect.gen(function* () {
              // Check node state first
              const currentForTimeout = yield* sessionService.getNode(node.node_id).pipe(
                Effect.catchCause(() => Effect.succeed(undefined as DAGNodeSession | undefined)),
              )
              if (currentForTimeout && (currentForTimeout.status === "running" || currentForTimeout.status === "pending")) {
                if (nodeTimeoutPolicy === 'notify') {
                  // §2.2 notify 策略：保持 running，不调用 handleNodeFailure。
                  // 1. 记录 timeout_exceeded 违规（审计）
                  yield* sessionService.createViolation({
                    workflowId,
                    nodeId: node.node_id,
                    type: "timeout_exceeded",
                    severity: "warning",
                    message: `node exceeded timeout_ms=${nodeTimeoutMs} (timeout_policy='notify', node kept running)`,
                    details: { timeout_ms: nodeTimeoutMs, timeout_policy: 'notify' },
                  }).pipe(
                    Effect.tapError((err: unknown) => Effect.logWarning(`[DAG] notify-timeout violation create failed for ${node.node_id}: ${err}`)),
                    Effect.ignore,
                  )
                  // 2. 向 child session 注入超时通知消息，agent 自主决定后续。
                  //    metadata.chat_session_id 已在 spawnReadyNode L756-773 持久化。
                  const childSessionId = (currentForTimeout.metadata as Record<string, unknown> | undefined)?.chat_session_id as string | undefined
                  const wfForNotify = yield* sessionService.getWorkflow(workflowId).pipe(
                    Effect.catchCause(() => Effect.succeed(undefined)),
                  )
                  if (childSessionId && wfForNotify && _promptOps) {
                    const timeoutNotice = [
                      `<dag_node_timeout node_id="${node.node_id}" timeout_ms="${nodeTimeoutMs}">`,
                      `Node "${node.config.name}" has exceeded its configured timeout of ${nodeTimeoutMs}ms.`,
                      `The timeout_policy is set to 'notify', so the node remains running and you retain full control.`,
                      `You MUST eventually settle this node by calling node_complete (the engine marks a node failed if its turn ends without node_complete).`,
                      `You can now decide:`,
                      `  - Continue working, then call node_complete with status='completed' when done`,
                      `  - Call node_complete with status='failed' if you cannot complete`,
                      `  - Continue working if you estimate you are close to done (the timeout is advisory)`,
                      `</dag_node_timeout>`,
                    ].join("\n")
                    yield* _promptOps.prompt({
                      sessionID: childSessionId as SessionID,
                      noReply: true,
                      agent: node.config.worker_type,
                      parts: [{
                        type: "text",
                        synthetic: true,
                        text: timeoutNotice,
                        metadata: {
                          dag_node_timeout: true,
                          dag_node_id: node.node_id,
                          dag_workflow_id: workflowId,
                          dag_timeout_ms: nodeTimeoutMs,
                        },
                      }],
                    }).pipe(
                      Effect.tapError((err: unknown) => Effect.logWarning(`[DAG] notify-timeout message injection failed for ${node.node_id}: ${err}`)),
                      Effect.ignore,
                    )
                  }
                  // 3. 审计日志
                  if (wfForNotify?.chat_session_id) {
                    yield* safeAppendLog({
                      nodeId: node.node_id,
                      workflowId,
                      chatSessionId: wfForNotify.chat_session_id,
                      logLevel: 'warn',
                      logMessage: `Node timeout (notify policy): ${node.node_id} exceeded timeout_ms=${nodeTimeoutMs}, kept running, agent notified`,
                      executionPhase: 'timeout_notify',
                      logData: { timeout_ms: nodeTimeoutMs, timeout_policy: 'notify' },
                    })
                  }
                  // 节点保持 running，不调用 handleNodeFailure。
                  // agent 的 prompt fiber 仍在运行，收到通知后自主决定。
                } else {
                  // 默认 'fail' 策略：当前行为——handleNodeFailure 创建违规 + cascade + finalize。
                  yield* handleNodeFailure(workflowId, node.node_id, new Error(`node exceeded timeout_ms=${nodeTimeoutMs}`))
                    .pipe(
                      Effect.tapError((err: unknown) => Effect.logWarning(`[DAG] handleNodeFailure from timeout failed for ${node.node_id}: ${err}`)),
                      Effect.ignore,
                    )
                }
              } else if (currentForTimeout && (currentForTimeout.status === "failed" || currentForTimeout.status === "skipped")) {
                // Node already failed/skipped (retry exhaustion handled it). Supplementary
                // timeout_exceeded audit record only — no status change, no cascade.
                yield* sessionService.createViolation({
                  workflowId,
                  nodeId: node.node_id,
                  type: "timeout_exceeded",
                  severity: "error",
                  message: `node exceeded timeout_ms=${nodeTimeoutMs}`,
                  details: { timeout_ms: nodeTimeoutMs },
                }).pipe(
                  Effect.tapError((err: unknown) => Effect.logWarning(`[DAG] timeout violation create failed for ${node.node_id}: ${err}`)),
                  Effect.ignore,
                )
              } else {
                // Node is 'completed' — stale timer after node_complete succeeded.
                // Suppress the noise violation; no audit record needed.
              }
            }).pipe(Effect.ignore),
          )
        }, nodeTimeoutMs)
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
        // P2-B: resolve stepMode Deferred so stepWorkflow does not hang
        resolveStepFailed(workflowId, node.node_id, `unknown worker_type: ${node.config.worker_type}`)
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
            // P2-B: resolve stepMode Deferred so stepWorkflow does not hang
            resolveStepFailed(workflowId, node.node_id, 'worktree creation failed')
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
      // The running-status DB write runs through Effect.result so a failure can
      // be handled explicitly rather than silently swallowed by Effect.ignore.
      // If this write fails the node is still `pending` in DB — dispatching a
      // child agent prompt at that point would leave the node permanently stuck
      // (state machine rejects `pending → completed` on the eventual node_complete
      // callback). Convert to handleSpawnFailure (pending → skipped + cascade).
      const runningWriteResult = yield* sessionService.updateNodeStatus({
        sessionId: node.node_id,
        status: 'running'
      } satisfies UpdateNodeStatusInput).pipe(Effect.result)

      if (Result.isFailure(runningWriteResult)) {
        const failure = Result.getFailure(runningWriteResult)
        const reason = failure._tag === 'Some' ? String(failure.value) : 'unknown error'
        yield* handleSpawnFailure({
          workflowId,
          nodeId: node.node_id,
          reason,
          executionPhase: 'running_status_write_failed',
          workflowChatSessionId: workflow.chat_session_id,
        })
        return
      }

      // #5 running
      yield* safeAppendLog({
        nodeId: node.node_id,
        workflowId,
        chatSessionId: workflow.chat_session_id,
        logLevel: 'info',
        logMessage: `Node status set to running: ${node.node_id}`,
        executionPhase: 'running',
      })

      // 5.5 WP-C2: Collect upstream outputs for input_mapping (pure, read-only).
      // `outputMap` is provided by scheduleReadyNodes via buildOutputMap(allNodes).
      const collectedInputData = collectInputMapping(
        node.config.input_mapping,
        outputMap ?? new Map(),
        node.config.dependencies,
      )

      // 5.6 WP-C3: Inject collected upstream data into prompt block (pure, sync).
      // The injection is additive: the block is inserted after DAG instructions
      // and before `Your task:` — the original worker_config.prompt is never replaced.
      const injectResult = injectCollectedDataToPrompt(collectedInputData)

      if (injectResult.injected || injectResult.audit.length > 0) {
        yield* safeAppendLog({
          nodeId: node.node_id,
          workflowId,
          chatSessionId: workflow.chat_session_id,
          logLevel: 'info',
          logMessage: `Input injection: ${injectResult.audit.filter((a) => a.status === "injected").length}/${injectResult.audit.length} entries injected for node ${node.node_id}`,
          executionPhase: 'input_injected',
          logData: {
            audit: injectResult.audit,
            injectedCount: injectResult.audit.filter((a) => a.status === "injected").length,
          },
        })
      }

      // 6. Prepend DAG node instructions + run prompt with timeout and retry
      const promptInstruction = [
        `You are executing a DAG node. Node ID: ${node.node_id}.`,
        `When you have finished your work, you MUST call the \`node_complete\` tool EXACTLY ONCE with your result.`,
        `Use status='completed' and output for success. Use status='failed' and error for fatal errors.`,
        `If you do not call node_complete, the node will be marked failed.`,
        ``,
        ...(injectResult.injected && injectResult.injectionBlock.length > 0
          ? [...injectResult.injectionBlock, '']
          : []),
        `Your task:`,
        (node.config.worker_config?.prompt ?? ''),
      ].join("\n")

      const parts = yield* _promptOps.resolvePromptParts(promptInstruction)

      // Resolve optional model override. Priority (highest first):
      //   1. worker_config.model_level → looked up in Config.dag.model_levels (§4.2)
      //   2. worker_config.model ("providerID/modelID")
      // Both are optional; absent → agent default model.
      const modelOverride = yield* resolveNodeModel(node.config.worker_config)

      // T1+T2: Retry loop with timeout enforcement
      const maxRetries = node.max_retries ?? 0
      let attempt = 0
      let promptSuccess = false

      while (attempt <= maxRetries && !promptSuccess) {
        if (attempt > 0) {
          // C1 fix: implement retry.delay_ms (was a dead field — declared in
          // types.ts but never consumed). Sleep before retry to avoid hammering
          // the LLM provider on transient errors. Configured via
          // node.config.retry.delay_ms; default 0 preserves backward-compatible
          // immediate retry when delay_ms is unset.
          const retryDelayMs = node.config.retry?.delay_ms ?? 0
          if (retryDelayMs > 0) {
            yield* Effect.sleep(retryDelayMs)
          }
          yield* sessionService.incrementRetryCount(node.node_id).pipe(
            Effect.tapError((err) => Effect.logWarning(`[DAG] incrementRetryCount failed: ${err}`)),
            Effect.ignore
          )
          yield* Effect.logWarning(`[DAG] retrying node ${node.node_id}, attempt ${attempt + 1}/${maxRetries + 1}${retryDelayMs > 0 ? ` (after ${retryDelayMs}ms delay)` : ""}`)
          // #7 retry_attempt
          yield* safeAppendLog({
            nodeId: node.node_id,
            workflowId,
            chatSessionId: workflow.chat_session_id,
            logLevel: 'debug',
            logMessage: `Retry attempt ${attempt + 1}/${maxRetries + 1} for node ${node.node_id}${retryDelayMs > 0 ? ` (after ${retryDelayMs}ms delay)` : ""}`,
            executionPhase: 'retry_attempt',
            logData: { attempt: attempt + 1, max_retries: maxRetries, delay_ms: retryDelayMs },
          })
        }
        
        const timeoutMs = nodeTimeoutMs ?? DEFAULT_NODE_TIMEOUT_MS
        // §2.2 timeout_policy: 当为 'notify' 时，prompt 不应用 timeoutOrElse。
        // 超时由 nodeTimeoutMs 的 setTimeout 处理（仅通知，不 fail prompt）。
        // agent 的 prompt fiber 持续运行，收到超时通知后自主决定是否结束。
        // #6 prompt_started
        yield* safeAppendLog({
          nodeId: node.node_id,
          workflowId,
          chatSessionId: workflow.chat_session_id,
          logLevel: 'info',
          logMessage: `Prompt started for node ${node.node_id}, attempt ${attempt + 1}`,
          executionPhase: 'prompt_started',
          logData: { attempt: attempt + 1, timeout_ms: timeoutMs, timeout_policy: nodeTimeoutPolicy },
        })
        const promptEffect = _promptOps.prompt({
          sessionID: childSession.id,
          messageID: MessageID.ascending(),
          agent: agent.name,
          ...(modelOverride ? { model: modelOverride } : {}),
          parts,
        })

        const result = yield* (nodeTimeoutPolicy === 'notify'
          ? promptEffect.pipe(Effect.result)
          : promptEffect.pipe(
              Effect.timeoutOrElse({
                duration: timeoutMs,
                orElse: () => Effect.fail(new Error(`node timed out after ${timeoutMs}ms`))
              }),
              Effect.result,
            )
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
            // BUGFIX: retry exhaustion must drive DAG convergence.
            // handleNodeFailure is now idempotent (safe even if timer already marked
            // failed): it skips updateNodeStatus + createViolation on already-terminal
            // nodes, but still runs cascadeSkipDownstream + scheduleReadyNodes +
            // maybeFinalizeWorkflow — exactly what we need.
            yield* handleNodeFailure(workflowId, node.node_id, new Error(errMsg))
              .pipe(
                Effect.tapError((err: unknown) => Effect.logWarning(`[DAG] handleNodeFailure on retry exhaustion failed for ${node.node_id}: ${err}`)),
                Effect.ignore,
              )
          }
        }
      }

      // 7. Post-prompt: if node still 'running' (subagent never called node_complete)
      // WP1-C: Post-prompt guard — if timeout fiber already marked node failed,
      // skip node_complete_missing check (prevents double status transitions).
      const postPromptNode = yield* sessionService.getNode(node.node_id).pipe(
        Effect.catchCause(() => Effect.succeed(undefined as DAGNodeSession | undefined)),
      )
      if (hasNodeRecoveredSinceSpawn(node.node_id, recoveryGenerationAtSpawn)) {
        return
      }
      if (postPromptNode?.status === "failed") {
        // Timeout fiber (or other mechanism) already marked node failed.
        // Skip node_complete_missing logic to avoid duplicate transitions.
        return
      }
      if (postPromptNode?.status === 'running') {
        // FIX: Use handleNodeFailure instead of direct status write.
        // This ensures:
        //   1. failure_handler diagnosis triggers (if configured)
        //   2. cascade skip downstream fires
        //   3. maybeFinalizeWorkflow is called
        //   4. violation is created
        //   5. scheduleReadyNodes is triggered
        // Without this, nodes that forget to call node_complete get stuck
        // in 'running' forever with no recovery path (v13 proxy-core bug).
        yield* handleNodeFailure(
          workflowId,
          node.node_id,
          new Error('node did not call node_complete tool'),
        ).pipe(
          Effect.tapError((err: unknown) =>
            Effect.logWarning(`[DAG] handleNodeFailure on node_complete_missing failed for ${node.node_id}: ${err}`),
          ),
          Effect.ignore,
        )
        // #10 node_complete_missing (supplementary log - handleNodeFailure also logs the failure)
        yield* safeAppendLog({
          nodeId: node.node_id,
          workflowId,
          chatSessionId: workflow.chat_session_id,
          logLevel: 'warn',
          logMessage: `Node did not call node_complete tool: ${node.node_id} (routed through handleNodeFailure for full DAG semantics)`,
          executionPhase: 'node_complete_missing',
        })
      }
    }).pipe(
      Effect.ensuring(
        // WP1-B: signal node-settled on ALL exit paths.
        // Sets the settled flag (prevents stale timeout from firing) +
        // clears the timeout timer (no leak) + removes from settled registry.
        Effect.sync(() => {
          nodeSettledFlag = true
          if (nodeTimeoutId !== undefined) clearTimeout(nodeTimeoutId)
          nodeSettledRegistry.delete(node.node_id)
          if (worktreeCleanup) {
            worktreeCleanup().catch((err) => log.warn("[DAG] worktree cleanup failed", { err }))
          }
        }),
      ),
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
            // P2-B: resolve stepMode Deferred so stepWorkflow does not hang
            resolveStepFailed(workflowId, node.node_id, `spawn failed: ${errMsg}`)
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
   * 级联 skip：将 triggerNodeId 所有下游 pending 节点标记为 skipped。
   * pending→skipped 是合法转移（session-service.ts:70）。
   * buildSessionNodeEvent 含 node.skipped case（铁律#3）。
   *
   * triggerType 区分触发源：
   * - "upstream_failure" — 上游节点执行失败（handleNodeFailure 调用）
   * - "condition_false" — 上游节点条件求值为假（WP-B3 scheduleReadyNodes 调用）
   * 差异化体现在 logMessage 和 logData.trigger_type（审计区分）。
   */
  const cascadeSkipDownstream = (
    workflowId: string,
    triggerNodeId: string,
    triggerType: "upstream_failure" | "condition_false" = "upstream_failure",
  ): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      const wfForLog = yield* sessionService.getWorkflow(workflowId)
      const allNodes = yield* sessionService.listNodes(workflowId)
      const descendants = findPendingDescendants(allNodes, triggerNodeId)
      const triggerLabel = triggerType === "condition_false" ? "condition skip" : "failure"
      for (const d of descendants) {
        yield* sessionService.updateNodeStatus({
          sessionId: d.node_id,
          status: 'skipped',
          upstreamFailedNode: triggerNodeId,
        } satisfies UpdateNodeStatusInput).pipe(
          Effect.tapError((err) => Effect.logWarning(`[DAG] cascade-skip status update failed for ${d.node_id}: ${err}`)),
          Effect.ignore
        )
        // WP2 audit: if cascade-skipped descendant is required:true, record a
        // required_node_skipped violation (severity=error). This is AUDIT-ONLY —
        // computeFinalWorkflowStatus is unchanged (iron law #2: terminal-irreversibility;
        // required SKIPPED is not a workflow-failure trigger, see required-nodes-monitor.ts:172-173).
        if (d.config.required === true) {
          yield* sessionService.createViolation({
            workflowId,
            nodeId: d.node_id,
            type: 'required_node_skipped' as DAGViolationType,
            severity: 'error',
            message: `Required node ${d.node_id} cascade-skipped due to ${triggerLabel} of ${triggerNodeId}`,
            details: { trigger_node_id: triggerNodeId, trigger_type: triggerType },
            chatSessionId: wfForLog?.chat_session_id,
          } satisfies CreateViolationInput).pipe(
            Effect.tapError((err) => Effect.logWarning(`[DAG] required-skip violation record failed for ${d.node_id}: ${err}`)),
            Effect.ignore
          )
        }
        // #13 cascade_skip
        if (wfForLog?.chat_session_id) {
          yield* safeAppendLog({
            nodeId: d.node_id,
            workflowId,
            chatSessionId: wfForLog.chat_session_id,
            logLevel: 'warn',
            logMessage: `Cascade skip: ${d.node_id} skipped due to ${triggerLabel} of ${triggerNodeId}`,
            executionPhase: 'cascade_skip',
            logData: { trigger_node_id: triggerNodeId, trigger_type: triggerType },
          })
        }
      }
    }).pipe(Effect.catchCause((cause) => Effect.logWarning(`[DAG] cascadeSkipDownstream(${workflowId}, ${triggerNodeId}, ${triggerType}) failed: ${Cause.squash(cause)}`)))

  /**
   * 检测所有节点是否已进入终态，若是则收敛 workflow.status。
   * workflow 收敛决策由 computeFinalWorkflowStatus (execution-core) 提供。
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
      const targetStatus = computeFinalWorkflowStatus(allNodes)
      if (!targetStatus) return

      yield* sessionService.updateWorkflowStatus(workflowId, targetStatus)

      // WP1: Notify parent session when DAG workflow converges to failed.
      // Placed AFTER updateWorkflowStatus (persist + EventBus emit) so the
      // four iron laws (state machine + terminal irreversibility + event
      // broadcast + persist-first) are fully honored before any best-effort
      // side-effect. maybeFinalizeWorkflow's terminal guard above prevents
      // double-notification under concurrent convergence.
      if (targetStatus === "failed" && workflow.chat_session_id) {
        const failedNodeIds = allNodes
          .filter((n: DAGNodeSession) => n.status === "failed")
          .map((n: DAGNodeSession) => n.node_id)
        yield* notifyParentOfFailure({
          workflowId,
          chatSessionId: workflow.chat_session_id,
          failedNodes: failedNodeIds,
        })
      }

      // B3: Symmetric notification on successful completion. Previously only
      // failure emitted a synthetic message to the parent session, forcing
      // users (and the parent LLM agent) to poll status to learn that a DAG
      // finished. Now completion is announced too, mirroring notifyParentOfFailure.
      if (targetStatus === "completed" && workflow.chat_session_id) {
        const completedNodeCount = allNodes.filter(
          (n: DAGNodeSession) => n.status === "completed",
        ).length
        yield* notifyParentOfCompletion({
          workflowId,
          chatSessionId: workflow.chat_session_id,
          completedNodeCount,
          totalNodeCount: allNodes.length,
        })
      }
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
      const workflow = yield* sessionService.getWorkflow(workflowId)
      if (workflow?.status === 'paused' && !stepMode.has(workflowId)) return { scheduled: 0 }
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

      // WP-B2: Condition evaluation split — pure function, no side effects.
      // Nodes whose conditions are false go to skipCandidates.
      // Nodes without conditions (undefined/null) remain in executeList (backward compatible).
      const outputMap = buildOutputMap(allNodes)
      const { executeList, skipCandidates } = splitByCondition(readyNodes, outputMap)

      // WP-B3: Consume skipCandidates — condition-false nodes and their downstream.
      // Must run BEFORE spawn loop to prevent pending→running→skipped race
      // (running→skipped is not a valid transition in the state machine).
      const wfForSkipLog = skipCandidates.length > 0
        ? yield* sessionService.getWorkflow(workflowId)
        : undefined
      for (const skipNode of skipCandidates) {
        // 1. State machine: pending → skipped (iron law #1, not bypassed)
        yield* sessionService.updateNodeStatus({
          sessionId: skipNode.node_id,
          status: 'skipped',
        } satisfies UpdateNodeStatusInput).pipe(
          Effect.tapError((err) => Effect.logWarning(`[DAG] condition-skip status update failed for ${skipNode.node_id}: ${err}`)),
          Effect.ignore
        )

        // 2. Audit: violation record with condition_skipped type + condition details
        //    D1 fix: include runtime evaluation context (ref_node actual output
        //    snapshot + extracted value) so users can see WHY the condition was
        //    false, not just the config. Previously details only had the
        //    condition config, forcing users to cross-reference node_log to
        //    diagnose why a node was skipped.
        const skipCond = skipNode.config.condition
        const refNodeOutput = skipCond ? outputMap.get(skipCond.ref_node) : undefined
        yield* sessionService.createViolation({
          workflowId,
          nodeId: skipNode.node_id,
          type: 'condition_skipped' as DAGViolationType,
          severity: 'warning',
          message: `Condition evaluated to false: ${skipNode.node_id} skipped`,
          details: {
            trigger: 'condition_false',
            condition: skipNode.config.condition,
            // D1: runtime evaluation snapshot for diagnosis
            ref_node_id: skipCond?.ref_node,
            ref_node_output: truncateForAudit(refNodeOutput),
            declared_value: skipCond?.value,
            evaluated_result: false,
          },
          chatSessionId: wfForSkipLog?.chat_session_id,
        }).pipe(
          Effect.tapError((err) => Effect.logWarning(`[DAG] condition-skip violation failed for ${skipNode.node_id}: ${err}`)),
          Effect.ignore
        )

        // 3. Audit: node log with condition_skip executionPhase
        if (wfForSkipLog?.chat_session_id) {
          yield* safeAppendLog({
            nodeId: skipNode.node_id,
            workflowId,
            chatSessionId: wfForSkipLog.chat_session_id,
            logLevel: 'warn',
            logMessage: `Condition false: ${skipNode.node_id} skipped (ref=${skipNode.config.condition?.ref_node}, op=${skipNode.config.condition?.op})`,
            executionPhase: 'condition_skip',
            logData: { condition: skipNode.config.condition },
          })
        }

        // 4. Cascade: skip downstream pending nodes (reuses findPendingDescendants BFS, iron law #6)
        yield* cascadeSkipDownstream(workflowId, skipNode.node_id, "condition_false")
      }

      // T3: Enforce concurrency cap — account for in-flight spawned nodes (spawned but not yet settled)
      const inFlightCount = [...spawnedNodes]
        .filter(id => id.startsWith(`${workflowId}::`))
        .filter(id => !runningNodeIds.has(id) && !completedNodeIds.has(id) && !failedNodeIds.has(id) && !skippedNodeIds.has(id))
        .length
      const maxConcurrency = concurrencyRegistry.get(workflowId) ?? MAX_CONCURRENCY
      const budget = computeSpawnBudget(maxConcurrency, runningNodeIds.size, inFlightCount)
      if (budget <= 0) {
        // No spawn budget, but if skips occurred, check for workflow convergence
        if (skipCandidates.length > 0) {
          yield* maybeFinalizeWorkflow(workflowId)
        }
        return { scheduled: 0 }
      }

      const limit = Math.min(executeList.length, budget)
      let scheduled = 0
      for (let i = 0; i < limit; i++) {
        const node = executeList[i]
        if (!spawnedNodes.has(node.node_id)) {
          spawnedNodes.add(node.node_id)
          yield* spawnReadyNode(workflowId, node, outputMap).pipe(Effect.forkDetach)
          scheduled++
        }
      }

      // WP-B3: After skip + spawn, check workflow convergence.
      // If all ready nodes were condition-skipped (executeList empty) and downstream
      // nodes are in terminal states, the workflow should converge immediately.
      if (skipCandidates.length > 0) {
        yield* maybeFinalizeWorkflow(workflowId)
      }

      return { scheduled }
    }) as Effect.Effect<{ scheduled: number }, never>

  /**
   * 处理节点完成
   */
  const handleNodeCompletion: WorkflowEngine['handleNodeCompletion'] = (workflowId, nodeId, output) =>
    Effect.gen(function* () {
      // WP-D3: If this node is a sub-DAG bridge node, drop its event
      // subscriptions before any state change (cleanup covers the direct-call
      // path — the bridge callback path has its own `settle()` guard).
      cleanupSubscriptions(nodeId)

      // 1. 更新节点状态
      yield* sessionService.updateNodeStatus({
        sessionId: nodeId,
        status: 'completed',
        outputData: output
      })
      recoveryGenerationRegistry.delete(nodeId)

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
      
      // 2. P2-B: stepMode guard (WARN-1) — under step mode, resolve the Deferred
      //    with ok:true and skip scheduleReadyNodes + maybeFinalize. The Deferred
      //    callback drives the stepWorkflow awaiter back to control.
      if (stepMode.has(workflowId)) {
        const resolve = stepResolve.get(workflowId)
        if (resolve) {
          stepResolve.delete(workflowId)
          resolve({ ok: true, node_id: nodeId, status: 'completed', output })
        }
        return { success: true }
      }

      // 2b. Schedule next batch of ready nodes (normal path, not under stepMode)
      yield* scheduleReadyNodes(workflowId)

      // 3. Workflow terminal convergence
      yield* maybeFinalizeWorkflow(workflowId)
      
      return { success: true }
    })

  /**
   * handleSpawnFailure — spawn-phase failure handler for nodes that are still
   * in `pending` (or `queued`) state in DB at the moment the running-status
   * DB write fails inside spawnReadyNode.
   *
   * Cannot reuse handleNodeFailure (which hardcodes a transition to `failed`
   * on nodes that may still be `running` — A-layer state machine rejects
   * `pending → failed` outright, see execution-core.ts getValidNextSessionNodeStatuses).
   * Instead drives the only legal terminal transition from pending: pending→skipped
   * (iron law #1, execution-core L382-383).
   *
   * Design contract:
   * - Caller has already observed running-status DB write failure inside spawnReadyNode
   * - Node is pending or queued in DB on entry (or state machine rejects the skip)
   * - Best-effort: every internal write is independently protected by catchCause
   *   so cascade / finalize / stepMode release always run even when one write errors
   * - Not exported. Module-internal helper used only within this closure.
   */
  const handleSpawnFailure = (input: {
    workflowId: string
    nodeId: string
    reason: string
    executionPhase: 'running_status_write_failed' | 'subdag_running_write_failed'
    workflowChatSessionId?: string
  }): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      const { nodeId, workflowId, reason, executionPhase } = input

      // 1. Audit log (best-effort — failure does not block cascade/finalize)
      if (input.workflowChatSessionId) {
        yield* safeAppendLog({
          nodeId,
          workflowId,
          chatSessionId: input.workflowChatSessionId,
          logLevel: 'error',
          logMessage: `Node spawn failure (running write failed): ${nodeId} — ${reason}`,
          executionPhase,
          logData: { error: reason },
        })
      }

      // 2. Violation record (best-effort, typed as execution_failed so existing
      //    query surfaces treat it uniformly with runtime execution failures)
      if (input.workflowChatSessionId) {
        yield* sessionService.createViolation({
          workflowId,
          nodeId,
          type: 'execution_failed',
          severity: 'error',
          message: `Spawn failure: ${reason}`,
          chatSessionId: input.workflowChatSessionId,
        } satisfies CreateViolationInput).pipe(Effect.catchCause(() => Effect.void))
      }

      // 3. State machine: pending/queued → skipped (the only legal pending-terminal
      //    transition per A-layer execution-core).
      yield* sessionService.updateNodeStatus({
        sessionId: nodeId,
        status: 'skipped',
      } satisfies UpdateNodeStatusInput).pipe(
        Effect.tapError((err: unknown) =>
          Effect.logWarning(`[DAG] spawn-failure skip update failed for ${nodeId}: ${err}`),
        ),
        Effect.catchCause(() => Effect.void),
      )

      // 4. Cleanup spawnedNodes (defensive — prevents stale entries from
      //    permanently blocking re-spawn through this path).
      spawnedNodes.delete(nodeId)

      // 5. Cascade skip all downstream pending nodes (same semantics as
      //    handleNodeFailure's cascade step — "upstream_failure" trigger type).
      yield* cascadeSkipDownstream(workflowId, nodeId, 'upstream_failure')

      // 6. P2-B: stepMode Deferred release. Mirrors handleNodeFailure L1507-1513.
      //    Under stepMode: resolve Deferred with ok:false:node_failed and skip
      //    finalize (workflow stays paused). stepWorkflow's Effect.ensuring
      //    handles stepMode + stepResolve table cleanup on its own.
      if (stepMode.has(workflowId)) {
        const resolve = stepResolve.get(workflowId)
        if (resolve) {
          stepResolve.delete(workflowId)
          resolve({
            ok: false,
            reason: 'node_failed',
            node_id: nodeId,
            error: `spawn failure: ${reason}`,
          })
        }
        return
      }

      // 7. Re-schedule independent branches that may now fit within the
      //    concurrency budget (released slot from spawnedNodes.delete above).
      //    Mirrors handleNodeFailure L1646. Without this, a spawn-failure on one
      //    of the initial batch (max_concurrency < ready_count) leaves sibling
      //    pending nodes permanently un-dispatched — workflow stuck running.
      yield* scheduleReadyNodes(workflowId)

      // 8. Workflow convergence (non-step path)
      yield* maybeFinalizeWorkflow(workflowId)
    }).pipe(Effect.catchCause(() => Effect.void))

  /**
   * notifyParentOfFailure — DAG workflow 失败时通知父 session。
   *
   * Wake strategy:
   * - busy: 仅注入消息到 history（不打断用户 turn）
   * - idle: 注入消息 + ops.loop 唤醒主 LLM session 主动回应
   *
   * Best-effort: 任何内部失败静默忽略，避免影响 DAG engine。
   * 必须在 maybeFinalizeWorkflow 内 targetStatus === "failed" 成功后调用。
   * 由 maybeFinalizeWorkflow 现有 terminal guard 保证幂等。
   *
   * Not exported — module-internal helper (closure-scoped to make()).
   */
  const notifyParentOfFailure = (input: {
    workflowId: string
    chatSessionId: string
    failedNodes: readonly string[]
  }): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      if (!capturedSessionStatus || !_promptOps) return

      const parentSessionID = input.chatSessionId as SessionID
      const parentStatus = yield* capturedSessionStatus.get(parentSessionID).pipe(
        Effect.catchCause(() => Effect.succeed({ type: "busy" } as const as SessionStatus.Info)),
      )

      const text = [
        `<dag_workflow_failed workflow_id="${input.workflowId}">`,
        `DAG workflow ${input.workflowId} has failed.`,
        `Failed nodes: ${input.failedNodes.join(", ") || "unknown"}`,
        `Use dagworker status/node_detail/logs to inspect, or replan for partial recovery.`,
        `</dag_workflow_failed>`,
      ].join("\n")

      // 1. Inject synthetic message into parent session history (noReply: true
      // prevents the prompt from triggering an LLM turn — injection only).
      yield* _promptOps.prompt({
        sessionID: parentSessionID,
        noReply: true,
        agent: "main",
        parts: [{
          type: "text",
          synthetic: true,
          text,
          metadata: {
            dag_workflow_id: input.workflowId,
            dag_event: "workflow_failed",
            dag_failed_nodes: [...input.failedNodes],
            dag_reason: "terminal_failure",
            dag_trigger_reason: "exec_failed",
          },
        }],
      }).pipe(Effect.ignore)

      // 2. Only wake the parent when it's idle (no active user turn to interrupt).
      if (parentStatus.type === "idle") {
        yield* _promptOps.loop({ sessionID: parentSessionID })
          .pipe(Effect.forkDetach, Effect.ignore)
      }
    }).pipe(Effect.catchCause(() => Effect.void))

  /**
   * notifyParentOfCompletion — DAG workflow 成功完成时通知父 session。
   *
   * 对称于 notifyParentOfFailure（B3 修复：消除成功/失败通知不对称）。
   *
   * Wake strategy（与 notifyParentOfFailure 一致）:
   * - busy: 仅注入消息到 history（不打断用户 turn）
   * - idle: 注入消息 + ops.loop 唤醒主 LLM session 主动回应
   *
   * Best-effort: 任何内部失败静默忽略，避免影响 DAG engine。
   * 必须在 maybeFinalizeWorkflow 内 targetStatus === "completed" 成功后调用。
   * 由 maybeFinalizeWorkflow 现有 terminal guard 保证幂等。
   *
   * Not exported — module-internal helper (closure-scoped to make()).
   */
  const notifyParentOfCompletion = (input: {
    workflowId: string
    chatSessionId: string
    completedNodeCount: number
    totalNodeCount: number
  }): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      if (!capturedSessionStatus || !_promptOps) return

      const parentSessionID = input.chatSessionId as SessionID
      const parentStatus = yield* capturedSessionStatus.get(parentSessionID).pipe(
        Effect.catchCause(() => Effect.succeed({ type: "busy" } as const as SessionStatus.Info)),
      )

      const text = [
        `<dag_workflow_completed workflow_id="${input.workflowId}">`,
        `DAG workflow ${input.workflowId} has completed successfully.`,
        `Completed nodes: ${input.completedNodeCount}/${input.totalNodeCount}`,
        `Use dagworker status or node_detail to inspect outputs of any node.`,
        `</dag_workflow_completed>`,
      ].join("\n")

      // 1. Inject synthetic message into parent session history (noReply: true).
      yield* _promptOps.prompt({
        sessionID: parentSessionID,
        noReply: true,
        agent: "main",
        parts: [{
          type: "text",
          synthetic: true,
          text,
          metadata: {
            dag_workflow_id: input.workflowId,
            dag_event: "workflow_completed",
            dag_completed_nodes: input.completedNodeCount,
            dag_total_nodes: input.totalNodeCount,
            dag_reason: "terminal_success",
          },
        }],
      }).pipe(Effect.ignore)

      // 2. Only wake the parent when it's idle (no active user turn to interrupt).
      if (parentStatus.type === "idle") {
        yield* _promptOps.loop({ sessionID: parentSessionID })
          .pipe(Effect.forkDetach, Effect.ignore)
      }
    }).pipe(Effect.catchCause(() => Effect.void))

  /**
   * 处理节点失败
   */
  const handleNodeFailure: WorkflowEngine['handleNodeFailure'] = (workflowId, nodeId, error) =>
    Effect.gen(function* () {
      // WP-D3: If this node is a sub-DAG bridge node, drop its event
      // subscriptions before any state change (same pattern as handleNodeCompletion).
      cleanupSubscriptions(nodeId)

      // Idempotency guard: if the node is already terminal (e.g. timeout fiber
      // already marked failed before retry exhaustion / bridge callback fires),
      // skip the updateNodeStatus (state machine rejects failed→failed) AND
      // the duplicate violation, but still drive cascade/schedule/finalize so
      // the DAG converges even on a redelivery. This is the fix for the
      // "required-node time-out leaves downstream pending forever" bug.
      //
      // CRITICAL: only cascade if node actually failed (not if it completed).
      // Stale timer on an already-completed node must NOT cascade its downstream.
      const currentNode = yield* sessionService.getNode(nodeId).pipe(
        Effect.catchCause(() => Effect.succeed(undefined as DAGNodeSession | undefined)),
      )
      const wasAlreadyFailed = currentNode?.status === 'failed'
      const wasAlreadyCompleted = currentNode?.status === 'completed'
      const wasAlreadySkipped = currentNode?.status === 'skipped'
      // If node was already completed or skipped, a redelivery of failure is a no-op
      // — no status change, no cascade (would otherwise damage already-good state).
      if (wasAlreadyCompleted || wasAlreadySkipped) {
        return { success: true }
      }
      const alreadyTerminal = wasAlreadyFailed  // Only 'failed' terminal state continues

      // WP2: failure_policy='recoverable' branch — node-level recovery path.
      // If node is configured with failure_policy='recoverable' and is currently
      // running, transition to 'recoverable' non-terminal state instead of 'failed'.
      // NO cascadeSkipDownstream, NO violation; downstream pending preserved.
      // Workflow does not finalize (recoverable is non-terminal, so maybeFinalizeWorkflow
      // returns null and the workflow stays in its current state).
      // This branch is orthogonal to WP-E1 failure_handler (workflow-level):
      // node-level policy takes precedence when both are configured.
      const failurePolicy = (currentNode?.config?.failure_policy as 'fail' | 'recoverable' | undefined) ?? 'fail'
      if (
        failurePolicy === 'recoverable' &&
        !alreadyTerminal &&
        currentNode?.status === 'running'
      ) {
        yield* sessionService.updateNodeStatus({
          sessionId: nodeId,
          status: 'recoverable',
          error: error.message,
        } satisfies UpdateNodeStatusInput)

        const wfForRecoverableLog = yield* sessionService.getWorkflow(workflowId)
        if (wfForRecoverableLog?.chat_session_id) {
          yield* safeAppendLog({
            nodeId,
            workflowId,
            chatSessionId: wfForRecoverableLog.chat_session_id,
            logLevel: 'warn',
            logMessage: `Node entered recoverable state: ${nodeId} — ${error.message}. Waiting for replan.`,
            executionPhase: 'recoverable',
            logData: { error: error.message, failure_policy: 'recoverable' },
          })
        }

        // Schedule other independent branches (nodes not downstream of this one).
        // Downstream pending nodes are preserved (not cascade-skipped) — they remain
        // pending until an agent replan replaces/restarts the recoverable node.
        if (!stepMode.has(workflowId)) {
          spawnedNodes.delete(nodeId)
          yield* scheduleReadyNodes(workflowId)
          // maybeFinalizeWorkflow returns null because recoverable is non-terminal
          // (computeFinalWorkflowStatus sees recoverable as in-progress → null).
          yield* maybeFinalizeWorkflow(workflowId)
        } else {
          // stepMode: resolve the Deferred with node_failed (semantically equivalent
          // to a terminal failure from the step caller's perspective, even though
          // the node is non-terminal in the DAG state machine).
          const resolve = stepResolve.get(workflowId)
          if (resolve) {
            stepResolve.delete(workflowId)
            resolve({ ok: false, reason: 'node_failed', node_id: nodeId, error: error.message })
          }
        }

        return { success: true }
      }

      // WP-E1: Failure Diagnosis — only for currently-running workflows and a
      // currently-running node. Diagnosis happens before writing failed/violation
      // so recovery uses legal running→pending, never failed→pending/skipped.
      const workflowForHandler = yield* sessionService.getWorkflow(workflowId)
      const failureHandler = workflowForHandler?.config?.failure_handler as FailureHandlerConfig | undefined
      if (
        failureHandler?.enabled &&
        !alreadyTerminal &&
        currentNode?.status === "running" &&
        workflowForHandler?.status === "running" &&
        !stepMode.has(workflowId)
      ) {
        const maxRecoveries = failureHandler.max_recoveries ?? 3
        const recoveryAttempts = recoveryAttemptsRegistry.get(workflowId) ?? 0

        if (recoveryAttempts < maxRecoveries && workflowForHandler.chat_session_id && _promptOps) {
          const allNodesForRecovery = yield* sessionService.listNodes(workflowId)
          const nodeLogs = (yield* sessionService.listNodeLogs(nodeId, 20).pipe(
            Effect.catchCause(() => Effect.succeed([] as { log_message: string; log_level: string; created_at: number }[])),
          )) ?? [] as { log_message: string; log_level: string; created_at: number }[]
          const failedNodeConfig = currentNode.config
          const diagnosisInput: FailureDiagnosisInput = {
            workflowId,
            nodeId,
            error: error.message,
            isTimeout: error.message.includes("timed out") || error.message.includes("timeout"),
            nodeConfig: failedNodeConfig,
            nodeLogs: nodeLogs.map((l: { log_message: string; log_level: string; created_at: number }) => ({
              log_message: l.log_message,
              log_level: l.log_level,
              created_at: l.created_at,
            })),
            workflowProgress: {
              completed: allNodesForRecovery.filter((n: DAGNodeSession) => n.status === "completed").length,
              failed: allNodesForRecovery.filter((n: DAGNodeSession) => n.status === "failed").length,
              total: allNodesForRecovery.length,
            },
            recoveryAttemptsForNode: recoveryAttempts,
            totalRecoveriesAttempted: recoveryAttempts,
          }
          const promptOps = _promptOps

          yield* sessionService.updateWorkflowStatus(workflowId, "paused")

          if (!capturedAgentService || !capturedChatSessions) {
            log.warn(`[WP-E1] Agent/Session service not captured, skipping diagnosis`)
            yield* sessionService.updateWorkflowStatus(workflowId, "running")
          } else {
            const diagnosisAgentName = failureHandler.agent ?? "general"
            const diagAgent = yield* capturedAgentService.get(diagnosisAgentName).pipe(
              Effect.catchCause(() => Effect.succeed(undefined as Agent.Info | undefined)),
            )
            if (!diagAgent) {
              log.warn(`[WP-E1] Diagnosis agent '${diagnosisAgentName}' not found, cascading`)
              yield* sessionService.updateWorkflowStatus(workflowId, "running")
            } else {
              const decision = yield* Effect.gen(function* () {
                const diagSession = yield* capturedChatSessions.create({
                  parentID: workflowForHandler.chat_session_id as SessionID,
                  title: `DAG Diagnosis: ${failedNodeConfig.name || nodeId}`,
                })
                const { runDiagnosisAgent } = yield* Effect.promise(() => import("./failure-diagnosis"))
                return yield* runDiagnosisAgent({
                  workflowId,
                  chatSessionId: workflowForHandler.chat_session_id,
                  input: diagnosisInput,
                  handler: failureHandler,
                  promptOps,
                  agent: diagAgent,
                  diagnosisSessionId: diagSession.id,
                  workflowProgress: diagnosisInput.workflowProgress,
                })
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    const reason = String(Cause.squash(cause))
                    log.warn(`[WP-E1] Diagnosis setup failed, cascading`, { workflowId, nodeId, reason })
                    yield* sessionService.updateWorkflowStatus(workflowId, "running").pipe(Effect.catchCause(() => Effect.void))
                    return { action: "cascade", reason: `diagnosis setup failed: ${reason}` } as DiagnosisDecision
                  }),
                ),
              )

              recoveryAttemptsRegistry.set(workflowId, recoveryAttempts + 1)

              if (decision.action === "retry") {
                const newTimeout =
                  (decision as Extract<DiagnosisDecision, { action: "retry" }>).new_timeout_ms ??
                  (failedNodeConfig.timeout_ms ? failedNodeConfig.timeout_ms * 2 : undefined)
                yield* sessionService.updateNodeStatus({
                  sessionId: nodeId,
                  status: "pending",
                } satisfies UpdateNodeStatusInput)
                markNodeRecovery(nodeId)
                if (newTimeout && newTimeout !== failedNodeConfig.timeout_ms && sessionService.updateNodeConfig) {
                  yield* sessionService.updateNodeConfig({
                    nodeId,
                    newConfig: { ...failedNodeConfig, timeout_ms: newTimeout },
                  }).pipe(Effect.catchCause(() => Effect.void))
                }
                yield* safeAppendLog({
                  nodeId,
                  workflowId,
                  chatSessionId: workflowForHandler.chat_session_id,
                  logLevel: "info",
                  logMessage: `Diagnosis: RETRY — ${decision.reason}. New timeout: ${newTimeout ?? "unchanged"}`,
                  executionPhase: "diagnosis_retry",
                  logData: { decision: decision.action, reason: decision.reason, new_timeout: newTimeout },
                })
                yield* sessionService.updateWorkflowStatus(workflowId, "running")
                spawnedNodes.delete(nodeId)
                yield* scheduleReadyNodes(workflowId)
                return { success: true }
              }

              if (decision.action === "replan") {
                yield* safeAppendLog({
                  nodeId,
                  workflowId,
                  chatSessionId: workflowForHandler.chat_session_id,
                  logLevel: "info",
                  logMessage: `Diagnosis: REPLAN — ${decision.reason}`,
                  executionPhase: "diagnosis_replan",
                  logData: { decision: decision.action, reason: decision.reason },
                })
                const replanResult = yield* replanWorkflow(workflowId, decision.patch)
                if (replanResult.ok) {
                  yield* sessionService.updateNodeStatus({
                    sessionId: nodeId,
                    status: "pending",
                  } satisfies UpdateNodeStatusInput)
                  markNodeRecovery(nodeId)
                  yield* sessionService.updateWorkflowStatus(workflowId, "running")
                  spawnedNodes.delete(nodeId)
                  yield* scheduleReadyNodes(workflowId)
                  return { success: true }
                }
                yield* sessionService.updateWorkflowStatus(workflowId, "running")
              } else {
                if (decision.action === "skip") {
                  yield* safeAppendLog({
                    nodeId,
                    workflowId,
                    chatSessionId: workflowForHandler.chat_session_id,
                    logLevel: "warn",
                    logMessage: `Diagnosis: SKIP abandoned to cascade — ${decision.reason}`,
                    executionPhase: "diagnosis_skip_abandoned",
                    logData: { decision: decision.action, reason: decision.reason },
                  })
                } else {
                  yield* safeAppendLog({
                    nodeId,
                    workflowId,
                    chatSessionId: workflowForHandler.chat_session_id,
                    logLevel: "warn",
                    logMessage: `Diagnosis: CASCADE — ${decision.reason}`,
                    executionPhase: "diagnosis_cascade",
                    logData: { decision: decision.action, reason: decision.reason },
                  })
                }
                yield* sessionService.updateWorkflowStatus(workflowId, "running")
              }
            }
          }
        } else if (recoveryAttempts >= maxRecoveries) {
          yield* safeAppendLog({
            nodeId,
            workflowId,
            chatSessionId: workflowForHandler.chat_session_id,
            logLevel: "warn",
            logMessage: `Max recoveries (${maxRecoveries}) reached, cascading failure`,
            executionPhase: "diagnosis_exhausted",
            logData: { max_recoveries: maxRecoveries, recovery_attempts: recoveryAttempts },
          })
        }
      }

      if (!alreadyTerminal) {
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
          message: error.message,
          chatSessionId: wfForLog?.chat_session_id,
        })
      }

      // 3. Cascade skip downstream pending nodes BEFORE scheduleReadyNodes
      yield* cascadeSkipDownstream(workflowId, nodeId)
      recoveryGenerationRegistry.delete(nodeId)

      // 4. P2-B: stepMode guard (WARN-1) — under step mode, resolve the Deferred
      //    with ok:false:node_failed and skip schedule/finalize. Cascade skip
      //    (step 3 above) still runs to honor DAG semantics.
      if (stepMode.has(workflowId)) {
        const resolve = stepResolve.get(workflowId)
        if (resolve) {
          stepResolve.delete(workflowId)
          resolve({ ok: false, reason: 'node_failed', node_id: nodeId, error: error.message })
        }
        return { success: true }
      }

      // 4b. Schedule other independent branches (normal path)
      yield* scheduleReadyNodes(workflowId)

      // 5. Workflow terminal convergence (WARN-2)
      yield* maybeFinalizeWorkflow(workflowId)
      
      return { success: true }
    })

  /**
   * 取消工作流
   *
   * WP-D3: cancels the workflow AND cascades cancellation to any running
   * sub-DAG child workflows. The cascade locates sub-workflows via
   * `node.metadata.chat_session_id` (persisted by spawnReadyNode's "dag"
   * dispatch, §WP-D3) and calls `cancelWorkflow(subWf.id)` recursively.
   * This keeps the cancel path purely DB-driven (works across process
   * restarts, since `chat_session_id` is persisted).
   */
  const cancelWorkflow: WorkflowEngine['cancelWorkflow'] = (workflowId) =>
    Effect.gen(function* () {
      const TERMINAL: DAGWorkflowStatus[] = ['completed', 'failed', 'cancelled']

      yield* sessionService.updateWorkflowStatus(workflowId, 'cancelled')

      // P2-B: when cancelling a workflow currently in step-mode, resolve the
      // step deferred with step_interrupted so the stepWorkflow awaiter
      // unblocks immediately. Effect.ensuring in stepWorkflow handles
      // stepMode/stepResolve cleanup on its own — we only delete stepResolve
      // here to guard against double-resolution from handleNodeCompletion.
      if (stepMode.has(workflowId)) {
        const resolve = stepResolve.get(workflowId)
        if (resolve) {
          stepResolve.delete(workflowId)
          resolve({ ok: false, reason: 'step_interrupted', workflow_status: 'cancelled' })
        }
      }

      // WP-D3: cascade to any running "dag" sub-workflows. Read node metadata
      // which was persisted in spawnReadyNode's "dag" dispatch path.
      const nodes = yield* sessionService.listNodes(workflowId).pipe(
        Effect.catchCause(() => Effect.succeed([] as DAGNodeSession[])),
      )
      for (const n of nodes) {
        if (
          n.status === "running" &&
          n.config.worker_type === "dag" &&
          (n.metadata as Record<string, unknown> | undefined)?.chat_session_id
        ) {
          const childChatSessionId = (n.metadata as Record<string, unknown>).chat_session_id as string
          const childWorkflows = yield* sessionService
            .listWorkflowsByChatSession(childChatSessionId)
            .pipe(Effect.catchCause(() => Effect.succeed([])))
          for (const cw of childWorkflows) {
            if (!TERMINAL.includes(cw.status)) {
              yield* cancelWorkflow(cw.id).pipe(Effect.catchCause(() => Effect.void))
            }
          }
          // Cleanup the bridge subscriptions for this node (idempotent — the
          // subscription callback may have already fired on the 'workflow.cancelled' event).
          cleanupSubscriptions(n.node_id)
        }
      }

      // WP3: Best-effort worktree cleanup for running/queued nodes with use_worktree.
      // Uses Effect.forkDetach (fire-and-forget) — cleanup never blocks cancel.
      // Mirrors the spawnReadyNode worktree pattern (§2.5, line 730-768).
      for (const node of nodes) {
        if (node.status !== "running" && node.status !== "queued") continue
        const workerConfig = node.config.worker_config as { use_worktree?: boolean } | undefined
        if (workerConfig?.use_worktree !== true) continue
        yield* Effect.gen(function* () {
          const wtManager = yield* WorktreeManagerTag.pipe(
            Effect.catchCause(() => Effect.succeed(undefined as IWorktreeManager | undefined))
          )
          if (wtManager) {
            yield* Effect.promise(() => wtManager.cleanup(node.node_id)).pipe(
              Effect.catchCause(() => Effect.void)
            )
          }
        }).pipe(Effect.forkDetach)
      }

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

  // ============================================================================
  // P2-B: stepWorkflow — execute exactly 1 ready node while workflow stays paused
  //
  // Semantics:
  // - REJECT if workflow status is not 'paused'
  // - Return {ok:false, reason:"no_ready_nodes"} if no pending-with-satisfied-deps
  // - Spawn exactly 1 ready node via spawnReadyNode (maxConcurrency budget = 1)
  // - Await completion/failure of that node via a Deferred (Promise) resolved in
  //   handleNodeCompletion/Failure when stepMode.has(workflowId)
  // - Workflow status remains 'paused' throughout (no finalize, no auto-schedule)
  // - Effect.ensuring guarantees stepMode cleanup on fiber interrupt/complete/fail
  // ============================================================================
  const stepWorkflow: WorkflowEngine['stepWorkflow'] = (workflowId) =>
    Effect.gen(function* () {
      // 0+1. Status gate + ready nodes computation (duplicated from above for correctness)
      const workflow = yield* sessionService.getWorkflow(workflowId)
      if (!workflow || workflow.status !== 'paused') {
        return {
          ok: false,
          reason: 'not_paused',
          workflow_status: workflow?.status ?? 'cancelled',
        } as StepResult
      }

      const allNodes = yield* sessionService.listNodes(workflowId)
      const completedNodeIds = new Set<string>(
        allNodes.filter((n: DAGNodeSession) => n.status === 'completed').map((n: DAGNodeSession) => n.node_id),
      )
      const failedNodeIds = new Set<string>(
        allNodes.filter((n: DAGNodeSession) => n.status === 'failed').map((n: DAGNodeSession) => n.node_id),
      )
      const runningNodeIds = new Set<string>(
        allNodes.filter((n: DAGNodeSession) => n.status === 'running').map((n: DAGNodeSession) => n.node_id),
      )
      const readyNodes = getReadyNodes(allNodes, completedNodeIds, failedNodeIds, runningNodeIds)
      const outputMap = buildOutputMap(allNodes)
      const { executeList } = splitByCondition(readyNodes, outputMap)
      if (executeList.length === 0) {
        return { ok: false, reason: 'no_ready_nodes' } as StepResult
      }
      const targetNode = executeList[0]

      // 2. Register step-mode token (handleNodeCompletion/Failure gate) + Deferred
      //    (Promise resolved by handleNodeCompletion/Failure via callback map).
      stepMode.add(workflowId)
      let deferredResolve: (r: StepResult) => void
      const deferred = new Promise<StepResult>((r) => { deferredResolve = r })
      stepResolve.set(workflowId, deferredResolve!)

      // 3. Fork spawnReadyNode for the single target node (budget=1)
      yield* spawnReadyNode(workflowId, targetNode, outputMap).pipe(Effect.forkDetach)

      // 4. Await completion/failure via Deferred — resolved by
      //    handleNodeCompletion/Failure when stepMode.has(workflowId)
      const result: StepResult = yield* Effect.promise(() => deferred).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            stepMode.delete(workflowId)
            stepResolve.delete(workflowId)
          }),
        ),
      )

      return result
    }) as Effect.Effect<StepResult, never>

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
      const recoverableCount = allNodes.filter((n: DAGNodeSession) => n.status === 'recoverable').length
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
        recoverableCount,
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

  const previewReplanWorkflow: NonNullable<WorkflowEngine['previewReplanWorkflow']> = (workflowId, patch) =>
    Effect.gen(function* () {
      if (patch.workflow_id !== workflowId) {
        return yield* Effect.fail(new Error(`workflow_id mismatch: patch.workflow_id=${patch.workflow_id} does not match ${workflowId}`))
      }
      const workflow = yield* sessionService.getWorkflow(workflowId)
      if (!workflow) return yield* Effect.fail(new Error(`Workflow ${workflowId} not found`))
      const currentNodes = yield* sessionService.listNodes(workflowId)
      const preResult = validateReplanPreconditions(workflow, patch)
      if (!preResult.ok) return yield* Effect.fail(new Error(preResult.reason))
      const { frozenIds, removableIds } = classifyReplanNodes(currentNodes)
      const frozenExistResult = validateFrozenAndExistence(
        patch,
        frozenIds,
        new Set(currentNodes.map((n: DAGNodeSession) => n.node_id)),
        removableIds,
      )
      if (!frozenExistResult.ok) return yield* Effect.fail(new Error(frozenExistResult.reason))
      const applyResult = applyReplanPatchToConfig(workflowId, workflow.config.nodes, patch)
      if (!applyResult.ok) return yield* Effect.fail(new Error(applyResult.reason))
      const postResult = validateReplanPostConfig(applyResult.newConfigNodes, patch, workflow, currentNodes)
      if (!postResult.ok) return yield* Effect.fail(new Error(postResult.reason))
      const newMaxConcurrency = patch.new_max_concurrency ?? workflow.config.max_concurrency
      const addedNodeIds = (patch.add_nodes ?? []).map((n) => `${workflowId}::${n.id}`)
      const postNodeIds = currentNodes
        .filter((n: DAGNodeSession) => !(patch.remove_nodes ?? []).includes(n.node_id))
        .map((n: DAGNodeSession) => n.node_id)
        .concat(addedNodeIds)
      return {
        ok: true as const,
        workflow_id: workflowId,
        pre: {
          config: workflow.config,
          node_ids: currentNodes.map((n: DAGNodeSession) => n.node_id),
          max_concurrency: workflow.config.max_concurrency,
          total_nodes: currentNodes.length,
        },
        post: {
          config: { ...workflow.config, nodes: applyResult.newConfigNodes, max_concurrency: newMaxConcurrency },
          node_ids: postNodeIds,
          max_concurrency: newMaxConcurrency,
          total_nodes: postNodeIds.length,
        },
        delta: {
          nodes_added: addedNodeIds.length,
          nodes_removed: (patch.remove_nodes ?? []).length,
          nodes_updated: (patch.update_nodes ?? []).length,
          final_total: applyResult.newConfigNodes.length,
          max_concurrency_changed: patch.new_max_concurrency !== undefined && patch.new_max_concurrency !== workflow.config.max_concurrency,
        },
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed({
          ok: false as const,
          reason: String(Cause.squash(cause)),
          detail: Cause.squash(cause),
        }),
      ),
    ) as Effect.Effect<ReplanPreviewResult, never, never>

  const replanWorkflow: WorkflowEngine['replanWorkflow'] = (workflowId, patch) =>
    Effect.gen(function* () {
      if (patch.workflow_id !== workflowId) {
        return yield* Effect.fail(new Error(`workflow_id mismatch: patch.workflow_id=${patch.workflow_id} does not match ${workflowId}`))
      }
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

      // 3. Classify nodes: frozen vs removable (WP3) vs mutable
      const { frozenIds, removableIds } = classifyReplanNodes(currentNodes)

      // 4. Frozen + existence guards
      const currentNodeIds = new Set(currentNodes.map((n: DAGNodeSession) => n.node_id))
      const frozenExistResult = validateFrozenAndExistence(patch, frozenIds, currentNodeIds, removableIds)
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
      const postResult = validateReplanPostConfig(newConfigNodes, patch, workflow, currentNodes)
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

      // 14. WP3: Immediately schedule newly-added replacement nodes (forked to not
      //     block replan return). Must come AFTER replanInFlight.delete(12, above)
      //     so scheduleReadyNodes entry guard doesn't short-circuit.
      yield* scheduleReadyNodes(workflowId).pipe(Effect.forkDetach)

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
    previewReplanWorkflow,
    replanWorkflow,
    pauseWorkflow,
    resumeWorkflow,
    stepWorkflow,
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

/**
 * §4.2 model_level / model 解析（纯运行时辅助）。
 *
 * 解析优先级（最高在前）：
 *   1. worker_config.model_level → 查 Config.dag.model_levels[level] 得到 "provider/model"
 *   2. worker_config.model ("providerID/modelID")
 *   3. 都缺省 → undefined（走 agent 默认模型）
 *
 * 读 Config.Service 是 best-effort：服务不可用或配置缺失时静默回退。
 * 返回的 providerID/modelID 对供 promptOps.prompt 使用。
 */
function resolveNodeModel(
  workerConfig: Record<string, unknown> | undefined,
): Effect.Effect<{ providerID: ProviderID; modelID: ModelID } | undefined, never, never> {
  return Effect.gen(function* () {
    // 先尝试 model_level
    const rawLevel = workerConfig?.model_level
    if (typeof rawLevel === "string" && rawLevel.length > 0) {
      const configService = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
      if (configService) {
        const cfg = yield* configService.get().pipe(
          Effect.catchCause(() => Effect.succeed(undefined as Config.Info | undefined)),
        )
        const dagModelLevels = (cfg?.dag as { model_levels?: Record<string, string> } | undefined)?.model_levels
        const resolved = dagModelLevels?.[rawLevel]
        if (typeof resolved === "string" && resolved.length > 0) {
          const [provider, model] = resolved.split("/")
          if (provider && model) {
            return { providerID: ProviderID.make(provider), modelID: ModelID.make(model) }
          }
        }
        // model_level 声明了但配置中无对应条目：交由 §4.3 bootstrap_check 在启动期拦截；
        // 运行时静默回退到 worker_config.model（不 fail，保持调度连续性）。
      }
    }

    // 回退到 worker_config.model
    const rawModel = workerConfig?.model
    if (typeof rawModel === "string") {
      const [provider, model] = rawModel.split("/")
      if (provider && model) {
        return { providerID: ProviderID.make(provider), modelID: ModelID.make(model) }
      }
    }

    return undefined
  })
}

/**
 * D1 helper: truncate upstream output for inclusion in audit records.
 *
 * Condition-skip violations now include a snapshot of the ref_node's actual
 * output so users can diagnose why a condition evaluated to false. Raw outputs
 * can be large (LLM-generated text), so we cap at 500 chars for strings and
 * 1 level of object keys for structured data — enough to diagnose, small
 * enough not to bloat the violation table.
 */
const AUDIT_OUTPUT_MAX_CHARS = 500
function truncateForAudit(value: unknown): unknown {
  if (value === undefined || value === null) return value
  if (typeof value === "string") {
    return value.length > AUDIT_OUTPUT_MAX_CHARS
      ? value.slice(0, AUDIT_OUTPUT_MAX_CHARS) + "...[truncated]"
      : value
  }
  if (typeof value === "number" || typeof value === "boolean") return value
  // For objects/arrays, attempt a JSON string truncation (covers large nested
  // structures). If serialization fails, return a type marker.
  try {
    const json = JSON.stringify(value)
    return json.length > AUDIT_OUTPUT_MAX_CHARS
      ? json.slice(0, AUDIT_OUTPUT_MAX_CHARS) + "...[truncated]"
      : value
  } catch {
    return `[unserializable ${typeof value}]`
  }
}
