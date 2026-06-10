// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * DAG Internal Diagnostic Probe — RESERVED INTERFACE (D-PROBE-RESERVE, 2026-06-10)
 *
 * 这是一个【有意预留的前向声明】诊断探针接口，不是死代码，禁止当作 "unused" 删除。
 * 实现被刻意推迟（见 .task_state/task_plan_dag_integration.md WP-4 可观察性探针）。
 * 刻意不暴露给 AGENT：不进 dagworker action 枚举、不加 HTTP 路由、不进 MCP 工具清单、不进 layer 装配。
 * 仅供未来 DAG 诊断/可观察性场景内部按需实例化。
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
