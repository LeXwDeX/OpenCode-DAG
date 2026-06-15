// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

import { Effect } from "effect"
import type { IDAGSessionService } from "./session-service"
import type { UpdateNodeStatusInput } from "./session-service"
import type { DAGNodeSession, DAGWorkflowSession } from "./types"
import { WorkflowEngine, registerEngine, unregisterEngine, setWorkflowConcurrency } from "./workflow-engine"
import { createWorkflowExecutor } from "./workflow-executor"
import { readDagDefaultsFromService } from "./dag-config-check"
import type { PromptOps } from "@/session/prompt-ops"

export type RecoverResult = { scanned: number; marked: number; resumed: number }

/**
 * BUGFIX (running→pending 误判): 活性检查替代进程级单次执行锁。
 *
 * 早期修复尝试用一个进程级布尔锁（`recoveryScanCompleted`）让首次扫描后
 * 所有后续调用返回缓存结果。但全局锁有两个致命缺陷：
 *   1. 破坏测试隔离（同模块内多个 test 共享锁，首个 test 后其余全部拿到缓存）；
 *   2. 生产中进程长期运行后若新工作流崩溃，无法再被恢复（锁已闭合）。
 *
 * 正确的修复是 per-workflow 活性检查：recovery 函数本身已具备幂等性
 * （`WorkflowEngine.get(wf.id) !== undefined` 入口 guard + 节点 chat_session_id
 * 活性检查），足以区分"layer 重建竞态"与"真正崩溃"。全局锁是多余的，
 * 已移除。layer 重建导致的重复调用由活性检查自然吸收。
 */

/**
 * Pure recovery function: scan all workflows, find orphaned ones (status='running'
 * but no engine in memory), and either resume them (when promptOps is provided,
 * WP-A2) or mark them failed with audit violations (legacy fallback).
 *
 * **Resume path** (WP-A2, when `promptOps` is provided):
 * - Rebuilds a WorkflowEngine instance via `WorkflowEngine.make`
 * - Injects the headless `promptOps` (from WP-A1 capture in layer.ts)
 * - Fills `concurrencyRegistry` from `workflow.config.max_concurrency`
 * - Calls `registerEngine` and `scheduleReadyNodes` (NOT `startWorkflow`,
 *   which would attempt an illegal running→running transition)
 * - Forks a `createWorkflowExecutor` daemon for ongoing polling
 * - Assembly entry guard: `WorkflowEngine.get(wfId) !== undefined` → skip (idempotent)
 * - On assembly failure: falls back to mark-failed with violation (no stuck state)
 *
 * **Legacy path** (when `promptOps` is NOT provided):
 * - Marks orphaned workflows as failed (running → failed)
 * - Creates `process_orphan` violations
 * - Cascade-skips downstream nodes (running → failed, queued/pending → skipped)
 *
 * Legal transitions for legacy path (per session-service.ts:48-86):
 * - workflow: running → failed
 * - node: running → failed (was actively executing)
 * - node: queued / pending → skipped (never started)
 */
export function recoverOrphanedWorkflows(
  service: IDAGSessionService,
  promptOps?: PromptOps,
): Effect.Effect<RecoverResult> {
  return Effect.gen(function* () {
    // BUGFIX: 全局单次执行锁已移除（见上方设计注释）。
    // 幂等性由 per-workflow 活性检查 + engine-registry guard 承载。

    const workflows = yield* service.listAllWorkflows()
    const orphans = workflows.filter(w =>
      w.status === 'running' && WorkflowEngine.get(w.id) === undefined
    )

    let marked = 0
    let resumed = 0
    for (const wf of orphans) {
      // INFO 1: assembly entry guard — if engine already exists for this workflow,
      // skip the entire rebuild + daemon fork (idempotency). This guard lives here
      // (not inside registerEngine) per architecture constraint.
      if (WorkflowEngine.get(wf.id) !== undefined) continue

      // BUGFIX (running→pending 误判): 活性检查。
      // 在判定为孤儿前，检查工作流是否有正在运行的节点。
      // 如果节点有 metadata.chat_session_id，说明该节点可能已 spawn 了 child session。
      // 这种情况下，engine 不在 registry 但 child session 可能仍在工作——
      // 不应重置这些节点。只有当节点无活跃 child session 时才视为真正的孤儿。
      const nodes = yield* service.listNodes(wf.id).pipe(
        Effect.catchCause(() => Effect.succeed([] as DAGNodeSession[])),
      )
      const runningNodes = nodes.filter(n => n.status === 'running')
      const nodesWithChildSession = runningNodes.filter(
        n => (n.metadata as Record<string, unknown> | undefined)?.chat_session_id,
      )

      // 如果有 running 节点携带了 chat_session_id，说明它们曾经成功 spawn 过 child session。
      // engine 缺失可能是 layer 重建竞态，而非真正的进程崩溃。
      // 保守策略：跳过这些工作流，让它们自然完成（executor daemon 或 prompt 自然结束）。
      // 只有当没有任何 running 节点有 child session 时，才判定为真正的孤儿。
      if (runningNodes.length > 0 && nodesWithChildSession.length > 0) {
        yield* Effect.logWarning(
          `[DAG recovery] Skipping workflow ${wf.id}: ${nodesWithChildSession.length} running node(s) have active child sessions — likely layer-rebuild race, not a crash. Nodes preserved.`,
        )
        continue
      }

      if (promptOps) {
        // WP-A2 resume assembly attempt
        const resumeOk = yield* resumeOrphanWorkflow(service, wf, promptOps)
        if (resumeOk) {
          resumed++
          continue
        }
        // Resume assembly failed → fall through to legacy mark-failed
        yield* failOrphanWorkflow(service, wf, 'recovery assembly failed')
        marked++
      } else {
        // Legacy fallback: no promptOps available
        yield* failOrphanWorkflow(service, wf, 'workflow orphaned by process restart (was running at previous shutdown)')
        marked++
      }
    }

    const result: RecoverResult = { scanned: workflows.length, marked, resumed }
    return result
  })
}

