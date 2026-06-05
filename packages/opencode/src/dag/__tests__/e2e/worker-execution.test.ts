/**
 * DAG E2E Worker Execution 集成测试
 *
 * 测试真实的 worker 执行场景：
 * - 串行工作流（A → B → C）
 * - 并行工作流（A → [B, C] → D）
 * - 复杂 DAG（菱形依赖图）
 * - Worker 失败处理
 * - 并发限制
 * - Worker 状态转换
 * - 多工作流交叉调度
 * - Worktree 集成
 *
 * 使用 mock WorkerExecutor 模拟真实任务执行逻辑
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { Scheduler } from '../../scheduler/Scheduler';
import type {
  WorkerExecutionConfig,
  WorkerInfo,
  WorkerExecutor,
  IEventBus,
  ISchedulerPersister,
  UnsubscribeFunction,
} from '../../scheduler/types';
import type { WorkflowEvent, NodeEvent } from '../../state-machine/types';
import type { GroupEvent } from '../../group-manager/types';
import type { WorktreeEvent } from '../../worktree-manager/types';
import { WorktreeManager } from '../../worktree-manager/WorktreeManager';

// ============================================================================
// Mock WorkerExecutor — 可追踪的 executor 函数
// ============================================================================

interface ExecutionRecord {
  workerId: string;
  startTime: number;
  endTime: number;
  status: 'success' | 'failed';
  context?: unknown;
}

function createMockExecutor() {
  const records: ExecutionRecord[] = [];
  const failureScenarios = new Set<string>();
  const delayMap = new Map<string, number>();

  const executor: WorkerExecutor = async (
    worker: WorkerInfo,
    context: unknown,
  ): Promise<unknown> => {
    const delay = delayMap.get(worker.workerId) ?? 10;
    await new Promise((r) => setTimeout(r, delay));

    if (failureScenarios.has(worker.workerId)) {
      records.push({
        workerId: worker.workerId,
        startTime: Date.now(),
        endTime: Date.now(),
        status: 'failed',
        context,
      });
      throw new Error(`Worker ${worker.workerId} simulated failure`);
    }

    records.push({
      workerId: worker.workerId,
      startTime: Date.now(),
      endTime: Date.now(),
      status: 'success',
      context,
    });

    return {
      workerId: worker.workerId,
      result: `completed-${worker.workerId}`,
    };
  };

  return {
    executor,
    records,
    addFailure: (id: string) => failureScenarios.add(id),
    setDelay: (id: string, ms: number) => delayMap.set(id, ms),
    getExecutionOrder: () => records.map((r) => r.workerId),
    clear: () => {
      records.length = 0;
      failureScenarios.clear();
      delayMap.clear();
    },
  };
}

// ============================================================================
// Mock IEventBus
// ============================================================================

class MockEventBus implements IEventBus {
  events: any[] = [];

  subscribe(
    _event: string,
    _listener: (event: any) => void,
  ): UnsubscribeFunction {
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
// Mock ISchedulerPersister
// ============================================================================

class MockSchedulerPersister implements ISchedulerPersister {
  storage: Map<string, WorkerInfo> = new Map();

  async save(workers: Map<string, WorkerInfo>): Promise<void> {
    this.storage = new Map(workers);
  }

  async load(): Promise<Map<string, WorkerInfo>> {
    return new Map(this.storage);
  }
}

// ============================================================================
// E2E Worker Execution 测试
// ============================================================================

describe('E2E Worker Execution', () => {
  let scheduler: Scheduler;
  let mock: ReturnType<typeof createMockExecutor>;
  let eventBus: MockEventBus;
  let persister: MockSchedulerPersister;

  beforeEach(() => {
    mock = createMockExecutor();
    eventBus = new MockEventBus();
    persister = new MockSchedulerPersister();
    scheduler = new Scheduler(eventBus, persister, mock.executor);
  });

  const makeConfig = (
    id: string,
    type: 'code' | 'review' | 'test' | 'deploy' | 'custom' = 'code',
  ): WorkerExecutionConfig => ({
    workerId: id,
    type,
  });

  // ======================================================================
  // 串行工作流
  // ======================================================================

  describe('串行工作流', () => {
    it('按顺序执行 A → B → C', async () => {
      await scheduler.createWorker('worker-A', makeConfig('worker-A'));
      await scheduler.createWorker('worker-B', makeConfig('worker-B'));
      await scheduler.createWorker('worker-C', makeConfig('worker-C'));

      await scheduler.executeWorker('worker-A', {});
      await scheduler.executeWorker('worker-B', {});
      await scheduler.executeWorker('worker-C', {});

      expect(mock.getExecutionOrder()).toEqual(['worker-A', 'worker-B', 'worker-C']);
    });

    it('传递上下文给下游 worker', async () => {
      await scheduler.createWorker('worker-A', makeConfig('worker-A'));
      await scheduler.createWorker('worker-B', makeConfig('worker-B'));

      const resultA = await scheduler.executeWorker('worker-A', { input: 'data-A' });
      const resultB = await scheduler.executeWorker('worker-B', { prev: resultA });

      expect(resultA).toEqual({ workerId: 'worker-A', result: 'completed-worker-A' });
      expect(resultB).toEqual({ workerId: 'worker-B', result: 'completed-worker-B' });

      // 验证 context 通过 records 可追踪
      const [recA, recB] = mock.records;
      expect(recA.context).toEqual({ input: 'data-A' });
      expect(recB.context).toEqual({ prev: resultA });
    });
  });

  // ======================================================================
  // 并行工作流
  // ======================================================================

  describe('并行工作流', () => {
    it('并发执行 A → [B, C] → D', async () => {
      for (const id of ['worker-A', 'worker-B', 'worker-C', 'worker-D']) {
        await scheduler.createWorker(id, makeConfig(id));
        mock.setDelay(id, 50);
      }

      // 先执行 A
      await scheduler.executeWorker('worker-A', {});

      // 并发执行 B 和 C
      const start = Date.now();
      const [resultB, resultC] = await Promise.all([
        scheduler.executeWorker('worker-B', {}),
        scheduler.executeWorker('worker-C', {}),
      ]);
      const elapsed = Date.now() - start;

      // 并发执行应 < 100ms（两个 50ms 任务并行）
      expect(elapsed).toBeLessThan(150);
      expect(resultB).toEqual({ workerId: 'worker-B', result: 'completed-worker-B' });
      expect(resultC).toEqual({ workerId: 'worker-C', result: 'completed-worker-C' });

      // 最后执行 D
      const resultD = await scheduler.executeWorker('worker-D', { inputs: [resultB, resultC] });
      expect(resultD).toEqual({ workerId: 'worker-D', result: 'completed-worker-D' });
    });
  });

  // ======================================================================
  // 复杂 DAG 工作流（菱形依赖图）
  // ======================================================================

  describe('复杂 DAG 工作流（菱形依赖图）', () => {
    it('处理多汇聚 DAG: A → [B,C] → [D,E] → F', async () => {
      for (const id of ['A', 'B', 'C', 'D', 'E', 'F']) {
        await scheduler.createWorker(`w-${id}`, makeConfig(`w-${id}`));
        mock.setDelay(`w-${id}`, 20);
      }

      // 执行 A
      await scheduler.executeWorker('w-A', {});

      // 并发执行 B 和 C
      await Promise.all([
        scheduler.executeWorker('w-B', {}),
        scheduler.executeWorker('w-C', {}),
      ]);

      // 并发执行 D 和 E
      await Promise.all([
        scheduler.executeWorker('w-D', {}),
        scheduler.executeWorker('w-E', {}),
      ]);

      // 执行 F
      await scheduler.executeWorker('w-F', {});

      // 验证所有 worker 都完成
      const workers = await scheduler.getAllWorkers();
      expect(workers.filter((w) => w.status === 'completed')).toHaveLength(6);
    });
  });

  // ======================================================================
  // Worker 失败处理
  // ======================================================================

  describe('Worker 失败处理', () => {
    it('抛出错误当 worker 失败', async () => {
      await scheduler.createWorker('failing', makeConfig('failing'));
      mock.addFailure('failing');

      await expect(scheduler.executeWorker('failing', {})).rejects.toThrow(
        'Worker failing simulated failure',
      );
    });

    it('失败 worker 状态记录为 failed', async () => {
      await scheduler.createWorker('failing', makeConfig('failing'));
      mock.addFailure('failing');

      try {
        await scheduler.executeWorker('failing', {});
      } catch {
        // 预期失败
      }

      const worker = await scheduler.getWorker('failing');
      expect(worker?.status).toBe('failed');
      expect(worker?.error).toBe('Worker failing simulated failure');
    });

    it('并发执行中部分失败应抛出错误', async () => {
      await scheduler.createWorker('ok-A', makeConfig('ok-A'));
      await scheduler.createWorker('fail-B', makeConfig('fail-B'));
      await scheduler.createWorker('ok-C', makeConfig('ok-C'));
      mock.addFailure('fail-B');

      const results = await Promise.allSettled([
        scheduler.executeWorker('ok-A', {}),
        scheduler.executeWorker('fail-B', {}),
        scheduler.executeWorker('ok-C', {}),
      ]);

      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected');
      expect(results[2].status).toBe('fulfilled');
    });
  });

  // ======================================================================
  // 并发限制
  // ======================================================================

  describe('并发限制', () => {
    it('在并发限制下顺序分批执行', async () => {
      // 默认 maxConcurrency = 5
      // 创建 10 个 worker，每个 50ms，应分 2 批执行
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        const id = `worker-${i}`;
        ids.push(id);
        await scheduler.createWorker(id, makeConfig(id));
        mock.setDelay(id, 30);
      }

      // 使用 executeWorkers 调度
      const results = await scheduler.executeWorkers(ids, {}, 5);

      // 所有 10 个 worker 都完成
      expect(results).toHaveLength(10);
      results.forEach((r) => {
        expect(r).toHaveProperty('workerId');
      });
    });

    it('使用 executeWorkers 处理并发批次（不抛错）', async () => {
      // maxConcurrency 默认 5，创建 8 个 worker
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) {
        const id = `w-${i}`;
        ids.push(id);
        await scheduler.createWorker(id, makeConfig(id));
        mock.setDelay(id, 20);
      }

      // executeWorkers 应自动分批，所有 worker 最终完成
      const results = await scheduler.executeWorkers(ids, {}, 3);
      expect(results).toHaveLength(8);

      // 所有 worker 最终状态为 completed
      const workers = await scheduler.getAllWorkers();
      expect(workers.filter((w) => w.status === 'completed')).toHaveLength(8);
    });
  });

  // ======================================================================
  // Worker 状态转换
  // ======================================================================

  describe('Worker 状态转换', () => {
    it('成功执行后状态为 completed', async () => {
      await scheduler.createWorker('status-ok', makeConfig('status-ok'));
      await scheduler.executeWorker('status-ok', {});

      const worker = await scheduler.getWorker('status-ok');
      expect(worker?.status).toBe('completed');
    });

    it('状态转换发出事件（铁律 #17）', async () => {
      await scheduler.createWorker('status-event', makeConfig('status-event'));
      eventBus.clear();
      await scheduler.executeWorker('status-event', {});

      const events = eventBus.getEvents();
      // 应该有 state_changed 事件：pending → running → completed
      const stateChanged = events.filter(
        (e) => e.type === 'scheduler.worker.state_changed',
      );
      expect(stateChanged.length).toBeGreaterThanOrEqual(2);
    });

    it('持久化记录状态变更（铁律 #18）', async () => {
      await scheduler.createWorker('persist-test', makeConfig('persist-test'));
      await scheduler.executeWorker('persist-test', {});

      const persisted = await persister.load();
      const worker = persisted.get('persist-test');
      expect(worker?.status).toBe('completed');
    });

    it('终态不可逆（铁律 #19）', async () => {
      await scheduler.createWorker('final-state', makeConfig('final-state'));
      await scheduler.executeWorker('final-state', {});

      // 尝试再次将 completed worker 转回 running，应抛错
      await expect(
        scheduler.updateWorkerStatus('final-state', 'running'),
      ).rejects.toThrow();
    });
  });

  // ======================================================================
  // 多工作流交叉调度
  // ======================================================================

  describe('多工作流交叉调度', () => {
    it('两个独立工作流并行完成', async () => {
      // 工作流 1: A1 → B1 → C1
      await scheduler.createWorker('w1-A', makeConfig('w1-A', 'code'));
      await scheduler.createWorker('w1-B', makeConfig('w1-B', 'review'));
      await scheduler.createWorker('w1-C', makeConfig('w1-C', 'test'));

      // 工作流 2: A2 → B2
      await scheduler.createWorker('w2-A', makeConfig('w2-A', 'code'));
      await scheduler.createWorker('w2-B', makeConfig('w2-B', 'deploy'));

      // 并发执行两个工作流
      const [resultC1, resultB2] = await Promise.all([
        executeWorkflow(['w1-A', 'w1-B', 'w1-C']),
        executeWorkflow(['w2-A', 'w2-B']),
      ]);

      expect(resultC1).toEqual({ workerId: 'w1-C', result: 'completed-w1-C' });
      expect(resultB2).toEqual({ workerId: 'w2-B', result: 'completed-w2-B' });

      // 验证所有 worker 都完成
      const workers = await scheduler.getAllWorkers();
      expect(workers).toHaveLength(5);
      expect(workers.filter((w) => w.status === 'completed')).toHaveLength(5);
    });

    it('按类型过滤 worker（铁律 #7: 类型安全）', async () => {
      await scheduler.createWorker('code-A', makeConfig('code-A', 'code'));
      await scheduler.createWorker('review-A', makeConfig('review-A', 'review'));
      await scheduler.createWorker('test-A', makeConfig('test-A', 'test'));

      // 按状态获取
      await scheduler.executeWorker('code-A', {});
      const completed = await scheduler.getWorkersByStatus('completed');
      expect(completed).toHaveLength(1);
      expect(completed[0].type).toBe('code');
    });

    async function executeWorkflow(ids: string[]): Promise<any> {
      let result;
      for (const id of ids) {
        result = await scheduler.executeWorker(id, {});
      }
      return result;
    }
  });

  // ======================================================================
  // Worktree 集成
  // ======================================================================

  describe('Worktree 集成', () => {
    it('独立创建 WorktreeManager 并调用 list', () => {
      const tempBase = '/tmp/worktree-e2e';
      const wm = new WorktreeManager(eventBus, undefined as any, tempBase);

      // 初始为空列表
      return wm.list().then((list) => {
        expect(list).toEqual([]);
      });
    });
  });
});
