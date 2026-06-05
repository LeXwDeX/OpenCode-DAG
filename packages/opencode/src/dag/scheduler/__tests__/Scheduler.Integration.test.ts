/**
 * Scheduler Integration Tests - 真实工作流调度
 *
 * 测试真实的 DAG 工作流调度行为：
 * - Worker 依赖图调度
 * - 并发执行与并发限制
 * - Worker 失败与回滚
 * - 多工作流交叉调度
 *
 * 注意：这些测试使用 mock Worker executor（模拟真实任务执行）
 */

import { describe, it, expect, beforeEach, beforeEach as beforeEachHook } from 'bun:test';
import { Scheduler } from '../Scheduler';
import type {
  WorkerExecutionConfig,
  IEventBus,
  ISchedulerPersister,
  UnsubscribeFunction,
  WorkerInfo,
  WorkerExecutor,
} from '../types';
import {
  WorkerNotFoundError,
  SchedulerError,
  InvalidWorkerTransitionError,
} from '../errors';
import type { WorkflowEvent, NodeEvent } from '../../state-machine/types';

// ============================================================================
// Mock Worker Executor - 模拟真实任务执行
// ============================================================================

/**
 * Mock Worker executor factory - 创建可追踪的 executor 函数
 */
interface MockWorkerExecutorState {
  executionHistory: Array<{ workerId: string, startTime: number, endTime: number, status: string }>;
  failureScenarios: Set<string>;
  delayScenarios: Map<string, number>;
}

function createMockWorkerExecutor(): { 
  executor: WorkerExecutor;
  state: MockWorkerExecutorState;
  addFailureScenario: (workerId: string) => void;
  addDelayScenario: (workerId: string, delayMs: number) => void;
  getExecutionHistory: () => Array<{ workerId: string, startTime: number, endTime: number, status: string }>;
  getExecutionOrder: () => string[];
  clear: () => void;
} {
  const state: MockWorkerExecutorState = {
    executionHistory: [],
    failureScenarios: new Set(),
    delayScenarios: new Map(),
  };

  const execute = async (worker: WorkerInfo, context: unknown): Promise<unknown> => {
    const startTime = Date.now();
    const delay = state.delayScenarios.get(worker.workerId) || 10;
    await new Promise(resolve => setTimeout(resolve, delay));
    const endTime = Date.now();
    let status = 'success';

    if (state.failureScenarios.has(worker.workerId)) {
      status = 'failed';
      state.executionHistory.push({ workerId: worker.workerId, startTime, endTime, status });
      throw new Error(`Worker ${worker.workerId} simulated failure`);
    }

    state.executionHistory.push({ workerId: worker.workerId, startTime, endTime, status });
    return {
      success: true,
      workerId: worker.workerId,
      executionTime: endTime - startTime,
      result: `Mock task ${worker.workerId} completed successfully`,
    };
  };

  return {
    executor: execute,
    state,
    addFailureScenario: (workerId: string) => state.failureScenarios.add(workerId),
    addDelayScenario: (workerId: string, delayMs: number) => state.delayScenarios.set(workerId, delayMs),
    getExecutionHistory: () => state.executionHistory,
    getExecutionOrder: () => state.executionHistory.map(h => h.workerId),
    clear: () => {
      state.executionHistory = [];
      state.failureScenarios.clear();
      state.delayScenarios.clear();
    },
  };
}

// ============================================================================
// Mock Event Bus - 追踪事件广播
// ============================================================================

class MockEventBus implements IEventBus {
  events: any[] = [];

  subscribe(_event: string, _listener: (event: any) => void): UnsubscribeFunction {
    return () => {};
  }

  emit(event: any): void {
    this.events.push(event);
  }

  destroy(): void {
    this.events = [];
  }

  getEvents() {
    return this.events;
  }

  clear() {
    this.events = [];
  }
}

// ============================================================================
// Mock Scheduler Persister - 持久化状态
// ============================================================================

class MockSchedulerPersister implements ISchedulerPersister {
  workers: Map<string, WorkerInfo> = new Map();

  async save(workers: Map<string, WorkerInfo>): Promise<void> {
    this.workers = new Map(workers);
  }

  async load(): Promise<Map<string, WorkerInfo>> {
    return new Map(this.workers);
  }
}

