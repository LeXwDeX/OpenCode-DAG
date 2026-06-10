// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * DAG Internal Diagnostic Probe — RESERVED SKELETON (D-PROBE-RESERVE, 2026-06-10)
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  ⚠️ DO NOT DELETE — INTENTIONALLY RESERVED, NOT DEAD CODE      │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * This class provides the placeholder implementation of IDAGProbe (see
 * probe-types.ts). Every method throws a D-PROBE-RESERVE error to signal
 * "interface reserved, runtime logic pending". This is by design — the
 * real implementation is deferred to backlog WP-4 / P2-A to avoid
 * blocking future DAG diagnostic use cases with premature design choices.
 *
 * WHY THIS CLASS EXISTS (AND WHY IT SEEMS UNUSED):
 *   - Locks IDAGProbe method signatures with a concrete class + constructor
 *     dependency, so future implementor only needs to replace method bodies
 *   - DAGProbe is NOT wired anywhere in production (layer.ts / HTTP / MCP /
 *     dagworker) by deliberate architectural decision (AGENTS.md §5)
 *   - The "unused" appearance is the expected steady state until a user
 *     request triggers probe implementation
 *
 * FUTURE IMPLEMENTOR — REPLACEMENT GUIDE:
 *   Replace each `throw new Error(...)` body with real logic that:
 *   1. Calls sessionService (Effect-based, use Effect.runPromise like DAGQuery)
 *   2. Reuses A-layer pure functions from execution-core.ts:
 *      - explainBlock        → areDependenciesSatisfied (反推未满足 dep)
 *      - getTopology         → detectCycle (⚠️ 入参 DAGNodeConfig[]!) + BFS 分层
 *      - getExecutionSnapshot → getReadyNodes + computeSpawnBudget
 *      - predictCascade      → findPendingDescendants
 *   3. Keeps the hidden boundary (not exposed to AGENT) unless user decides otherwise
 */

import type { IDAGSessionService } from '../session/session-service'
import type { IDAGProbe, NodeBlockReason, TopologySnapshot, ExecutionSnapshot, CascadeImpact } from './probe-types'

export class DAGProbe implements IDAGProbe {
  constructor(private sessionService: IDAGSessionService) {}

  /**
   * 诊断节点为何阻塞：依赖未满足 / 并发饱和 / 条件待定 / 已就绪 / 已终态
   * @placeholder — 未来实现复用 execution-core.areDependenciesSatisfied
   */
  async explainBlock(workflowId: string): Promise<NodeBlockReason[]> {
    throw new Error('IDAGProbe.explainBlock: reserved interface — not yet implemented (D-PROBE-RESERVE)')
  }

  /**
   * 拓扑分层快照：DAG 层级视图 + 是否有环
   * @placeholder — 未来实现复用 execution-core.detectCycle（⚠️ 入参 DAGNodeConfig[]，非 DAGNodeSession[]）+ BFS 分层
   */
  async getTopology(workflowId: string): Promise<TopologySnapshot> {
    throw new Error('IDAGProbe.getTopology: reserved interface — not yet implemented (D-PROBE-RESERVE)')
  }

  /**
   * 执行状态快照：节点分布 + remaining spawn budget
   * @placeholder — 未来实现复用 execution-core.getReadyNodes + computeSpawnBudget
   */
  async getExecutionSnapshot(workflowId: string): Promise<ExecutionSnapshot> {
    throw new Error('IDAGProbe.getExecutionSnapshot: reserved interface — not yet implemented (D-PROBE-RESERVE)')
  }

  /**
   * 级联影响预测：某节点失败波及的 pending 后代
   * @placeholder — 未来实现复用 execution-core.findPendingDescendants
   */
  async predictCascade(workflowId: string, nodeId: string): Promise<CascadeImpact> {
    throw new Error('IDAGProbe.predictCascade: reserved interface — not yet implemented (D-PROBE-RESERVE)')
  }
}
