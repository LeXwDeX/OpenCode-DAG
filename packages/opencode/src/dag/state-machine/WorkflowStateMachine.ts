// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * @deprecated D-PLAN-RETIRE (2026-06-09) — Zero production references.
 * Session path (workflow-engine.ts + session-service.ts) is canonical.
 * Do not import from production code. See AGENTS.md 退/留判定表.
 *
 * @file Workflow State Machine Implementation
 * @description DAG 工作流状态机实现
 *
 * 参考：workflow-dag-architecture.md §3B.1-3B.4
 *
 * 铁律：
 * - #15: 状态机不可绕过
 * - #16: 终态不可逆
 * - #17: 事件必须广播
 */

import type {
  IWorkflowStateMachine,
  WorkflowTransitionParams,
  IEventBus,
  IStatePersister,
} from './IStateMachine';
import type { WorkflowEvent, WorkflowStateData } from './types';
import {
  WorkflowStatus,
  WorkflowTransition,
} from './types';
import {
  InvalidWorkflowTransitionError,
  WorkflowTerminalViolationError,
  StateNotPersistedError,
  isWorkflowTerminalStatus,
  getValidNextWorkflowStatuses,
} from './errors';

/**
 * Workflow 状态机实现
 *
 * @example
 * ```typescript
 * const stateMachine = new WorkflowStateMachine('abc123', eventBus, persister);
 * stateMachine.initialize(WorkflowStatus.PENDING);
 *
 * // 转移到 running
 * await stateMachine.transition({
 *   fromStatus: WorkflowStatus.PENDING,
 *   toStatus: WorkflowStatus.RUNNING,
 *   transition: WorkflowTransition.DAG_EXECUTE,
 * });
 * ```
 */
export class WorkflowStateMachine implements IWorkflowStateMachine {
  private currentStatus: WorkflowStatus;
  private eventBus: IEventBus;
  private persister: IStatePersister;
  private workflowId: string;

  /**
   * 构造函数
   *
   * @param workflowId - 工作流 ID
   * @param eventBus - 事件总线实例
   * @param persister - 状态持久化实例
   */
  constructor(workflowId: string, eventBus: IEventBus, persister: IStatePersister) {
    this.workflowId = workflowId;
    this.currentStatus = WorkflowStatus.PENDING;
    this.eventBus = eventBus;
    this.persister = persister;
  }

  /**
   * 初始化状态机
   *
   * @param initialStatus - 初始状态
   */
  initialize(initialStatus: WorkflowStatus): void {
    this.currentStatus = initialStatus;
  }

  /**
   * 获取当前状态
   *
   * @returns 当前状态
   */
  async getStatus(): Promise<WorkflowStatus> {
    return this.currentStatus;
  }

  /**
   * 获取所有有效的下一个状态
   *
   * @returns 有效的下一个状态数组
   */
  getValidNextStatuses(): WorkflowStatus[] {
    return getValidNextWorkflowStatuses(this.currentStatus);
  }

  /**
   * 检查状态转移是否有效
   *
   * @param toStatus - 目标状态
   * @returns 是否有效
   */
  isValidTransition(toStatus: WorkflowStatus): boolean {
    return getValidNextWorkflowStatuses(this.currentStatus).includes(toStatus);
  }

  /**
   * 更新状态（用于初始化或修复）
   *
   * 注意：此方法不验证合法性，仅用于初始化或异常恢复。
   * 正常使用应通过 transition() 方法。
   *
   * @param status - 新状态
   */
  async updateStatus(status: WorkflowStatus): Promise<void> {
    this.currentStatus = status;
  }