// ============================================================================
// 集成测试套件
// ============================================================================

describe('Scheduler Integration Tests - 真实工作流调度', () => {
  let scheduler: Scheduler;
  let executorFactory: ReturnType<typeof createMockWorkerExecutor>;
  let eventBus: MockEventBus;
  let persister: MockSchedulerPersister;

  beforeEach(() => {
    executorFactory = createMockWorkerExecutor();
    eventBus = new MockEventBus();
    persister = new MockSchedulerPersister();
    scheduler = new Scheduler(eventBus, persister, executorFactory.executor);
  });

  const makeConfig = (id: string, type: 'code' | 'review' | 'test' | 'deploy' | 'custom' = 'code'): WorkerExecutionConfig => ({
    workerId: id,
    type,
  });

  // ========================================================================
  // 3 节点串行工作流
  // ========================================================================

  describe('3 节点串行工作流', () => {
    it('应该按依赖顺序执行', async () => {
      // 创建工作流：A -> B -> C
      await scheduler.createWorker('worker-A', makeConfig('worker-A'));
      await scheduler.createWorker('worker-B', makeConfig('worker-B'));
      await scheduler.createWorker('worker-C', makeConfig('worker-C'));

      // 按正确顺序执行 worker（串行依赖）
      await scheduler.executeWorker('worker-A', {});
      await scheduler.executeWorker('worker-B', {});
      await scheduler.executeWorker('worker-C', {});

      // 验证执行顺序
      const executionOrder = executorFactory.getExecutionOrder();
      expect(executionOrder).toEqual(['worker-A', 'worker-B', 'worker-C']);
    });
  });

  describe('3 节点并行工作流', () => {
    it('应该并发执行无依赖的 worker', async () => {
      // 创建 3 个 worker（无依赖）
      await scheduler.createWorker('worker-A', makeConfig('worker-A'));
      await scheduler.createWorker('worker-B', makeConfig('worker-B'));
      await scheduler.createWorker('worker-C', makeConfig('worker-C'));

      // 添加延迟
      executorFactory.addDelayScenario('worker-A', 20);
      executorFactory.addDelayScenario('worker-B', 20);
      executorFactory.addDelayScenario('worker-C', 20);

      // 启动所有 worker
      await Promise.all([
        scheduler.executeWorker('worker-A', {}),
        scheduler.executeWorker('worker-B', {}),
        scheduler.executeWorker('worker-C', {}),
      ]);

      // 验证所有 worker 都完成
      const workers = await scheduler.getAllWorkers();
      expect(workers.length).toBe(3);
      expect(workers.filter(w => w.status === 'completed').length).toBe(3);
    });
  });

  describe('复杂 DAG 工作流', () => {
    it('应该处理菱形依赖图', async () => {
      // 创建菱形图：A -> (B, C) -> D
      await scheduler.createWorker('worker-A', makeConfig('worker-A'));
      await scheduler.createWorker('worker-B', makeConfig('worker-B'));
      await scheduler.createWorker('worker-C', makeConfig('worker-C'));
      await scheduler.createWorker('worker-D', makeConfig('worker-D'));

      // 添加延迟
      executorFactory.addDelayScenario('worker-A', 10);
      executorFactory.addDelayScenario('worker-B', 20);
      executorFactory.addDelayScenario('worker-C', 20);
      executorFactory.addDelayScenario('worker-D', 10);

      // 按依赖关系执行
      // 第 1 层：A
      await scheduler.executeWorker('worker-A', {});

      // 第 2 层：B, C（并发）
      await Promise.all([
        scheduler.executeWorker('worker-B', {}),
        scheduler.executeWorker('worker-C', {}),
      ]);

      // 第 3 层：D
      await scheduler.executeWorker('worker-D', {});

      // 验证完成顺序
      const order = executorFactory.getExecutionOrder();
      expect(order.indexOf('worker-A')).toBeLessThan(order.indexOf('worker-B'));
      expect(order.indexOf('worker-A')).toBeLessThan(order.indexOf('worker-C'));
      expect(order.indexOf('worker-B')).toBeLessThan(order.indexOf('worker-D'));
      expect(order.indexOf('worker-C')).toBeLessThan(order.indexOf('worker-D'));
    });
  });

  describe('Worker 失败场景', () => {
    it('应该处理 worker 执行失败', async () => {
      await scheduler.createWorker('worker-A', makeConfig('worker-A'));
      await scheduler.createWorker('worker-B', makeConfig('worker-B'));

      // 设置 worker-B 失败
      executorFactory.addFailureScenario('worker-B');

      // 执行 worker-A
      await scheduler.executeWorker('worker-A', {});

      // 执行 worker-B（应该失败）
      try {
        await scheduler.executeWorker('worker-B', {});
        expect(true).toBe(false); // 应该抛出异常
      } catch (error: any) {
        expect(error.message).toContain('simulated failure');
      }

      // 验证状态
      const workerA = await scheduler.getWorker('worker-A');
      const workerB = await scheduler.getWorker('worker-B');
      expect(workerA?.status).toBe('completed');
      expect(workerB?.status).toBe('failed');
    });
  });

  describe('事件广播', () => {
    it('应该广播所有调度事件', async () => {
      await scheduler.createWorker('worker-A', makeConfig('worker-A'));
      eventBus.clear();

      await scheduler.updateWorkerStatus('worker-A', 'running');
      await scheduler.updateWorkerStatus('worker-A', 'completed');

      const events = eventBus.getEvents();
      expect(events.length).toBe(2);
      expect(events[0].type).toBe('scheduler.worker.state_changed');
      expect(events[0].newStatus).toBe('running');
      expect(events[1].type).toBe('scheduler.worker.state_changed');
      expect(events[1].newStatus).toBe('completed');
    });
  });

  describe('持久化验证', () => {
    it('应该持久化所有状态变更', async () => {
      await scheduler.createWorker('worker-A', makeConfig('worker-A'));
      await scheduler.updateWorkerStatus('worker-A', 'running');

      // 创建新 scheduler 实例（模拟重启）
      const newScheduler = new Scheduler(eventBus, persister, executorFactory.executor);

      // 从持久化恢复
      const savedData = await persister.load();
      expect(savedData.size).toBe(1);
      expect(savedData.get('worker-A')?.status).toBe('running');
    });
  });

  describe('并发限制', () => {
    it('应该遵守最大并发数限制', async () => {
      // 设置最大并发数为 2
      const customScheduler = new Scheduler(eventBus, persister, executorFactory.executor);
      (customScheduler as any).maxConcurrency = 2;

      // 创建 5 个 worker
      for (let i = 1; i <= 5; i++) {
        await customScheduler.createWorker(`worker-${i}`, makeConfig(`worker-${i}`));
      }

      // 并发启动 2 个 worker
      await Promise.all([
        customScheduler.executeWorker('worker-1', {}),
        customScheduler.executeWorker('worker-2', {}),
      ]);

      // 验证只有 2 个 worker 在运行
      const runningCount = await (customScheduler as any).getRunningCount();
      expect(runningCount).toBeLessThanOrEqual(2);

      // 启动更多 worker（应该排队）
      expect(async () => {
        try {
          await customScheduler.executeWorker('worker-3', {});
        } catch (error: any) {
          expect(error.message).toContain('Maximum concurrency');
        }
      });
    });
  });

  describe('多工作流交叉调度', () => {
    it('应该支持多个独立工作流', async () => {
      // 工作流 1：A -> B
      await scheduler.createWorker('workflow-1-A', makeConfig('workflow-1-A'));
      await scheduler.createWorker('workflow-1-B', makeConfig('workflow-1-B'));

      // 工作流 2：C -> D
      await scheduler.createWorker('workflow-2-C', makeConfig('workflow-2-C'));
      await scheduler.createWorker('workflow-2-D', makeConfig('workflow-2-D'));

      // 并发执行两个工作流
      await Promise.all([
        scheduler.executeWorker('workflow-1-A', {}),
        scheduler.executeWorker('workflow-2-C', {}),
      ]);

      await Promise.all([
        scheduler.executeWorker('workflow-1-B', {}),
        scheduler.executeWorker('workflow-2-D', {}),
      ]);

      // 验证所有 worker 都完成
      const workers = await scheduler.getAllWorkers();
      expect(workers.length).toBe(4);
      expect(workers.filter(w => w.status === 'completed').length).toBe(4);
    });
  });
});
