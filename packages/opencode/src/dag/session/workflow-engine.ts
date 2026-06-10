// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

import { Cause, Effect, Result } from "effect"
import { DAGSessionService, emitWorkflowReplannedEvent, getEventBus } from "./session-service"
import type {
  AppendNodeLogInput,
  CreateViolationInput,
  UpdateNodeStatusInput,
} from "./session-service"
import { validateInputMapping, validateNodeCondition, validateWorkflowConfigLimits } from "./limits"
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
  ReplanPatch,
  ReplanResult,
  StepResult,
} from "./types"
import type { PromptOps } from "@/session/prompt-ops"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { WorktreeManagerTag } from "../worktree-manager/tags"
import type { IWorktreeManager } from "../worktree-manager/IWorktreeManager"
import type { WorktreeInfo } from "../worktree-manager/types"
import { bootstrapWorkflowFromConfig } from "./core-start"
import { MAX_SUB_DAG_DEPTH, DEFAULT_SUB_DAG_TIMEOUT_MS } from "./limits"
import type { IEventBus } from "../state-machine/IStateMachine"
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
// WP-D3: Sub-DAG Lifecycle Bridge — Parent↔Child event subscription registry
// ============================================================================
//
// When `spawnReadyNode` dispatches a `worker_type="dag"` node, the child
// workflow runs independently. The parent node stays in "running" until the
// child converges to a terminal state. This bridge subscribes to EventBus
// events (`workflow.completed` / `workflow.failed` / `workflow.cancelled`) and
// translates them to `handleNodeCompletion` / `handleNodeFailure` on the
// parent engine — reusing the existing completion path (no new state-mutation
// channel, iron laws #3/#4).
//
// Each entry is keyed by `parentNodeId` (globally unique namespaced ID). The
// value carries the unsubscribes, the setTimeout ID, and the child workflow ID
// (for the cancel cascade discovery). A single `cleanupSubscriptions` call
// removes everything for that node — covering the 4 terminal paths:
// completed / failed / cancelled / timeout.
// ============================================================================

interface SubdagSubscriptionState {
  unsubscribes: Array<() => void>
  timeoutId: ReturnType<typeof setTimeout> | undefined
  parentWorkflowId: string
  childWorkflowId: string
}

const subdagSubscriptions = new Map<string, SubdagSubscriptionState>()

/** @internal test-only — exposes module-private subdagSubscriptions map. */
export const __internal_subdagSubscriptions = (): Map<string, SubdagSubscriptionState> =>
  subdagSubscriptions

/**
 * Cancel all event subscriptions and the timeout timer for a parent node.
 * Idempotent — safe to call multiple times (second call is a no-op).
 *
 * Called from 4 paths (WP-D3 §7, INFO-4):
 *   1. `workflow.completed` handler (parent node completed)
 *   2. `workflow.failed` handler (parent node failed)
 *   3. `workflow.cancelled` handler (parent node failed-after-cancel)
 *   4. setTimeout fire (timeout fallback)
 */
export function cleanupSubscriptions(parentNodeId: string): void {
  const state = subdagSubscriptions.get(parentNodeId)
  if (!state) return
  if (state.timeoutId !== undefined) clearTimeout(state.timeoutId)
  for (const unsub of state.unsubscribes) unsub()
  subdagSubscriptions.delete(parentNodeId)
}