/**
 * Returns the legal target status for an orphaned node, or null if already terminal.
 * See session-service.ts:48-86 for state transition tables.
 */
function recoverNodeTargetStatus(
  current: DAGNodeSession['status'],
): 'failed' | 'skipped' | null {
  switch (current) {
    case 'running': return 'failed'
    case 'queued': return 'skipped'
    case 'pending': return 'skipped'
    // WP2: orphan recovery sees recoverable → failed. Process restart means
    // the main agent that would have issued a replan is gone; the recoverable
    // wait-for-replan context is lost. Safest terminal = failed (not running,
    // because there is no executor to re-spawn the node).
    case 'recoverable': return 'failed'
    case 'completed':
    case 'failed':
    case 'skipped':
      return null
  }
}

/**
 * Legacy failure path: mark workflow failed + process_orphan violation + cascade-skip nodes.
 * Extracted from the inline body of the original recoverOrphanedWorkflows loop.
 */
function failOrphanWorkflow(
  service: IDAGSessionService,
  wf: DAGWorkflowSession,
  violationMessage: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* service.updateWorkflowStatus(wf.id, 'failed').pipe(
      Effect.tapError(err => Effect.logWarning(`[DAG recovery] failed to mark workflow ${wf.id}: ${err}`)),
      Effect.ignore,
    )

    yield* service.createViolation({
      workflowId: wf.id,
      type: 'process_orphan',
      severity: 'critical',
      message: violationMessage,
    }).pipe(
      Effect.tapError(err => Effect.logWarning(`[DAG recovery] violation creation failed for ${wf.id}: ${err}`)),
      Effect.ignore,
    )

    const nodes = yield* service.listNodes(wf.id)
    for (const node of nodes) {
      const targetStatus = recoverNodeTargetStatus(node.status)
      if (!targetStatus) continue
      yield* service.updateNodeStatus({
        sessionId: node.node_id,
        status: targetStatus,
        error: targetStatus === 'failed' ? 'orphaned by process restart' : undefined,
      } satisfies UpdateNodeStatusInput).pipe(
        Effect.tapError(err => Effect.logWarning(`[DAG recovery] failed to transition ${node.node_id} → ${targetStatus}: ${err}`)),
        Effect.ignore,
      )
    }
  })
}

/**
 * WP-A2 resume assembly: rebuild WorkflowEngine, inject promptOps, fill
 * concurrencyRegistry, registerEngine, scheduleReadyNodes, fork daemon.
 *
 * Returns `true` on success; `false` on any assembly step failure.
 * On failure, caller falls through to `failOrphanWorkflow` — this function
 * does NOT modify workflow status itself (no stuck intermediate state).
 *
 * **Does NOT call startWorkflow** (which would attempt running→running).
 * Instead: sets concurrencyRegistry directly + scheduleReadyNodes + forkDetach daemon.
 */
