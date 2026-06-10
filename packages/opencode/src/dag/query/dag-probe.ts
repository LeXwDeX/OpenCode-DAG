// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * DAG Internal Diagnostic Probe — ACTIVE but HIDDEN (activated 2026-06-10)
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  ⚠️ ACTIVE but HIDDEN — do not wire to dagworker / HTTP / MCP  │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * This class provides the runtime implementation of IDAGProbe (see
 * probe-types.ts). Activated by explicit user request on 2026-06-10,
 * replacing the previous placeholder throws.
 *
 * HIDDEN BOUNDARY (不可违反):
 *   - 不进 dagworker action 枚举
 *   - 不加 HTTP 路由
 *   - 不进 MCP 工具清单
 *   - 不进 layer.ts 装配
 *   - 不暴露给 AGENT
 *
 * READ-ONLY:
 *   - All methods read via sessionService (Effect-based, Effect.runPromise)
 *   - Zero writes, zero emits, zero state machine bypass
 *
 * REUSE:
 *   All methods delegate to A-layer pure functions from execution-core.ts:
 *   - explainBlock        → areDependenciesSatisfied
 *   - getTopology         → detectCycle (⚠️ DAGNodeConfig[]) + BFS 分层
 *   - getExecutionSnapshot → getReadyNodes + computeSpawnBudget
 *   - predictCascade      → findPendingDescendants
 */

import { Effect } from 'effect'
import type { IDAGSessionService } from '../session/session-service'
import type {
  IDAGProbe,
  NodeBlockReason,
  TopologySnapshot,
  ExecutionSnapshot,
  CascadeImpact,
} from './probe-types'
import {
  areDependenciesSatisfied,
  detectCycle,
  computeSpawnBudget,
  findPendingDescendants,
} from '../session/execution-core'

export class DAGProbe implements IDAGProbe {
  constructor(private sessionService: IDAGSessionService) {}

  /**
   * 诊断节点为何阻塞：依赖未满足 / 已就绪 / 已终态
   */
  async explainBlock(workflowId: string): Promise<NodeBlockReason[]> {
    const nodes = await Effect.runPromise(this.sessionService.listNodes(workflowId))
    const completedIds = new Set(
      nodes.filter(n => n.status === 'completed').map(n => n.node_id),
    )

    return nodes
      .filter(n => n.status !== 'completed' && n.status !== 'failed' && n.status !== 'skipped')
      .map(node => {
        const satisfied = areDependenciesSatisfied(node, completedIds)
        return {
          nodeId: node.node_id,
          blocked: !satisfied,
          unsatisfiedDependencies: satisfied
            ? []
            : node.dependencies.filter(dep => !completedIds.has(dep)),
          reason: satisfied ? 'ready' : 'deps_unsatisfied',
        } satisfies NodeBlockReason
      })
  }

  /**
   * 拓扑分层快照：DAG 层级视图 + 是否有环
   * detectCycle 入参必须是 DAGNodeConfig[]（从 workflow.config.nodes 获取）
   */
  async getTopology(workflowId: string): Promise<TopologySnapshot> {
    const workflow = await Effect.runPromise(this.sessionService.getWorkflow(workflowId))
    if (!workflow) throw new Error(`Workflow ${workflowId} not found`)

    const configNodes = workflow.config.nodes
    const hasCycle = detectCycle(configNodes)

    // Kahn's algorithm BFS 分层
    const idSet = new Set(configNodes.map(n => n.id))
    const reverseGraph = new Map<string, string[]>() // dep → [nodes that depend on it]
    for (const n of configNodes) {
      for (const dep of n.dependencies) {
        if (!idSet.has(dep)) continue // skip external references
        const list = reverseGraph.get(dep)
        if (list) list.push(n.id)
        else reverseGraph.set(dep, [n.id])
      }
    }

    const inDegree = new Map<string, number>()
    for (const n of configNodes) inDegree.set(n.id, 0)
    for (const [, dependents] of reverseGraph) {
      for (const dId of dependents) {
        inDegree.set(dId, (inDegree.get(dId) ?? 0) + 1)
      }
    }

    let queue = configNodes.filter(n => (inDegree.get(n.id) ?? 0) === 0).map(n => n.id)
    const layers: { depth: number; nodeIds: string[] }[] = []
    let depth = 0
    while (queue.length > 0) {
      layers.push({ depth, nodeIds: [...queue] })
      const next: string[] = []
      for (const id of queue) {
        for (const dId of reverseGraph.get(id) ?? []) {
          const cur = inDegree.get(dId) ?? 0
          inDegree.set(dId, cur - 1)
          if (cur - 1 === 0) next.push(dId)
        }
      }
      queue = next
      depth++
    }

    return {
      workflowId,
      layers,
      hasCycle,
      totalDepth: layers.length,
    }
  }

  /**
   * 执行状态快照：节点分布 + remaining spawn budget
   */
  async getExecutionSnapshot(workflowId: string): Promise<ExecutionSnapshot> {
    const [nodes, workflow] = await Promise.all([
      Effect.runPromise(this.sessionService.listNodes(workflowId)),
      Effect.runPromise(this.sessionService.getWorkflow(workflowId)),
    ])

    const maxConcurrency = workflow?.config.max_concurrency ?? 1
    const runningNodes = nodes.filter(n => n.status === 'running')
    const queuedNodes = nodes.filter(n => n.status === 'queued')
    const completedIds = new Set(
      nodes.filter(n => n.status === 'completed').map(n => n.node_id),
    )

    const spawnBudget = computeSpawnBudget(maxConcurrency, runningNodes.length, queuedNodes.length)

    const pendingNodes = nodes.filter(n => n.status === 'pending')
    const readyNodes = pendingNodes.filter(n => areDependenciesSatisfied(n, completedIds))
    const blockedReasons = pendingNodes
      .filter(n => !areDependenciesSatisfied(n, completedIds))
      .map(node => ({
        nodeId: node.node_id,
        blocked: true,
        unsatisfiedDependencies: node.dependencies.filter(dep => !completedIds.has(dep)),
        reason: 'deps_unsatisfied' as const,
      }))

    return {
      workflowId,
      running: runningNodes.map(n => n.node_id),
      queued: queuedNodes.map(n => n.node_id),
      ready: readyNodes.map(n => n.node_id),
      pending: pendingNodes.filter(n => !areDependenciesSatisfied(n, completedIds)).map(n => n.node_id),
      blocked: blockedReasons,
      spawnBudget,
    }
  }

  /**
   * 级联影响预测：某节点失败波及的 pending 后代
   */
  async predictCascade(workflowId: string, nodeId: string): Promise<CascadeImpact> {
    const nodes = await Effect.runPromise(this.sessionService.listNodes(workflowId))
    const affectedPendingNodeIds = findPendingDescendants(nodes, nodeId).map(n => n.node_id)
    return { originNodeId: nodeId, affectedPendingNodeIds }
  }
}
