// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * @deprecated D-PLAN-RETIRE (2026-06-09) — Zero production references.
 * Session path has independent transition tables (execution-core.ts).
 * Do not import from production code. See AGENTS.md 退/留判定表.
 *
 * @file State Machine Errors
 * @description DAG 状态机错误类型定义
 * 
 * 参考：workflow-dag-architecture.md §3B.6, §3B.7
 * 
 * 铁律检查：
 * - 状态机不可绕过（所有状态转移必须通过引擎 API）
 * - 终态不可逆（节点一旦进入终态，不可回到 running）
 * - 事件必须广播
 */

import {
  WorkflowStatus,
  NodeStatus,
  ShadowNodeStatus,
  NodeType,
  WorkflowTransition,
  NodeTransition,
} from './types';

// ============================================================================
// 错误类型枚举
// ============================================================================

/**
 * 状态机错误代码
 * 
 * 所有状态机错误都必须使用以下代码之一。
 */
export enum ErrorCode {
  /** 非法状态转移 */
  INVALID_TRANSITION = 'INVALID_TRANSITION',
  /** 终态违规（尝试从终态转移） */
  TERMINAL_VIOLATION = 'TERMINAL_VIOLATION',
  /** 状态机绕过（直接修改 state.json） */
  STATE_MACHINE_VIOLATION = 'STATE_MACHINE_VIOLATION',
  /** 事件未广播 */
  EVENT_NOT_BROADCAST = 'EVENT_NOT_BROADCAST',
  /** 状态未持久化 */
  STATE_NOT_PERSISTED = 'STATE_NOT_PERSISTED',
  /** 缺少必需的节点 */
  MISSING_REQUIRED_NODE = 'MISSING_REQUIRED_NODE',
  /** 节点名称重复 */
  DUPLICATE_NODE_NAME = 'DUPLICATE_NODE_NAME',
  /** 依赖未满足 */
  DEPENDENCY_NOT_MET = 'DEPENDENCY_NOT_MET',
  /** Fallback 链深度超限 */
  FALLBACK_DEPTH_EXCEEDED = 'FALLBACK_DEPTH_EXCEEDED',
  /** Push 计数超限 */
  PUSH_COUNT_EXCEEDED = 'PUSH_COUNT_EXCEEDED',
}

// ============================================================================
// 基础错误类
// ============================================================================

/**
 * 状态机基础错误
 * 
 * 所有状态机错误都继承自此类。
 * 
 * @example
 * ```typescript
 * throw new StateMachineError(ErrorCode.INVALID_TRANSITION, 'Invalid transition');
 * ```
 */
export class StateMachineError extends Error {
  public readonly code: ErrorCode;
  public readonly context: Record<string, any>;
  public readonly timestamp: Date;

  constructor(
    code: ErrorCode,
    message: string,
    context: Record<string, any> = {}
  ) {
    super(message);
    this.name = 'StateMachineError';
    this.code = code;
    this.context = context;
    this.timestamp = new Date();
  }

  /**
   * 序列化为 JSON（用于日志和调试）
   */
  toJSON(): Record<string, any> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
      timestamp: this.timestamp.toISOString(),
      stack: this.stack,
    };
  }
}

// ============================================================================
// Workflow 级错误
// ============================================================================

/**
 * Workflow 非法状态转移错误
 * 
 * 当尝试执行不合法的 Workflow 状态转移时抛出。
 * 
 * @example
 * ```typescript
 * // Workflow 处于 COMPLETED 状态时尝试转移到 RUNNING
 * throw new InvalidWorkflowTransitionError(
 *   WorkflowStatus.COMPLETED,
 *   WorkflowStatus.RUNNING,
 *   WorkflowTransition.DAG_EXECUTE
 * );
 * ```
 */
export class InvalidWorkflowTransitionError extends StateMachineError {
  public readonly fromStatus: WorkflowStatus;
  public readonly toStatus: WorkflowStatus;
  public readonly transition: WorkflowTransition;

  constructor(
    fromStatus: WorkflowStatus,
    toStatus: WorkflowStatus,
    transition: WorkflowTransition
  ) {
    super(
      ErrorCode.INVALID_TRANSITION,
      `Invalid workflow transition: ${fromStatus} -> ${toStatus} (trigger: ${transition})`,
      { fromStatus, toStatus, transition }
    );
    this.name = 'InvalidWorkflowTransitionError';
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
    this.transition = transition;
  }
}

