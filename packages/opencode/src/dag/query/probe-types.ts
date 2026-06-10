// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * DAG Internal Diagnostic Probe — RESERVED INTERFACE (D-PROBE-RESERVE, 2026-06-10)
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  ⚠️ DO NOT DELETE — THIS IS INTENTIONALLY RESERVED, NOT DEAD   │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * WHY THIS LOOKS LIKE ORPHAN CODE:
 *   This file defines the diagnostic probe interface (IDAGProbe) and its
 *   5 data structures. It is deliberately NOT wired to any production surface:
 *   - No dagworker action enum entry (AGENT cannot call it)
 *   - No HTTP route (external callers cannot reach it)
 *   - No MCP tool registration (not in tool manifest)
 *   - Not in layer.ts assembly (not instantiated at boot)
 *
 * WHY IT EXISTS:
 *   The interface locks down the DAG diagnostic capability surface area so
 *   future implementation (backlog WP-4 / P2-A) does not need to redesign the
 *   data shapes or add/remove methods retroactively. Implementing later is
 *   then purely additive — fill the placeholder throws in dag-probe.ts with
 *   real logic reusing A-layer pure functions from execution-core.ts.
 *
 * ANTI-ORPHAN PROTECTION (4 layers):
 *   1. query-types.ts re-exports IDAGProbe (type-level anchor, ensures import chain)
 *   2. dag-probe.test.ts asserts the contract (type-level + throw placeholder)
 *   3. D-PROBE-RESERVE tag in file headers and error messages
 *   4. AGENTS.md §5 documents the intentional reservation + hidden boundary
 *
 * FUTURE IMPLEMENTOR GUIDE:
 *   Replace placeholder throws in dag-probe.ts with real logic:
 *   - explainBlock → areDependenciesSatisfied (execution-core.ts)
 *   - getTopology → detectCycle (DAGNodeConfig[], NOT DAGNodeSession[]) + BFS layers
 *   - getExecutionSnapshot → getReadyNodes + computeSpawnBudget
 *   - predictCascade → findPendingDescendants
 *   Keep the hidden boundary unless the user explicitly changes the decision.
 *   Probe runtime activation does NOT automatically expose it to agents.
 *   Future inspect should be a controlled façade over this internal probe,
 *   added only after an explicit user decision.
 */

/**
 * 节点阻塞原因诊断
 */
export interface NodeBlockReason {
  nodeId: string
  blocked: boolean
  unsatisfiedDependencies: string[]
  reason: 'deps_unsatisfied' | 'concurrency_saturated' | 'condition_pending' | 'ready' | 'terminal'
}

/**
 * 拓扑分层（同一 depth 的节点可并行）
 */
export interface TopologyLayer {
  depth: number
  nodeIds: string[]
}

/**
 * 拓扑快照（DAG 层级视图 + 是否有环）
 */
export interface TopologySnapshot {
  workflowId: string
  layers: TopologyLayer[]
  hasCycle: boolean
  totalDepth: number
}

/**
 * 执行状态快照（节点状态分布）
 */
export interface ExecutionSnapshot {
  workflowId: string
  running: string[]
  queued: string[]
  ready: string[]
  pending: string[]
  blocked: NodeBlockReason[]
  spawnBudget: number
}

/**
 * 级联影响预测（某节点失败波及的 pending 后代）
 */
export interface CascadeImpact {
  originNodeId: string
  affectedPendingNodeIds: string[]
}

/**
 * RESERVED INTERNAL DIAGNOSTIC PROBE — NOT wired to any agent-facing surface.
 * 不进 dagworker action 枚举、不加 HTTP 路由、不进 MCP 工具清单。
 */
export interface IDAGProbe {
  explainBlock(workflowId: string): Promise<NodeBlockReason[]>
  getTopology(workflowId: string): Promise<TopologySnapshot>
  getExecutionSnapshot(workflowId: string): Promise<ExecutionSnapshot>
  predictCascade(workflowId: string, nodeId: string): Promise<CascadeImpact>
}