function resumeOrphanWorkflow(
  service: IDAGSessionService,
  wf: DAGWorkflowSession,
  promptOps: PromptOps,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    // 1. Build engine (yields DAGSessionService.make internally — satisfied by DB layer)
    const engine = yield* WorkflowEngine.make

    // 2. Inject headless promptOps (WP-A1 reference, passed from layer.ts)
    //    setPromptOps is a non-interface method exposed on the engine instance.
    ;(engine as WorkflowEngine & { setPromptOps: (ops: PromptOps) => void }).setPromptOps(promptOps)

    // 3. Fill concurrencyRegistry from workflow config (bypasses startWorkflow)
    setWorkflowConcurrency(wf.id, wf.config.max_concurrency)

    // 4. Register engine in module-level registry
    registerEngine(wf.id, engine)

    // 4.5. WP-A3: Reset running nodes to pending (recovery reset).
    //      Must happen BEFORE scheduleReadyNodes (step 5) so the scheduler
    //      picks them up for re-spawn. Legal transition per session-service.ts:81-82.
    yield* resetRunningNodes(service, wf)

    // 5. Schedule pending/ready nodes (NOT startWorkflow — avoids running→running transition)
    yield* engine.scheduleReadyNodes(wf.id)

    // 6. Fork detached daemon for ongoing polling (ensuring cleanup on exit)
    //    §4.1 I1: 同 core-start，接入 Config.dag 默认值作为工作流级 timeout 回退。
    const recoveryDefaults = yield* readDagDefaultsFromService()
    const executor = createWorkflowExecutor(
      engine,
      wf.config,
      recoveryDefaults.defaultWorkflowTimeoutMs,
      service,
      promptOps,
      recoveryDefaults.defaultTimeoutPolicy,
    )
    yield* executor.start(wf.id).pipe(Effect.forkDetach)

    return true
  }).pipe(
    // On any assembly failure: cleanup registered engine to prevent leaks
    Effect.tapError(() =>
      Effect.sync(() => unregisterEngine(wf.id)),
    ),
    // Collapse Effect.fail into a boolean result for the caller
    Effect.catchCause(() => Effect.succeed(false)),
  )
}

/**
 * WP-A3: Reset all running nodes in an orphaned workflow to pending.
 * Called between registerEngine (step 4) and scheduleReadyNodes (step 5)
 * so the scheduler picks them up for re-spawn.
 *
 * BUGFIX (running→pending 误判): 只有当 running 节点**没有** child session
 * （metadata.chat_session_id）时才重置。携带 child session 的节点说明它们曾经
 * 成功 spawn 过 agent——重置会遗弃正在工作的 child session 并 spawn 重复 session。
 * 这些节点保留 running 状态，等待其自然收敛（child session 完成后 node_complete 会被调用）。
 *
 * Per INFO 5: appends a recovery_reset log entry per reset node.
 * Original running logs are preserved (audit integrity).
 */
function resetRunningNodes(
  service: IDAGSessionService,
  wf: DAGWorkflowSession,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const nodes = yield* service.listNodes(wf.id)
    for (const node of nodes) {
      if (node.status !== 'running') continue

      // BUGFIX: 跳过携带活跃 child session 的节点——它们不是真正的孤儿。
      const hasChildSession = (node.metadata as Record<string, unknown> | undefined)?.chat_session_id
      if (hasChildSession) {
        yield* service.appendNodeLog({
          nodeId: node.node_id,
          workflowId: wf.id,
          chatSessionId: wf.chat_session_id,
          logLevel: 'info',
          logMessage: `Recovery preserved: running node has active child session, not reset to pending (avoiding duplicate spawn).`,
          executionPhase: 'recovery_preserved',
        }).pipe(
          Effect.tapError(err => Effect.logWarning(`[DAG recovery] failed to append recovery_preserved log for ${node.node_id}: ${err}`)),
          Effect.ignore,
        )
        continue
      }

      yield* service.updateNodeStatus({
        sessionId: node.node_id,
        status: 'pending',
      } satisfies UpdateNodeStatusInput).pipe(
        Effect.tapError(err => Effect.logWarning(`[DAG recovery] failed to reset ${node.node_id} running→pending: ${err}`)),
        Effect.ignore,
      )

      yield* service.appendNodeLog({
        nodeId: node.node_id,
        workflowId: wf.id,
        chatSessionId: wf.chat_session_id,
        logLevel: 'info',
        logMessage: `Recovery reset: running node reset to pending for re-spawn (WP-A3)`,
        executionPhase: 'recovery_reset',
      }).pipe(
        Effect.tapError(err => Effect.logWarning(`[DAG recovery] failed to append recovery_reset log for ${node.node_id}: ${err}`)),
        Effect.ignore,
      )
    }
  })
}