/**
 * Install the event-bridge for a sub-DAG lifecycle (WP-D3, §3.3 + §7 WP-D3).
 *
 * After `spawnReadyNode` dispatches a "dag" node and `bootstrapWorkflowFromConfig`
 * returns, this function subscribes to the child workflow's terminal events
 * and starts a timeout fallback timer. When either the event arrives or the
 * timer fires, the appropriate parent-node completion path is driven
 * (`handleNodeCompletion` / `handleNodeFailure`).
 *
 * Dependencies are passed as callbacks rather than captured from closure so
 * the bridge can be tested in isolation without going through `spawnReadyNode`.
 *
 * @param args.parentWorkflowId The parent workflow ID (consumer of the bridge).
 * @param args.parentNodeId The parent "dag" node ID (namespaced, subscription key).
 * @param args.childWorkflowId The child workflow ID (event-filter target).
 * @param args.timeoutMs Timeout in ms before the bridge fires "subdag_timeout".
 * @param args.eventBus The shared IEventBus instance (process-level singleton).
 * @param args.sessionService The session service (for creating timeout violations).
 * @param args.onChildCompleted Callback driven when the child reaches "completed".
 * @param args.onChildFailed Callback driven when the child reaches "failed" / "cancelled".
 * @param args.onCancelChild Callback driven on timeout to cancel the child workflow.
 * @param args.onCreateViolation Callback to create a DAGViolation row.
 */
export function installSubdagLifecycleBridge(args: {
  parentWorkflowId: string
  parentNodeId: string
  childWorkflowId: string
  timeoutMs: number
  eventBus: IEventBus
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessionService: any
  onChildCompleted: (workflowId: string, nodeId: string, output: unknown) => Effect.Effect<unknown>
  onChildFailed: (workflowId: string, nodeId: string, error: Error) => Effect.Effect<unknown>
  onCancelChild: (childWorkflowId: string) => Effect.Effect<unknown>
  onCreateViolation: (input: CreateViolationInput) => Effect.Effect<unknown>
}): void {
  const {
    parentWorkflowId,
    parentNodeId,
    childWorkflowId,
    timeoutMs,
    eventBus,
    sessionService,
    onChildCompleted,
    onChildFailed,
    onCancelChild,
    onCreateViolation,
  } = args
  const unsubscribes: Array<() => void> = []

  // Idempotency guard: only act once per parent-node (prevents duplicate
  // state-machine transitions if a child event races with the timeout).
  let settled = false
  const settle = () => {
    if (settled) return false
    settled = true
    cleanupSubscriptions(parentNodeId)
    return true
  }

  // Subscribe to "workflow.completed" — child converged successfully
  unsubscribes.push(
    eventBus.subscribe("workflow.completed", (event) => {
      if ((event as { workflow_id: string }).workflow_id !== childWorkflowId) return
      if (!settle()) return
      Effect.runPromise(onChildCompleted(parentWorkflowId, parentNodeId, childWorkflowId).pipe(Effect.ignore))
    }),
  )

  // Subscribe to "workflow.failed"
  unsubscribes.push(
    eventBus.subscribe("workflow.failed", (event) => {
      if ((event as { workflow_id: string }).workflow_id !== childWorkflowId) return
      if (!settle()) return
      Effect.runPromise(
        onChildFailed(parentWorkflowId, parentNodeId, new Error("sub-workflow failed")).pipe(Effect.ignore),
      )
    }),
  )

  // Subscribe to "workflow.cancelled" — treated as a failure from the parent's
  // perspective (parent node marked failed, cascade skip downstream follows)
  unsubscribes.push(
    eventBus.subscribe("workflow.cancelled", (event) => {
      if ((event as { workflow_id: string }).workflow_id !== childWorkflowId) return
      if (!settle()) return
      Effect.runPromise(
        onChildFailed(parentWorkflowId, parentNodeId, new Error("sub-workflow cancelled")).pipe(Effect.ignore),
      )
    }),
  )

  // Timeout fallback: if no terminal event arrives within timeoutMs, fire the
  // violation + cancel child + fail parent node.
  const timeoutId = setTimeout(() => {
    if (!settle()) return
    Effect.runPromise(
      Effect.gen(function* () {
        yield* onCreateViolation({
          workflowId: parentWorkflowId,
          nodeId: parentNodeId,
          type: "subdag_timeout",
          severity: "error",
          message: `sub-DAG did not converge within ${timeoutMs}ms`,
          details: { timeoutMs, childWorkflowId },
        }).pipe(Effect.catchCause(() => Effect.void))
        yield* onCancelChild(childWorkflowId).pipe(Effect.catchCause(() => Effect.void))
        yield* onChildFailed(
          parentWorkflowId,
          parentNodeId,
          new Error(`sub-DAG timed out after ${timeoutMs}ms`),
        ).pipe(Effect.catchCause(() => Effect.void))
      }).pipe(Effect.ignore),
    )
  }, timeoutMs)

  subdagSubscriptions.set(parentNodeId, {
    unsubscribes,
    timeoutId,
    parentWorkflowId,
    childWorkflowId,
  })
}

