// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * @deprecated D-PLAN-RETIRE (2026-06-09) — Zero production references.
 * Session path defines its own scheduling types.
 * Do not import from production code. See AGENTS.md 退/留判定表.
 *
 * DAG 调度器类型定义
 *
 * 参考：architecture_constraints §0, §1.3
 *
 * 铁律：
 * - #17: 事件必须广播
 * - #18: 持久化优先
 * - #19: 终态不可逆
 */
import type {
  IEventBus,
  UnsubscribeFunction,
} from '../state-machine/IStateMachine';

// ============================================================================
// 1. 既有类型（不变）
// ============================================================================

/**
 * Worker 配置
 */
export interface WorkerConfig {
  /** Worker ID */
  id: string;
  /** Worker 类型 */
  type: WorkerType;
  /** Worker 参数 */
  config: Record<string, any>;
  /** Worker 元数据 */
  metadata?: Record<string, any>;
}

/**
 * Worker 类型
 */
export type WorkerType = 'code' | 'review' | 'test' | 'deploy' | 'custom';

/**
 * Worker 信息
 */
export interface WorkerInfo {
  /** Worker ID */
  workerId: string;
  /** Worker 类型 */
  type: WorkerType;
  /** Worker 状态 */
  status: WorkerStatus;
  /** Worker 配置 */
  config: WorkerConfig;
  /** 执行上下文 ID */
  contextId?: string;
  /** 开始时间 */
  startTime?: number;
  /** 完成时间 */
  endTime?: number;
  /** 执行结果 */
  result?: any;
  /** 错误信息 */
  error?: string;
}

/**
 * Worker 状态
 */
export type WorkerStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout';

/**
 * Worker 执行配置
 */
export interface WorkerExecutionConfig {
  /** Worker ID */
  workerId: string;
  /** Worker 类型 */
  type: WorkerType;
  /** Worker 特定配置 */
  config?: Record<string, any>;
  /** 元数据 */
  metadata?: Record<string, any>;
}

// ============================================================================
// 2. Iron Law 常量 — §1.3
// ============================================================================

/**
 * Worker 终态集合
 *
 * 铁律 #19: 以下状态一旦进入，不可再转移到其他状态
 */
export const TERMINAL_WORKER_STATUSES: ReadonlyArray<WorkerStatus> = [
  'completed',
  'failed',
  'cancelled',
  'timeout',
] as const;

/**
 * 合法的 Worker 状态转移表
 *
 * key = 当前状态，value = 可达到的下一状态
 *
 * 铁律 #19: 终态对应的数组为空
 */
export const VALID_WORKER_TRANSITIONS: Record<
  WorkerStatus,
  ReadonlyArray<WorkerStatus>
> = {
  pending: ['queued', 'running', 'cancelled'],
  queued: ['running', 'cancelled'],
  running: ['completed', 'failed', 'cancelled', 'timeout'],
  completed: [],
  failed: [],
  cancelled: [],
  timeout: [],
} as const;

// ============================================================================
// 3. Scheduler 事件
// ============================================================================

/**
 * Worker 创建事件
 */
export interface SchedulerWorkerCreatedEvent {
  readonly type: 'scheduler.worker.created';
  readonly workerId: string;
  readonly timestamp: Date;
}

/**
 * Worker 状态变更事件
 */
export interface SchedulerWorkerStateChangedEvent {
  readonly type: 'scheduler.worker.state_changed';
  readonly workerId: string;
  readonly oldStatus: WorkerStatus;
  readonly newStatus: WorkerStatus;
  readonly timestamp: Date;
}

/**
 * Worker 完成事件
 */
export interface SchedulerWorkerCompletedEvent {
  readonly type: 'scheduler.worker.completed';
  readonly workerId: string;
  readonly result: unknown;
  readonly timestamp: Date;
}

/**
 * Worker 执行失败事件
 */
export interface SchedulerWorkerExecutionErrorEvent {
  readonly type: 'scheduler.worker.execution_error';
  readonly workerId: string;
  readonly error: string;
  readonly timestamp: Date;
}

/**
 * 所有 Scheduler 事件的并集
 */
export type SchedulerEvent =
  | SchedulerWorkerCreatedEvent
  | SchedulerWorkerStateChangedEvent
  | SchedulerWorkerCompletedEvent
  | SchedulerWorkerExecutionErrorEvent;

// ============================================================================
// 4. 持久化依赖接口 — §0.3
// ============================================================================

/**
 * Scheduler 状态持久化接口
 *
 * 可选依赖，不注入时跳过持久化。
 * 铁律 #18: 状态持久化优先于事件广播。
 */
export interface ISchedulerPersister {
  /**
   * 保存所有 Worker 信息
   *
   * @param workers - Worker 映射表
   * @throws Error - 持久化失败时由上层包装为 SchedulerStateNotPersistedError
   */
  save(workers: Map<string, WorkerInfo>): Promise<void>;

  /**
   * 加载所有 Worker 信息
   *
   * @returns Worker 映射表（不存在时返回 null）
   */
  load(): Promise<Map<string, WorkerInfo> | null>;
}

// ============================================================================
// 5. Worker 执行器类型 — §0.1
// ============================================================================

/**
 * Worker 执行器函数
 *
 * 用于注入真实执行逻辑，替代硬编码的 simulateExecution。
 * 可选依赖：不注入时 executeWorker 应抛出 SchedulerError。
 */
export type WorkerExecutor = (worker: WorkerInfo, context: unknown) => Promise<unknown>;

// Re-export IEventBus / UnsubscribeFunction 供外部使用
export type { IEventBus, UnsubscribeFunction };
