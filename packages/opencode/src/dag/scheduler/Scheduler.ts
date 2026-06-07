// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

import type { IScheduler } from './IScheduler';
import type {
  WorkerInfo,
  WorkerConfig,
  WorkerExecutionConfig,
  WorkerStatus,
  SchedulerEvent,
  IEventBus,
  ISchedulerPersister,
  WorkerExecutor,
} from './types';
import { TERMINAL_WORKER_STATUSES, VALID_WORKER_TRANSITIONS } from './types';
import {
  SchedulerError,
  WorkerNotFoundError,
  SchedulerStateNotPersistedError,
  WorkerTerminalViolationError,
  InvalidWorkerTransitionError,
} from './errors';
import type { WorkflowEvent, NodeEvent } from '../state-machine/types';

export class Scheduler implements IScheduler {
  private workers: Map<string, WorkerInfo> = new Map();
  private maxConcurrency: number = 5;
  private eventBus?: IEventBus;
  private persister?: ISchedulerPersister;
  private workerExecutor?: WorkerExecutor;

  constructor(
    eventBus?: IEventBus,
    persister?: ISchedulerPersister,
    workerExecutor?: WorkerExecutor,
  ) {
    this.eventBus = eventBus;
    this.persister = persister;
    this.workerExecutor = workerExecutor;
  }

  async createWorker(id: string, config: WorkerExecutionConfig): Promise<WorkerInfo> {
    const worker: WorkerInfo = {
      workerId: id,
      type: config.type,
      status: 'pending',
      config: {
        id,
        type: config.type,
        config: config.config || {},
        metadata: config.metadata
      }
    };
    this.workers.set(id, worker);
    // 铁律 #18: 持久化优先
    await this.persist();
    // 铁律 #17: 广播事件
    this.emit({
      type: 'scheduler.worker.created',
      workerId: id,
      timestamp: new Date(),
    });
    return worker;
  }

  async getWorker(id: string): Promise<WorkerInfo | undefined> {
    return this.workers.get(id);
  }

  async getAllWorkers(): Promise<WorkerInfo[]> {
    return Array.from(this.workers.values());
  }

  async getWorkersByStatus(status: WorkerStatus): Promise<WorkerInfo[]> {
    return Array.from(this.workers.values()).filter(w => w.status === status);
  }

  async updateWorkerStatus(id: string, status: WorkerStatus): Promise<void> {
    const worker = this.workers.get(id);
    if (!worker) {
      throw new WorkerNotFoundError(id);
    }

    const currentStatus = worker.status;

    // 铁律 #19: 终态不可逆
    if ((TERMINAL_WORKER_STATUSES as ReadonlyArray<string>).includes(currentStatus)) {
      throw new WorkerTerminalViolationError(id, currentStatus, status);
    }

    // 铁律 #19: 状态机不可绕过 — 验证转移合法性
    const validNexts = VALID_WORKER_TRANSITIONS[currentStatus];
    if (!(validNexts as ReadonlyArray<string>).includes(status)) {
      throw new InvalidWorkerTransitionError(id, currentStatus, status);
    }

    // 铁律 #18（rollback 模式，参考 WorktreeManager.ts:193-202）:
    //   先更新内存至新状态，再持久化；持久化失败时回滚内存到旧状态。
    const oldStatus = currentStatus;
    worker.status = status;
    try {
      await this.persist();
    } catch (e) {
      worker.status = oldStatus;
      throw e;
    }

    // 铁律 #17: 广播事件（持久化成功后才广播）
    this.emit({
      type: 'scheduler.worker.state_changed',
      workerId: id,
      oldStatus: currentStatus,
      newStatus: status,
      timestamp: new Date(),
    });
  }

