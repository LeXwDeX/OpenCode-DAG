import { describe, it, expect, beforeEach } from 'bun:test';
import { Scheduler } from '../Scheduler';
import type { WorkerExecutionConfig } from '../types';
import { WorkerNotFoundError, SchedulerError } from '../errors';

describe('Scheduler Module', () => {
  let scheduler: Scheduler;

  beforeEach(() => {
    scheduler = new Scheduler();
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
