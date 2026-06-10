// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * @deprecated D-PLAN-RETIRE (2026-06-09) — Zero production references.
 * Session path (workflow-engine.ts + session-service.ts) is canonical.
 * Do not import from production code. See AGENTS.md 退/留判定表.
 *
 * @file NodeStateMachine Implementation
 * @description DAG 节点状态机实现
 *
 * 铁律执行：
 * - #1 状态机不可绕过：transition() 通过 getValidNextNodeStatuses() 验证
 * - #2 终态不可逆：isNodeTerminalStatus(fromStatus) && toStatus 不在 valid → NodeTerminalViolationError
 *                     （FAILED 是语义终态但有合法 retry 转移 RUNNING/ABORTED）
 * - #3 事件必须广播：所有状态变更 emit 对应事件（node.reset 已纳入 NodeEvent union）
 * - #4 持久化优先：先 persister.writeNodeState → 再内存 → 最后 emit；持久化失败 rollback
 *                   （统一封装在私有 helper persistAndApply()）
 *
 * 参考：
 * - WorkflowStateMachine.ts（持久化 rollback 模式）
 * - errors.ts::getValidNextNodeStatuses()（转移规则 ground truth）
 * - types.ts::NodeStateData（字段名 ground truth）
 * - spec/nodesm.md v2
 */

import type {
  INodeStateMachine,
  NodeTransitionParams,
  IEventBus,
  IStatePersister,
} from './IStateMachine'
import type { NodeStateData, BranchStateData, NodeEvent, WorkflowEvent } from './types'
import { NodeStatus, NodeType, FallbackTrigger, NodeTransition } from './types'
import {
  InvalidNodeTransitionError,
  NodeTerminalViolationError,
  StateNotPersistedError,
  isNodeTerminalStatus,
  getValidNextNodeStatuses,
} from './errors'

// ============================================================================
// 本地扩展持久化接口（WP1 — 不修改 IStateMachine.ts，WP2 再提升到公共接口）
// ============================================================================

interface INodeStatePersister extends IStatePersister {
  writeNodeState(
    workflowId: string,
    nodeName: string,
    state: NodeStateData
  ): Promise<void>
  readNodeState(
    workflowId: string,
    nodeName: string
  ): Promise<NodeStateData | null>
}

// ============================================================================
// NodeStateMachine
// ============================================================================

export class NodeStateMachine implements INodeStateMachine {
  /** nodeName → NodeStateData（扁平索引，用于快速单节点查询） */
  private memoryState: Map<string, NodeStateData> = new Map()
  /** branchName → (nodeName → NodeStateData)（用于分支聚合查询） */
  private branchMap: Map<string, Map<string, NodeStateData>> = new Map()
  /** nodeName → branchName（跨 map 关联；registerNode/transition 同步更新两个 map 时使用） */
  private nodeBranch: Map<string, string> = new Map()

  constructor(
    private workflowId: string,
    private eventBus?: IEventBus,
    private persister?: INodeStatePersister
  ) {
    if (!workflowId) {
      throw new Error('workflowId is required')
    }
  }

  // --------------------------------------------------------------------------
  // transition() — 核心状态转移
  // --------------------------------------------------------------------------
  async transition(params: NodeTransitionParams): Promise<void> {
    const { nodeName, fromStatus, toStatus, transition, output, timestamp } =
      params
    const eventTimestamp = timestamp || new Date()

    const existing = this.memoryState.get(nodeName)
    if (!existing) {
      throw new Error(`Node "${nodeName}" not found`)
    }

    // 验证 fromStatus 与内存状态一致（防绕过）
    if (existing.status !== fromStatus) {
      throw new InvalidNodeTransitionError(
        nodeName,
        existing.status,
        toStatus,
        transition
      )
    }

    const valid = getValidNextNodeStatuses(existing.node_type, fromStatus)

    // 铁律 #2：终态且目标不在 valid list（FAILED→RUNNING/ABORTED 仍允许）
    if (isNodeTerminalStatus(fromStatus) && !valid.includes(toStatus)) {
      throw new NodeTerminalViolationError(nodeName, fromStatus, toStatus)
    }

    // 铁律 #1：合法性校验
    if (!valid.includes(toStatus)) {
      throw new InvalidNodeTransitionError(
        nodeName,
        fromStatus,
        toStatus,
        transition
      )
    }

    // 构造新状态快照
    const newState: NodeStateData = {
      ...existing,
      status: toStatus,
      started_at:
        toStatus === NodeStatus.RUNNING && existing.started_at === null
          ? eventTimestamp.toISOString()
          : existing.started_at,
      completed_at:
        toStatus === NodeStatus.COMPLETED
          ? eventTimestamp.toISOString()
          : existing.completed_at,
      output_summary:
        toStatus === NodeStatus.COMPLETED && output !== undefined
          ? output
          : existing.output_summary,
    }

    // 铁律 #4 + 内存更新（统一封装）
    await this.persistAndApply(nodeName, newState)

    // 铁律 #3：事件广播
    this.emitTransitionEvent(
      nodeName,
      fromStatus as NodeStatus,
      toStatus as NodeStatus,
      eventTimestamp,
      params
    )
  }