  /**
   * 执行状态转移
   *
   * 铁律顺序：验证 → 读取现有状态 → 合并 → 持久化 → 更新内存 → 广播事件
   *
   * @param params - 转移参数
   * @throws {InvalidWorkflowTransitionError} 如果转移无效
   * @throws {WorkflowTerminalViolationError} 如果从终态转移
   * @throws {StateNotPersistedError} 如果持久化失败
   */
  async transition(params: WorkflowTransitionParams): Promise<void> {
    const { fromStatus, toStatus, transition, reason, timestamp } = params;
    const eventTimestamp = timestamp || new Date();

    // 铁律 #15: 验证 fromStatus 匹配当前状态
    if (fromStatus !== this.currentStatus) {
      throw new InvalidWorkflowTransitionError(
        fromStatus,
        toStatus,
        transition
      );
    }

    // 铁律 #16: 终态不可逆
    if (isWorkflowTerminalStatus(this.currentStatus)) {
      throw new WorkflowTerminalViolationError(
        this.currentStatus,
        toStatus
      );
    }

    // 验证转移是否有效
    if (!this.isValidTransition(toStatus)) {
      throw new InvalidWorkflowTransitionError(
        fromStatus,
        toStatus,
        transition
      );
    }

    // 读取现有状态（读错误不静默降级，让异常自然冒泡到上层）
    const existingState = await this.persister.readWorkflowState(this.workflowId);

    // 铁律 #18: 状态持久化优先 — 先写入，后广播
    const stateSnapshot = buildStateSnapshot(this.workflowId, toStatus, eventTimestamp, existingState);
    try {
      await this.persister.writeWorkflowState(this.workflowId, stateSnapshot);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new StateNotPersistedError(this.workflowId, reason);
    }

    // 更新内存状态
    this.currentStatus = toStatus;

    // 铁律 #17: 事件必须广播
    this.emitEvent(fromStatus, toStatus, transition, reason, eventTimestamp);
  }

  /**
   * 发出状态转移事件
   *
   * @param fromStatus - 原始状态
   * @param toStatus - 新状态
   * @param transition - 转移类型
   * @param reason - 转移原因
   * @param timestamp - 事件时间戳
   */
  private emitEvent(
    fromStatus: WorkflowStatus,
    toStatus: WorkflowStatus,
    transition: WorkflowTransition,
    reason: string | undefined,
    timestamp: Date
  ): void {
    let event: WorkflowEvent;

    // 根据目标状态构造对应的事件
    switch (toStatus) {
      case WorkflowStatus.RUNNING:
        event = {
          type: 'workflow.started',
          workflow_id: this.workflowId,
          timestamp,
        };
        break;
      case WorkflowStatus.PAUSED:
        event = {
          type: 'workflow.paused',
          workflow_id: this.workflowId,
          paused_at: timestamp,
        };
        break;
      case WorkflowStatus.COMPLETED:
        event = {
          type: 'workflow.completed',
          workflow_id: this.workflowId,
          duration_ms: 0, // TODO: 计算实际持续时间
          accumulated_diff: '', // TODO: 提供实际的 diff
        };
        break;
      case WorkflowStatus.FAILED:
        event = {
          type: 'workflow.failed',
          workflow_id: this.workflowId,
          reason: reason || 'Unknown failure',
          failed_nodes: [], // TODO: 提供失败的节点列表
        };
        break;
      case WorkflowStatus.CANCELLED:
        event = {
          type: 'workflow.cancelled',
          workflow_id: this.workflowId,
          cancelled_at: timestamp,
        };
        break;
      case WorkflowStatus.ARCHIVED:
        event = {
          type: 'workflow.archived',
          workflow_id: this.workflowId,
          archived_at: timestamp,
        };
        break;
      default:
        event = {
          type: 'workflow.created',
          workflow_id: this.workflowId,
          template: 'default', // TODO: 提供实际的模板名
          timestamp,
        };
    }

    this.eventBus.emit(event);
  }
}

/**
 * 构造 WorkflowStateData 快照用于持久化
 *
 * 首次转换（existingState === null）：使用最小化逻辑
 * 非首次转换：合并到已有状态，保留 started_at / branches / accumulated_diff
 */
function buildStateSnapshot(
  workflowId: string,
  status: WorkflowStatus,
  timestamp: Date,
  existingState: WorkflowStateData | null
): WorkflowStateData {
  const iso = timestamp.toISOString();

  if (!existingState) {
    return {
      workflow_id: workflowId,
      status,
      started_at: iso,
      paused_at: status === WorkflowStatus.PAUSED ? iso : null,
      completed_at: isWorkflowTerminalStatus(status) ? iso : null,
      branches: {},
      accumulated_diff: null,
    };
  }

  return {
    ...existingState,
    status,
    paused_at: status === WorkflowStatus.PAUSED ? iso : existingState.paused_at,
    completed_at: isWorkflowTerminalStatus(status) ? iso : existingState.completed_at,
  };
}