  async executeWorker(id: string, context: any): Promise<any> {
    const worker = this.workers.get(id);
    if (!worker) {
      throw new WorkerNotFoundError(id);
    }

    // 检查并发限制
    const runningCount = await this.getRunningCount();
    if (runningCount >= this.maxConcurrency) {
      throw new SchedulerError(`Maximum concurrency (${this.maxConcurrency}) reached`);
    }

    worker.startTime = Date.now();
    // 通过 updateWorkerStatus 统一状态变更，保证铁律 #17 + #18 + #19
    await this.updateWorkerStatus(id, 'running');

    // P1: 外部注入执行函数；未注入时拒绝执行
    const executor = this.workerExecutor;
    if (!executor) {
      throw new SchedulerError(`No executor registered for worker: ${id}`);
    }

    try {
      const result = await executor(worker, context);
      worker.endTime = Date.now();
      worker.result = result;
      await this.updateWorkerStatus(id, 'completed');
      return result;
    } catch (error) {
      worker.endTime = Date.now();
      worker.error = error instanceof Error ? error.message : String(error);
      await this.updateWorkerStatus(id, 'failed');
      throw error;
    }
  }

  async cancelWorker(id: string, reason?: string): Promise<void> {
    const worker = this.workers.get(id);
    if (!worker) {
      return;
    }
    worker.endTime = Date.now();
    // 通过 updateWorkerStatus 统一状态变更
    await this.updateWorkerStatus(id, 'cancelled');
  }

  async executeWorkers(ids: string[], context: any, maxConcurrency?: number): Promise<any[]> {
    const limit = maxConcurrency || this.maxConcurrency;
    const results: any[] = [];
    const queue = [...ids];

    while (queue.length > 0) {
      const batch = queue.splice(0, limit);
      const batchPromises = batch.map(id => this.executeWorker(id, context));
      const batchResults = await Promise.allSettled(batchPromises);
      
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          results.push({ error: result.reason });
        }
      }
    }

    return results;
  }

  async waitForWorkers(ids: string[], timeoutMs?: number): Promise<WorkerInfo[]> {
    const startTime = Date.now();
    const timeout = timeoutMs || 60000;

    while (true) {
      const workers = await Promise.all(ids.map(id => this.getWorker(id)));
      const allCompleted = workers.every(w => 
        !w || w.status === 'completed' || w.status === 'failed' || w.status === 'cancelled'
      );

      if (allCompleted) {
        return workers.filter(w => w !== undefined) as WorkerInfo[];
      }

      if (Date.now() - startTime > timeout) {
        throw new SchedulerError('Timeout waiting for workers to complete');
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async getQueueSize(): Promise<number> {
    const queued = await this.getWorkersByStatus('queued');
    return queued.length;
  }

  async clearQueue(): Promise<void> {
    const queued = await this.getWorkersByStatus('queued');
    for (const worker of queued) {
      await this.cancelWorker(worker.workerId, 'Queue cleared');
    }
  }

  async getRunningCount(): Promise<number> {
    const running = await this.getWorkersByStatus('running');
    return running.length;
  }

  async getActiveCount(): Promise<number> {
    const running = await this.getRunningCount();
    const queued = await this.getQueueSize();
    return running + queued;
  }

  async setMaxConcurrency(max: number): Promise<void> {
    this.maxConcurrency = max;
  }

  async getMaxConcurrency(): Promise<number> {
    return this.maxConcurrency;
  }

  // ============================================================================
  // Iron Law: 事件广播 & 持久化 — §0.2, §0.3
  // ============================================================================

  /**
   * 持久化所有 Worker 状态
   *
   * 铁律 #18: 持久化优先于事件广播
   *
   * @throws {SchedulerStateNotPersistedError} persister.save() 抛出时
   */
  private async persist(): Promise<void> {
    if (!this.persister) return;
    try {
      await this.persister.save(this.workers);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new SchedulerStateNotPersistedError(reason);
    }
  }

  /**
   * 广播 Scheduler 事件
   *
   * 铁律 #17: 所有状态变更必须广播
   * §0.2: 共享 IEventBus，无自定义 on() 方法
   * §0.4: 跨模块类型桥接使用 as unknown as
   */
  private emit(event: SchedulerEvent): void {
    if (!this.eventBus) return;
    this.eventBus.emit(event as unknown as WorkflowEvent | NodeEvent);
  }
}