  // --------------------------------------------------------------------------
  // getNodeState() — 单节点查询
  // --------------------------------------------------------------------------
  async getNodeState(nodeName: string): Promise<NodeStateData | null> {
    return this.memoryState.get(nodeName) ?? null
  }

  // --------------------------------------------------------------------------
  // getBranchState() — 分支聚合查询
  // --------------------------------------------------------------------------
  async getBranchState(
    branchName: string
  ): Promise<BranchStateData | null> {
    const branch = this.branchMap.get(branchName)
    if (!branch || branch.size === 0) return null

    const nodes: Record<string, NodeStateData> = {}
    for (const [name, state] of branch) {
      nodes[name] = state
    }

    return {
      branch_name: branchName,
      status: aggregateBranchStatus(Object.values(nodes)),
      nodes,
    }
  }

  // --------------------------------------------------------------------------
  // getAllNodeStates() — 全部分支查询
  // --------------------------------------------------------------------------
  async getAllNodeStates(): Promise<Record<string, BranchStateData>> {
    const result: Record<string, BranchStateData> = {}
    for (const [branchName, branch] of this.branchMap) {
      const nodes: Record<string, NodeStateData> = {}
      for (const [name, state] of branch) {
        nodes[name] = state
      }
      result[branchName] = {
        branch_name: branchName,
        status: aggregateBranchStatus(Object.values(nodes)),
        nodes,
      }
    }
    return result
  }

  // --------------------------------------------------------------------------
  // registerNode()
  // --------------------------------------------------------------------------
  async registerNode(
    workflowId: string,
    branchName: string,
    nodeName: string,
    isShadow: boolean
  ): Promise<void> {
    if (workflowId !== this.workflowId) {
      throw new Error(
        `Cannot register node from different workflow: expected ${this.workflowId}, got ${workflowId}`
      )
    }
    if (this.memoryState.has(nodeName)) {
      throw new Error(`Node "${nodeName}" already registered`)
    }

    const initialState: NodeStateData = {
      node_name: nodeName,
      node_type: isShadow ? NodeType.SHADOW : NodeType.NORMAL,
      status: NodeStatus.PENDING,
      output_summary: null,
      skipped_by: null,
      started_at: null,
      completed_at: null,
      pushed_count: 0,
      fallback_count: 0,
      fallback_trigger_reason: null,
    }

    // 铁律 #4 + 内存更新（branchOverride 用于首次注册分支表及 nodeBranch 索引）
    await this.persistAndApply(nodeName, initialState, branchName)

    // 事件广播
    this.emit({
      type: 'node.registered',
      workflow_id: this.workflowId,
      node_name: nodeName,
      node_type: initialState.node_type,
    })
  }

  // --------------------------------------------------------------------------
  // resetNode() — admin bypass（跳过铁律 #1/#2，保留 #3/#4）
  // --------------------------------------------------------------------------
  async resetNode(nodeName: string): Promise<void> {
    const existing = this.memoryState.get(nodeName)
    if (!existing) {
      throw new Error(`Node "${nodeName}" not found`)
    }

    const resetState: NodeStateData = {
      ...existing,
      status: NodeStatus.PENDING,
      pushed_count: 0,
      fallback_count: 0,
      fallback_trigger_reason: null,
      started_at: null,
      completed_at: null,
      skipped_by: null,
      output_summary: null,
    }

    // 铁律 #4 + 内存更新
    await this.persistAndApply(nodeName, resetState)

    // 铁律 #3（node.reset 已纳入 NodeEvent union，方案 C）
    this.emit({
      type: 'node.reset',
      workflow_id: this.workflowId,
      node_name: nodeName,
    })
  }