/**
 * Workflow 终态违规错误
 * 
 * 当尝试从 Workflow 终态（COMPLETED/FAILED/CANCELLED/ARCHIVED）转移时抛出。
 * 
 * @example
 * ```typescript
 * throw new WorkflowTerminalViolationError(
 *   WorkflowStatus.COMPLETED,
 *   WorkflowStatus.RUNNING
 * );
 * ```
 */
export class WorkflowTerminalViolationError extends StateMachineError {
  public readonly currentStatus: WorkflowStatus;
  public readonly attemptedStatus: WorkflowStatus;

  constructor(currentStatus: WorkflowStatus, attemptedStatus: WorkflowStatus) {
    super(
      ErrorCode.TERMINAL_VIOLATION,
      `Cannot transition from workflow terminal state: ${currentStatus} -> ${attemptedStatus}`,
      { currentStatus, attemptedStatus }
    );
    this.name = 'WorkflowTerminalViolationError';
    this.currentStatus = currentStatus;
    this.attemptedStatus = attemptedStatus;
  }
}

/**
 * Workflow 缺少必需节点错误
 * 
 * 当 Workflow 缺少 required_nodes 时抛出。
 * 
 * @example
 * ```typescript
 * throw new MissingRequiredNodeError('skeleton');
 * ```
 */
export class MissingRequiredNodeError extends StateMachineError {
  public readonly requiredNodeName: string;

  constructor(requiredNodeName: string) {
    super(
      ErrorCode.MISSING_REQUIRED_NODE,
      `Missing required node: ${requiredNodeName}`,
      { requiredNodeName }
    );
    this.name = 'MissingRequiredNodeError';
    this.requiredNodeName = requiredNodeName;
  }
}

// ============================================================================
// Node 级错误
// ============================================================================

/**
 * Node 非法状态转移错误
 * 
 * 当尝试执行不合法的 Node 状态转移时抛出。
 * 
 * @example
 * ```typescript
 * // Node 处于 SKIPPED 状态时尝试转移到 RUNNING
 * throw new InvalidNodeTransitionError(
 *   'implement',
 *   NodeStatus.SKIPPED,
 *   NodeStatus.RUNNING,
 *   NodeTransition.DEPENDENCIES_MET
 * );
 * ```
 */
export class InvalidNodeTransitionError extends StateMachineError {
  public readonly nodeName: string;
  public readonly fromStatus: NodeStatus | ShadowNodeStatus;
  public readonly toStatus: NodeStatus | ShadowNodeStatus;
  public readonly transition: NodeTransition;

  constructor(
    nodeName: string,
    fromStatus: NodeStatus | ShadowNodeStatus,
    toStatus: NodeStatus | ShadowNodeStatus,
    transition: NodeTransition
  ) {
    super(
      ErrorCode.INVALID_TRANSITION,
      `Invalid node transition: ${nodeName} (${fromStatus} -> ${toStatus}, trigger: ${transition})`,
      { nodeName, fromStatus, toStatus, transition }
    );
    this.name = 'InvalidNodeTransitionError';
    this.nodeName = nodeName;
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
    this.transition = transition;
  }
}

/**
 * Node 终态违规错误
 * 
 * 当尝试从 Node 终态（COMPLETED/FAILED/ABORTED/SKIPPED）转移时抛出。
 * 
 * @example
 * ```typescript
 * throw new NodeTerminalViolationError(
 *   'implement',
 *   NodeStatus.COMPLETED,
 *   NodeStatus.RUNNING
 * );
 * ```
 */
export class NodeTerminalViolationError extends StateMachineError {
  public readonly nodeName: string;
  public readonly currentStatus: NodeStatus | ShadowNodeStatus;
  public readonly attemptedStatus: NodeStatus | ShadowNodeStatus;

  constructor(
    nodeName: string,
    currentStatus: NodeStatus | ShadowNodeStatus,
    attemptedStatus: NodeStatus | ShadowNodeStatus
  ) {
    super(
      ErrorCode.TERMINAL_VIOLATION,
      `Cannot transition from node terminal state: ${nodeName} (${currentStatus} -> ${attemptedStatus})`,
      { nodeName, currentStatus, attemptedStatus }
    );
    this.name = 'NodeTerminalViolationError';
    this.nodeName = nodeName;
    this.currentStatus = currentStatus;
    this.attemptedStatus = attemptedStatus;
  }
}

