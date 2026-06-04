import type { IScheduler } from './IScheduler';
import type { WorkerInfo, WorkerConfig, WorkerExecutionConfig, WorkerStatus } from './types';
import { SchedulerError, WorkerNotFoundError } from './errors';

export class Scheduler implements IScheduler {
  private workers: Map<string, WorkerInfo> = new Map();
  private maxConcurrency: number = 5;

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
    worker.status = status;
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

    worker.status = 'running';
    worker.startTime = Date.now();

    try {
      const result = await this.simulateExecution(worker, context);
      worker.status = 'completed';
      worker.endTime = Date.now();
      worker.result = result;
      return result;
    } catch (error) {
      worker.status = 'failed';
      worker.endTime = Date.now();
      worker.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async cancelWorker(id: string, reason?: string): Promise<void> {
    const worker = this.workers.get(id);
    if (!worker) {
      return;
    }
    worker.status = 'cancelled';
    worker.endTime = Date.now();
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

  // 私有方法：模拟执行（实际实现中替换为真实逻辑）
  private async simulateExecution(worker: WorkerInfo, context: any): Promise<any> {
    // 模拟一些执行时间
    await new Promise(resolve => setTimeout(resolve, 100));
    return { success: true, workerId: worker.workerId };
  }
}