  // --------------------------------------------------------------------------
  // skipNode() — 跳过节点（上游失败时）
  // --------------------------------------------------------------------------
  async skipNode(nodeName: string, reason: string): Promise<void> {
    const existing = this.memoryState.get(nodeName)
    if (!existing) {
      throw new Error(`Node "${nodeName}" not found`)
    }

    // Iron Law #1: 验证 from-status 允许转移到 SKIPPED
    // getValidNextNodeStatuses() ground truth: SKIPPED 仅对 PENDING/QUEUED 合法
    const validNext = getValidNextNodeStatuses(
      existing.node_type,
      existing.status
    )
    if (!validNext.includes(NodeStatus.SKIPPED)) {
      throw new InvalidNodeTransitionError(
        nodeName,
        existing.status,
        NodeStatus.SKIPPED,
        NodeTransition.SKIP_ON_FAILURE
      )
    }

    const skippedState: NodeStateData = {
      ...existing,
      status: NodeStatus.SKIPPED,
      skipped_by: reason,
    }

    // 铁律 #4 + 内存更新
    await this.persistAndApply(nodeName, skippedState)

    // 事件
    this.emit({
      type: 'node.skipped',
      workflow_id: this.workflowId,
      node_name: nodeName,
      upstream_failed_node: reason,
    })
  }

  // --------------------------------------------------------------------------
  // incrementPushCount()
  // --------------------------------------------------------------------------
  async incrementPushCount(nodeName: string, reason: string): Promise<void> {
    const existing = this.memoryState.get(nodeName)
    if (!existing) {
      throw new Error(`Node "${nodeName}" not found`)
    }

    const updated: NodeStateData = {
      ...existing,
      pushed_count: existing.pushed_count + 1,
    }

    // 铁律 #4 + 内存更新
    await this.persistAndApply(nodeName, updated)

    // 事件（types.ts 事件名为 'node.pushed'）
    this.emit({
      type: 'node.pushed',
      workflow_id: this.workflowId,
      node_name: nodeName,
      push_count: updated.pushed_count,
      reason,
    })
  }

  // --------------------------------------------------------------------------
  // incrementFallbackCount()
  // --------------------------------------------------------------------------
  async incrementFallbackCount(nodeName: string): Promise<void> {
    const existing = this.memoryState.get(nodeName)
    if (!existing) {
      throw new Error(`Node "${nodeName}" not found`)
    }

    const updated: NodeStateData = {
      ...existing,
      fallback_count: existing.fallback_count + 1,
    }

    // 铁律 #4 + 内存更新
    await this.persistAndApply(nodeName, updated)
  }

  // --------------------------------------------------------------------------
  // areAllRequiredNodesCompleted()
  // --------------------------------------------------------------------------
  async areAllRequiredNodesCompleted(
    requiredNodes: string[]
  ): Promise<boolean> {
    for (const nodeName of requiredNodes) {
      const state = this.memoryState.get(nodeName)
      if (!state || state.status !== NodeStatus.COMPLETED) {
        return false
      }
    }
    return true
  }