/**
 * 节点名称重复错误
 * 
 * 当 DAG 中定义了两个同名节点时抛出。
 * 
 * @example
 * ```typescript
 * throw new DuplicateNodeNameError('implement');
 * ```
 */
export class DuplicateNodeNameError extends StateMachineError {
  public readonly nodeName: string;

  constructor(nodeName: string) {
    super(
      ErrorCode.DUPLICATE_NODE_NAME,
      `Duplicate node name: ${nodeName}`,
      { nodeName }
    );
    this.name = 'DuplicateNodeNameError';
    this.nodeName = nodeName;
  }
}

/**
 * 节点依赖未满足错误
 * 
 * 当尝试启动节点但其依赖的节点未完成时抛出。
 * 
 * @example
 * ```typescript
 * throw new DependencyNotMetError(
 *   'implement',
 *   ['skeleton', 'tdd']
 * );
 * ```
 */
export class DependencyNotMetError extends StateMachineError {
  public readonly nodeName: string;
  public readonly unmetDependencies: string[];

  constructor(nodeName: string, unmetDependencies: string[]) {
    super(
      ErrorCode.DEPENDENCY_NOT_MET,
      `Dependencies not met for node ${nodeName}: ${unmetDependencies.join(', ')}`,
      { nodeName, unmetDependencies }
    );
    this.name = 'DependencyNotMetError';
    this.nodeName = nodeName;
    this.unmetDependencies = unmetDependencies;
  }
}

/**
 * Fallback 链深度超限错误
 * 
 * 当节点的 fallback_count 超过 MAX_FALLBACK_COUNT 时抛出。
 * 
 * @example
 * ```typescript
 * throw new FallbackDepthExceededError('implement', 3, MAX_FALLBACK_COUNT);
 * ```
 */
export class FallbackDepthExceededError extends StateMachineError {
  public readonly nodeName: string;
  public readonly currentDepth: number;
  public readonly maxDepth: number;

  constructor(nodeName: string, currentDepth: number, maxDepth: number) {
    super(
      ErrorCode.FALLBACK_DEPTH_EXCEEDED,
      `Fallback depth exceeded for node ${nodeName}: ${currentDepth} > ${maxDepth}`,
      { nodeName, currentDepth, maxDepth }
    );
    this.name = 'FallbackDepthExceededError';
    this.nodeName = nodeName;
    this.currentDepth = currentDepth;
    this.maxDepth = maxDepth;
  }
}

/**
 * Push 计数超限错误
 * 
 * 当节点的 pushed_count 超过 MAX_PUSH_COUNT 时抛出。
 * 
 * @example
 * ```typescript
 * throw new PushCountExceededError('implement', 3, MAX_PUSH_COUNT);
 * ```
 */
export class PushCountExceededError extends StateMachineError {
  public readonly nodeName: string;
  public readonly currentCount: number;
  public readonly maxCount: number;

  constructor(nodeName: string, currentCount: number, maxCount: number) {
    super(
      ErrorCode.PUSH_COUNT_EXCEEDED,
      `Push count exceeded for node ${nodeName}: ${currentCount} > ${maxCount}`,
      { nodeName, currentCount, maxCount }
    );
    this.name = 'PushCountExceededError';
    this.nodeName = nodeName;
    this.currentCount = currentCount;
    this.maxCount = maxCount;
  }
}

// ============================================================================
// 持久化错误
// ============================================================================

/**
 * 状态持久化失败错误
 *
 * 当 persister.writeWorkflowState() 失败时抛出。
 * 铁律：状态持久化优先 — 持久化失败时状态不变，事件不广播。
 *
 * @example
 * ```typescript
 * throw new StateNotPersistedError('wf-123', 'disk full');
 * ```
 */
export class StateNotPersistedError extends StateMachineError {
  public readonly workflowId: string;

