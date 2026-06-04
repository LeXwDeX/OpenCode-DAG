import { describe, it, expect, beforeEach } from 'bun:test';
import { Scheduler } from '../Scheduler';
import type {
  WorkerExecutionConfig,
  SchedulerEvent,
  IEventBus,
  ISchedulerPersister,
  UnsubscribeFunction,
  WorkerInfo,
  WorkerExecutor,
} from '../types';
import {
  WorkerNotFoundError,
  SchedulerError,
  SchedulerStateNotPersistedError,
  WorkerTerminalViolationError,
  InvalidWorkerTransitionError,
} from '../errors';
import type { WorkflowEvent, NodeEvent } from '../../state-machine/types';

// 通用 stub executor：模拟成功执行，供无 executor 注入需求的测试使用
const stubExecutor: WorkerExecutor = async (worker) => ({
  success: true,
  workerId: worker.workerId,
});

describe('Scheduler Module', () => {
  let scheduler: Scheduler;

  beforeEach(() => {
    scheduler = new Scheduler(undefined, undefined, stubExecutor);
  });

  const makeConfig = (id: string, type: 'code' | 'review' | 'test' | 'deploy' | 'custom' = 'code'): WorkerExecutionConfig => ({
    workerId: id,
    type,
  });

  describe('Worker 生命周期管理', () => {
    it('should create a new worker', async () => {
      const worker = await scheduler.createWorker('worker-1', makeConfig('worker-1'));
      
      expect(worker).toBeDefined();
      expect(worker.workerId).toBe('worker-1');
      expect(worker.status).toBe('pending');
    });

    it('should get existing worker', async () => {
      await scheduler.createWorker('worker-1', makeConfig('worker-1'));
      
      const worker = await scheduler.getWorker('worker-1');
      expect(worker).toBeDefined();
      expect(worker?.workerId).toBe('worker-1');
    });

    it('should return undefined when worker not found', async () => {
      const worker = await scheduler.getWorker('non-existent');
      expect(worker).toBeUndefined();
    });

    it('should update worker status', async () => {
      await scheduler.createWorker('worker-1', makeConfig('worker-1'));
      
      await scheduler.updateWorkerStatus('worker-1', 'running');
      const worker = await scheduler.getWorker('worker-1');
      
      expect(worker?.status).toBe('running');
    });

    it('should cancel worker', async () => {
      await scheduler.createWorker('worker-1', makeConfig('worker-1'));
      
      await scheduler.cancelWorker('worker-1');
      
      const worker = await scheduler.getWorker('worker-1');
      expect(worker?.status).toBe('cancelled');
    });

    it('should get all workers', async () => {
      await scheduler.createWorker('worker-1', makeConfig('worker-1'));
      await scheduler.createWorker('worker-2', makeConfig('worker-2', 'review'));
      
      const workers = await scheduler.getAllWorkers();
      expect(workers).toHaveLength(2);
    });

    it('should get workers by status', async () => {
      await scheduler.createWorker('worker-1', makeConfig('worker-1'));
      await scheduler.createWorker('worker-2', makeConfig('worker-2'));
      
      await scheduler.updateWorkerStatus('worker-1', 'running');
      
      const running = await scheduler.getWorkersByStatus('running');
      expect(running).toHaveLength(1);
      expect(running[0].workerId).toBe('worker-1');
    });

    it('should mark worker as queued via status update', async () => {
      await scheduler.createWorker('worker-1', makeConfig('worker-1'));
      
      await scheduler.updateWorkerStatus('worker-1', 'queued');
      
      const worker = await scheduler.getWorker('worker-1');
      expect(worker?.status).toBe('queued');
    });

    it('should clear queue', async () => {
      await scheduler.createWorker('worker-1', makeConfig('worker-1'));
      await scheduler.createWorker('worker-2', makeConfig('worker-2'));
      
      await scheduler.updateWorkerStatus('worker-1', 'queued');
      await scheduler.updateWorkerStatus('worker-2', 'queued');
      
      await scheduler.clearQueue();
      
      const queued = await scheduler.getWorkersByStatus('queued');
      expect(queued).toHaveLength(0);
    });
  });

  describe('Worker 执行', () => {
    it('should execute worker', async () => {
      await scheduler.createWorker('worker-1', makeConfig('worker-1'));
      
      const result = await scheduler.executeWorker('worker-1', { taskId: 'task-1' });
      
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    it('should execute multiple workers', async () => {
      await scheduler.createWorker('worker-1', makeConfig('worker-1'));
      await scheduler.createWorker('worker-2', makeConfig('worker-2'));
      
      const results = await scheduler.executeWorkers(['worker-1', 'worker-2'], {});
      expect(results).toHaveLength(2);
      expect(results.every(r => r.success)).toBe(true);
    });

    it('should wait for workers to complete', async () => {
      await scheduler.createWorker('worker-1', makeConfig('worker-1'));
      
      // Execute in background
      const executePromise = scheduler.executeWorker('worker-1', {});
      
      const completed = await scheduler.waitForWorkers(['worker-1'], 5000);
      expect(completed).toHaveLength(1);
      expect(completed[0].status).toBe('completed');
      
      await executePromise;
    });
  });

  describe('Scheduler 配置和状态查询', () => {
    it('should set max concurrency', async () => {
      await scheduler.setMaxConcurrency(5);
    });

    it('should get max concurrency', async () => {
      await scheduler.setMaxConcurrency(5);
      const max = await scheduler.getMaxConcurrency();
      expect(max).toBe(5);
    });

    it('should get running count', async () => {
      const running = await scheduler.getRunningCount();
      expect(running).toBeGreaterThanOrEqual(0);
    });

    it('should get queue size', async () => {
      await scheduler.createWorker('worker-1', makeConfig('worker-1'));
      await scheduler.createWorker('worker-2', makeConfig('worker-2'));
      
      await scheduler.updateWorkerStatus('worker-1', 'queued');
      await scheduler.updateWorkerStatus('worker-2', 'queued');
      
      const queued = await scheduler.getQueueSize();
      expect(queued).toBe(2);
    });

    it('should get active count', async () => {
      await scheduler.createWorker('worker-1', makeConfig('worker-1'));
      await scheduler.createWorker('worker-2', makeConfig('worker-2'));
      
      await scheduler.updateWorkerStatus('worker-1', 'queued');
      await scheduler.updateWorkerStatus('worker-2', 'queued');
      
      const active = await scheduler.getActiveCount();
      expect(active).toBe(2);
    });
  });
});

// ============================================================================
// Iron Law Compliance — §1.3
// ============================================================================

function createStubEventBus(): {
  bus: IEventBus;
  events: SchedulerEvent[];
} {
  const events: SchedulerEvent[] = [];
  const bus: IEventBus = {
    subscribe(_event: string, _listener: (ev: WorkflowEvent | NodeEvent) => void): UnsubscribeFunction {
      return () => {};
    },
    emit(event: WorkflowEvent | NodeEvent): void {
      // 跨模块桥接：SchedulerEvent 通过 as unknown as 转换为 WorkflowEvent | NodeEvent
      events.push(event as unknown as SchedulerEvent);
    },
    destroy(): void {},
  };
  return { bus, events };
}

function createStubPersister(opts?: {
  shouldFail?: boolean;
  failReason?: string;
}): {
  persister: ISchedulerPersister;
  saveCalls: Map<string, WorkerInfo>[];
} {
  const saveCalls: Map<string, WorkerInfo>[] = [];
  const persister: ISchedulerPersister = {
    async save(workers: Map<string, WorkerInfo>): Promise<void> {
      saveCalls.push(new Map(workers));
      if (opts?.shouldFail) {
        throw new Error(opts.failReason ?? 'persist error');
      }
    },
    async load(): Promise<Map<string, WorkerInfo> | null> {
      return null;
    },
  };
  return { persister, saveCalls };
}

describe('Iron Law Compliance', () => {
  describe('#17 — Event Broadcasting', () => {
    it('createWorker 应该广播 scheduler.worker.created 事件', async () => {
      const { bus, events } = createStubEventBus();
      const scheduler = new Scheduler(bus);

      await scheduler.createWorker('w1', { workerId: 'w1', type: 'code' });

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('scheduler.worker.created');
      expect((events[0] as { workerId: string }).workerId).toBe('w1');
    });

    it('updateWorkerStatus 应该广播 scheduler.worker.state_changed 事件', async () => {
      const { bus, events } = createStubEventBus();
      const scheduler = new Scheduler(bus);

      await scheduler.createWorker('w1', { workerId: 'w1', type: 'code' });
      await scheduler.updateWorkerStatus('w1', 'running');

      const stateChangedEvents = events.filter(
        (e) => e.type === 'scheduler.worker.state_changed'
      );
      expect(stateChangedEvents).toHaveLength(1);
      const ev = stateChangedEvents[0] as {
        oldStatus: string;
        newStatus: string;
      };
      expect(ev.oldStatus).toBe('pending');
      expect(ev.newStatus).toBe('running');
    });
  });

  describe('#18 — Persistence Priority', () => {
    it('persist 必须先于 emit 被调用', async () => {
      const { bus, events } = createStubEventBus();
      const { persister, saveCalls } = createStubPersister();
      const scheduler = new Scheduler(bus, persister);

      const callOrder: string[] = [];
      const origEmit = bus.emit.bind(bus);
      bus.emit = (e: WorkflowEvent | NodeEvent) => {
        callOrder.push('emit');
        origEmit(e);
      };
      const origSave = persister.save.bind(persister);
      persister.save = async (w: Map<string, WorkerInfo>) => {
        callOrder.push('persist');
        return origSave(w);
      };

      await scheduler.createWorker('w1', { workerId: 'w1', type: 'code' });

      expect(callOrder.length).toBeGreaterThanOrEqual(2);
      expect(callOrder.indexOf('persist')).toBeLessThan(callOrder.indexOf('emit'));
    });

    it('持久化失败时应该抛出 SchedulerStateNotPersistedError 且不广播事件', async () => {
      const { bus, events } = createStubEventBus();
      // 使用切换式 persister：createWorker 时正常，updateWorkerStatus 时失败
      let shouldFail = false;
      const persister: ISchedulerPersister = {
        async save(_workers: Map<string, WorkerInfo>): Promise<void> {
          if (shouldFail) throw new Error('disk full');
        },
        async load(): Promise<Map<string, WorkerInfo> | null> {
          return null;
        },
      };
      const scheduler = new Scheduler(bus, persister);

      await scheduler.createWorker('w1', { workerId: 'w1', type: 'code' });
      // createWorker 会发出一个 created 事件
      const eventsAfterCreate = events.length;

      shouldFail = true;

      await expect(
        scheduler.updateWorkerStatus('w1', 'running')
      ).rejects.toBeInstanceOf(SchedulerStateNotPersistedError);

      // 持久化失败 → 不附加新事件，内存状态不变
      expect(events.length).toBe(eventsAfterCreate);
      expect(events.filter((e) => e.type === 'scheduler.worker.state_changed')).toHaveLength(0);
      const worker = await scheduler.getWorker('w1');
      expect(worker?.status).toBe('pending');
    });

    it('未注入 persister 时不抛出错误，正常广播事件', async () => {
      const { bus, events } = createStubEventBus();
      const scheduler = new Scheduler(bus); // 无 persister

      await scheduler.createWorker('w1', { workerId: 'w1', type: 'code' });
      await scheduler.updateWorkerStatus('w1', 'running');

      const stateChangedEvents = events.filter(
        (e) => e.type === 'scheduler.worker.state_changed'
      );
      expect(stateChangedEvents).toHaveLength(1);
    });
  });

  describe('#19 — Terminal States Immutable', () => {
    const terminalStatuses = ['completed', 'failed', 'cancelled', 'timeout'] as const;

    for (const terminal of terminalStatuses) {
      it(`${terminal} 状态下尝试转移应该抛出 WorkerTerminalViolationError`, async () => {
        const { bus } = createStubEventBus();
        const scheduler = new Scheduler(bus);

        await scheduler.createWorker('w1', { workerId: 'w1', type: 'code' });
        // 进入终态
        if (terminal === 'timeout') {
          // pending → running → timeout
          await scheduler.updateWorkerStatus('w1', 'running');
          await scheduler.updateWorkerStatus('w1', 'timeout');
        } else if (terminal === 'completed' || terminal === 'failed') {
          await scheduler.updateWorkerStatus('w1', 'running');
          await scheduler.updateWorkerStatus('w1', terminal);
        } else {
          await scheduler.updateWorkerStatus('w1', terminal);
        }

        // 试图从终态再次转移
        await expect(
          scheduler.updateWorkerStatus('w1', 'running')
        ).rejects.toBeInstanceOf(WorkerTerminalViolationError);
      });
    }
  });

  describe('#19 — Invalid Transition Rejected', () => {
    it('pending → timeout 非法转移应该抛出 InvalidWorkerTransitionError', async () => {
      const { bus } = createStubEventBus();
      const scheduler = new Scheduler(bus);

      await scheduler.createWorker('w1', { workerId: 'w1', type: 'code' });

      await expect(
        scheduler.updateWorkerStatus('w1', 'timeout')
      ).rejects.toBeInstanceOf(InvalidWorkerTransitionError);
    });

    it('pending → completed 非法转移应该抛出 InvalidWorkerTransitionError', async () => {
      const { bus } = createStubEventBus();
      const scheduler = new Scheduler(bus);

      await scheduler.createWorker('w1', { workerId: 'w1', type: 'code' });

      await expect(
        scheduler.updateWorkerStatus('w1', 'completed')
      ).rejects.toBeInstanceOf(InvalidWorkerTransitionError);
    });
  });

  describe('#19 — No Bypass (所有状态变更必须通过 updateWorkerStatus)', () => {
    it('executeWorker 成功时应该触发 state_changed 事件', async () => {
      const { bus, events } = createStubEventBus();
      const scheduler = new Scheduler(bus, undefined, stubExecutor);

      await scheduler.createWorker('w1', { workerId: 'w1', type: 'code' });
      await scheduler.executeWorker('w1', {});

      // 应该产生 pending→running 和 running→completed 两个 state_changed 事件
      const stateChangedEvents = events.filter(
        (e) => e.type === 'scheduler.worker.state_changed'
      );
      expect(stateChangedEvents.length).toBeGreaterThanOrEqual(2);

      const transitions = stateChangedEvents.map((e) => {
        const ev = e as { oldStatus: string; newStatus: string };
        return `${ev.oldStatus}->${ev.newStatus}`;
      });
      expect(transitions).toContain('pending->running');
      expect(transitions).toContain('running->completed');
    });

    it('cancelWorker 应该触发 state_changed 事件', async () => {
      const { bus, events } = createStubEventBus();
      const scheduler = new Scheduler(bus);

      await scheduler.createWorker('w1', { workerId: 'w1', type: 'code' });
      await scheduler.cancelWorker('w1');

      const stateChangedEvents = events.filter(
        (e) => e.type === 'scheduler.worker.state_changed'
      );
      expect(stateChangedEvents).toHaveLength(1);
      const ev = stateChangedEvents[0] as { oldStatus: string; newStatus: string };
      expect(ev.oldStatus).toBe('pending');
      expect(ev.newStatus).toBe('cancelled');
    });
  });
});

// ============================================================================
// P0: Persist Rollback Order — 铁律 #18 rollback 模式
// ============================================================================

describe('P0: Persist Rollback Order', () => {
  it('updateWorkerStatus persist 应该保存新状态（rollback 模式）', async () => {
    const { bus } = createStubEventBus();
    const { persister, saveCalls } = createStubPersister();
    const scheduler = new Scheduler(bus, persister);

    await scheduler.createWorker('w1', { workerId: 'w1', type: 'code' });
    const callsAfterCreate = saveCalls.length;

    await scheduler.updateWorkerStatus('w1', 'running');

    const updateCalls = saveCalls.slice(callsAfterCreate);
    expect(updateCalls).toHaveLength(1);
    const persisted = updateCalls[0];
    expect(persisted!.get('w1')?.status).toBe('running');
  });

  it('updateWorkerStatus persist 失败时应该回滚内存到旧状态', async () => {
    const { bus, events } = createStubEventBus();
    let shouldFail = false;
    const persister: ISchedulerPersister = {
      async save(_workers: Map<string, WorkerInfo>): Promise<void> {
        if (shouldFail) throw new Error('disk full');
      },
      async load(): Promise<Map<string, WorkerInfo> | null> {
        return null;
      },
    };
    const scheduler = new Scheduler(bus, persister);

    await scheduler.createWorker('w1', { workerId: 'w1', type: 'code' });
    const eventsAfterCreate = events.length;

    shouldFail = true;

    await expect(
      scheduler.updateWorkerStatus('w1', 'running')
    ).rejects.toBeInstanceOf(SchedulerStateNotPersistedError);

    const worker = await scheduler.getWorker('w1');
    expect(worker?.status).toBe('pending');
    expect(events.length).toBe(eventsAfterCreate);
  });
});

// ============================================================================
// P1: WorkerExecutor Injection
// ============================================================================

describe('P1: WorkerExecutor Injection', () => {
  it('executeWorker 应该调用注入的 executor 并返回其结果', async () => {
    const { bus } = createStubEventBus();
    const executorCalls: Array<{ workerId: string; context: unknown }> = [];
    const executor: WorkerExecutor = async (worker, context) => {
      executorCalls.push({ workerId: worker.workerId, context });
      return { done: true, workerId: worker.workerId };
    };
    const scheduler = new Scheduler(bus, undefined, executor);

    await scheduler.createWorker('w1', { workerId: 'w1', type: 'code' });
    const result = await scheduler.executeWorker('w1', { taskId: 't1' });

    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0]!.workerId).toBe('w1');
    expect(executorCalls[0]!.context).toEqual({ taskId: 't1' });
    expect(result).toEqual({ done: true, workerId: 'w1' });

    const worker = await scheduler.getWorker('w1');
    expect(worker?.status).toBe('completed');
  });

  it('executeWorker 未注入 executor 时应该抛出 SchedulerError', async () => {
    const { bus } = createStubEventBus();
    const scheduler = new Scheduler(bus);

    await scheduler.createWorker('w1', { workerId: 'w1', type: 'code' });

    await expect(
      scheduler.executeWorker('w1', {})
    ).rejects.toBeInstanceOf(SchedulerError);
  });

  it('executeWorker executor 抛出错误时应该标记 worker 为 failed', async () => {
    const { bus } = createStubEventBus();
    const executor: WorkerExecutor = async () => {
      throw new Error('execution boom');
    };
    const scheduler = new Scheduler(bus, undefined, executor);

    await scheduler.createWorker('w1', { workerId: 'w1', type: 'code' });

    await expect(
      scheduler.executeWorker('w1', {})
    ).rejects.toThrow('execution boom');

    const worker = await scheduler.getWorker('w1');
    expect(worker?.status).toBe('failed');
    expect(worker?.error).toBe('execution boom');
  });
});