  // --------------------------------------------------------------------------
  // 私有：持久化优先 + 内存更新统一封装
  //   branchOverride：仅 registerNode 使用（首次注册分支表 + nodeBranch 索引）
  // --------------------------------------------------------------------------
  private async persistAndApply(
    nodeName: string,
    newState: NodeStateData,
    branchOverride?: string
  ): Promise<void> {
    if (this.persister) {
      try {
        await this.persister.writeNodeState(
          this.workflowId,
          nodeName,
          newState
        )
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause)
        throw new StateNotPersistedError(this.workflowId, reason)
      }
    }
    this.memoryState.set(nodeName, newState)
    const branchName = branchOverride ?? this.nodeBranch.get(nodeName)
    if (branchName) {
      if (!this.branchMap.has(branchName)) {
        this.branchMap.set(branchName, new Map())
      }
      this.branchMap.get(branchName)!.set(nodeName, newState)
    }
    if (branchOverride) {
      this.nodeBranch.set(nodeName, branchOverride)
    }
  }

  // --------------------------------------------------------------------------
  // 私有：转移事件 emit（spec §4 映射表，按 types.ts 命名）
  //   优先使用 NodeTransitionParams 中的可选字段填充 payload；缺省回退占位值
  // --------------------------------------------------------------------------
  private emitTransitionEvent(
    nodeName: string,
    fromStatus: NodeStatus,
    toStatus: NodeStatus,
    timestamp: Date,
    params: NodeTransitionParams
  ): void {
    let event: NodeEvent | null = null

    switch (toStatus) {
      case NodeStatus.RUNNING:
        if (
          fromStatus === NodeStatus.PENDING ||
          fromStatus === NodeStatus.QUEUED
        ) {
          event = {
            type: 'node.started',
            workflow_id: this.workflowId,
            node_name: nodeName,
            worktree_path: params.worktreePath ?? '',
          }
        } else if (fromStatus === NodeStatus.PAUSED) {
          event = {
            type: 'node.resumed',
            workflow_id: this.workflowId,
            node_name: nodeName,
            timestamp,
          }
        } else if (fromStatus === NodeStatus.FAILED) {
          event = {
            type: 'node.restarted',
            workflow_id: this.workflowId,
            node_name: nodeName,
            retry_count: params.retryCount ?? 0,
          }
        }
        break
      case NodeStatus.COMPLETED:
        event = {
          type: 'node.completed',
          workflow_id: this.workflowId,
          node_name: nodeName,
          output_summary: params.output ?? null,
          diff_stats: {
            files_changed_count: 0,
            lines_added: 0,
            lines_removed: 0,
            patch_file: '',
          },
        }
        break
      case NodeStatus.FAILED:
        event = {
          type: 'node.failed',
          workflow_id: this.workflowId,
          node_name: nodeName,
          trigger_reason: params.fallbackTrigger ?? FallbackTrigger.EXEC_FAILED,
        }
        break
      case NodeStatus.PAUSED:
        event = {
          type: 'node.paused',
          workflow_id: this.workflowId,
          node_name: nodeName,
          paused_at: timestamp,
        }
        break
      case NodeStatus.ABORTED:
        event = {
          type: 'node.aborted',
          workflow_id: this.workflowId,
          node_name: nodeName,
          reason: params.abortReason ?? '',
        }
        break
      case NodeStatus.SKIPPED:
        event = {
          type: 'node.skipped',
          workflow_id: this.workflowId,
          node_name: nodeName,
          upstream_failed_node: params.upstreamFailedNode ?? '',
        }
        break
      case NodeStatus.QUEUED:
        // QUEUED 无独立事件类型；不发出
        break
    }

    if (event) {
      this.emit(event)
    }
  }

  /** 统一 emit；eventBus 可选，缺则静默吞 */
  private emit(event: NodeEvent): void {
    this.eventBus?.emit(event)
  }
}

// ============================================================================
// 分支状态聚合（pure helper）
// ============================================================================

function aggregateBranchStatus(nodes: NodeStateData[]): NodeStatus {
  if (nodes.length === 0) return NodeStatus.PENDING

  const statuses = nodes.map((n) => n.status as NodeStatus)

  if (statuses.some((s) => s === NodeStatus.FAILED)) return NodeStatus.FAILED
  if (statuses.some((s) => s === NodeStatus.RUNNING)) return NodeStatus.RUNNING
  if (statuses.some((s) => s === NodeStatus.PAUSED)) return NodeStatus.PAUSED
  if (statuses.some((s) => s === NodeStatus.QUEUED)) return NodeStatus.QUEUED
  if (statuses.every((s) => s === NodeStatus.COMPLETED))
    return NodeStatus.COMPLETED
  if (statuses.every((s) => s === NodeStatus.SKIPPED))
    return NodeStatus.SKIPPED
  if (statuses.every((s) => s === NodeStatus.ABORTED))
    return NodeStatus.ABORTED

  return NodeStatus.PENDING
}