// ============================================================================
// Replan Pure Helpers — canonical implementations in ./execution-core.ts.
// Re-exported above for backward compatibility.
// ============================================================================

// Re-export for backward compatibility: all existing `from "./workflow-engine"` imports
// of validateWorkflowConfigLimits (including test files) continue to work unchanged.
// Canonical implementation lives in ./limits.ts (breaks session-service↔workflow-engine cycle).
export { validateWorkflowConfigLimits } from "./limits"

/**
 * Validates the post-patch config: node cap (20), concurrency range (1..10),
 * dependency resolution, required-node integrity, and cycle absence.
 *
 * NOTE: Stays in workflow-engine.ts (Advisory A1 方案 b) because it depends on
 * RequiredNodesValidator which has Effect import — not eligible for execution-core.
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
  // 辅助函数 — areDependenciesSatisfied / getReadyNodes / computeFinalWorkflowStatus
  // are now imported from ./execution-core.ts (A layer, pure logic)
  // ============================================================================

  // ============================================================================
  // Node Spawn — Full daemon-flow for a single node (§10 compliant)
  // ============================================================================

  const spawnReadyNode = (
    workflowId: string,
    node: DAGNodeSession,
    outputMap?: Map<string, unknown>,
  ): Effect.Effect<void, never, never> => {
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
      // P2-B: step-mode relaxation — when stepMode is active for this workflow,
      // spawn is allowed even under 'paused' (stepWorkflow is driving a single-node execution).
      if (wf && wf.status === 'paused' && !stepMode.has(workflowId)) {
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
          }).pipe(
            Effect.tapError((err) => Effect.logWarning(`[DAG] violation create failed: ${err}`)),
            Effect.ignore,
          )
          return
        }

        // Child session (INFO-5: same pattern as agent-type nodes)
        const subSessions = yield* Session.Service
        const subChildSession = yield* subSessions.create({
          parentID: parentWf.chat_session_id as SessionID,
          title: node.config.name + " (sub-DAG)",
        })

        // Mark running (WP-D2: stays running until WP-D3 event bridge signals)
        yield* sessionService.updateNodeStatus({
          sessionId: node.node_id,
          status: "running",
        } satisfies UpdateNodeStatusInput).pipe(
          Effect.tapError((err) => Effect.logWarning(`[DAG] status update failed: ${err}`)),
          Effect.ignore,
        )

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
          abortSignal: new AbortController().signal,
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
        yield* sessionService.createViolation({
          workflowId,
          nodeId: skipNode.node_id,
          type: 'condition_skipped' as DAGViolationType,
          severity: 'warning',
          message: `Condition evaluated to false: ${skipNode.node_id} skipped`,
          details: {
            trigger: 'condition_false',
            condition: skipNode.config.condition,
          },
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
      const maxConcurrency = concurrencyRegistry.get(workflowId) ?? Number.POSITIVE_INFINITY
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
    }) as Effect.Effect<{ success: boolean }, never>

  /**
   * 处理节点失败
   */
  const handleNodeFailure: WorkflowEngine['handleNodeFailure'] = (workflowId, nodeId, error) =>
    Effect.gen(function* () {
      // WP-D3: If this node is a sub-DAG bridge node, drop its event
      // subscriptions before any state change (same pattern as handleNodeCompletion).
      cleanupSubscriptions(nodeId)

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
    }) as Effect.Effect<{ success: boolean }, never>

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