  constructor(workflowId: string, reason?: string) {
    super(
      ErrorCode.STATE_NOT_PERSISTED,
      `Workflow state not persisted for ${workflowId}${reason ? `: ${reason}` : ''}`,
      { workflowId, reason }
    );
    this.name = 'StateNotPersistedError';
    this.workflowId = workflowId;
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 判断 Workflow 状态是否为终态
 * 
 * @see §3B.1 - Workflow 级终态：COMPLETED, FAILED, CANCELLED, ARCHIVED
 */
export function isWorkflowTerminalStatus(status: WorkflowStatus): boolean {
  return [
    WorkflowStatus.COMPLETED,
    WorkflowStatus.FAILED,
    WorkflowStatus.CANCELLED,
    WorkflowStatus.ARCHIVED,
  ].includes(status);
}

/**
 * 判断 Node 状态是否为终态
 * 
 * @see §3B.1 - Node 级终态：COMPLETED, FAILED, ABORTED, SKIPPED
 */
export function isNodeTerminalStatus(
  status: NodeStatus | ShadowNodeStatus
): boolean {
  const terminals: ReadonlySet<NodeStatus | ShadowNodeStatus> = new Set([
    NodeStatus.COMPLETED,
    NodeStatus.FAILED,
    NodeStatus.ABORTED,
    NodeStatus.SKIPPED,
    ShadowNodeStatus.COMPLETED,
    ShadowNodeStatus.FAILED,
  ]);
  return terminals.has(status);
}

/**
 * 判断是否为 Shadow 节点状态
 * 
 * @param nodeType - 节点类型（必须显式传入以区分普通节点和 Shadow 节点）
 * @param status - 节点状态
 */
export function isShadowNodeStatus(
  nodeType: NodeType,
  status: NodeStatus | ShadowNodeStatus
): status is ShadowNodeStatus {
  return nodeType === NodeType.SHADOW;
}

/**
 * 获取节点的合法下一个状态
 * 
 * @param nodeType - 节点类型（必须显式传入以区分普通节点和 Shadow 节点）
 * @param currentStatus - 当前状态
 * @see §3B.2 - 状态转移图
 */
export function getValidNextNodeStatuses(
  nodeType: NodeType,
  currentStatus: NodeStatus | ShadowNodeStatus
): (NodeStatus | ShadowNodeStatus)[] {
  // Shadow 节点的状态转移规则
  if (isShadowNodeStatus(nodeType, currentStatus)) {
    switch (currentStatus) {
      case ShadowNodeStatus.PENDING:
        return [ShadowNodeStatus.RUNNING];
      case ShadowNodeStatus.RUNNING:
        return [ShadowNodeStatus.COMPLETED, ShadowNodeStatus.FAILED];
      case ShadowNodeStatus.COMPLETED:
      case ShadowNodeStatus.FAILED:
        return []; // 终态
    }
  }

  // 普通节点的状态转移规则
  switch (currentStatus) {
    case NodeStatus.PENDING:
      return [NodeStatus.QUEUED, NodeStatus.RUNNING, NodeStatus.SKIPPED];
    case NodeStatus.QUEUED:
      return [NodeStatus.RUNNING, NodeStatus.SKIPPED];
    case NodeStatus.RUNNING:
      return [
        NodeStatus.COMPLETED,
        NodeStatus.FAILED,
        NodeStatus.PAUSED,
      ];
    case NodeStatus.PAUSED:
      return [NodeStatus.RUNNING];
    case NodeStatus.FAILED:
      return [NodeStatus.RUNNING, NodeStatus.ABORTED];
    case NodeStatus.COMPLETED:
    case NodeStatus.ABORTED:
    case NodeStatus.SKIPPED:
      return []; // 终态
    default:
      return [];
  }
}

/**
 * 获取 Workflow 的合法下一个状态
 * 
 * @see §3B.2 - 状态转移图
 */
export function getValidNextWorkflowStatuses(
  currentStatus: WorkflowStatus
): WorkflowStatus[] {
  switch (currentStatus) {
    case WorkflowStatus.PENDING:
      return [WorkflowStatus.RUNNING];
    case WorkflowStatus.RUNNING:
      return [
        WorkflowStatus.PAUSED,
        WorkflowStatus.COMPLETED,
        WorkflowStatus.FAILED,
        WorkflowStatus.CANCELLED,
      ];
    case WorkflowStatus.PAUSED:
      return [WorkflowStatus.RUNNING, WorkflowStatus.CANCELLED];
    case WorkflowStatus.COMPLETED:
    case WorkflowStatus.FAILED:
    case WorkflowStatus.CANCELLED:
      return [WorkflowStatus.ARCHIVED];
    case WorkflowStatus.ARCHIVED:
      return []; // 终态
    default:
      return [];
  }
}
