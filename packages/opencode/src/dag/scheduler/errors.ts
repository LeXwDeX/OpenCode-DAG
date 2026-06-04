/**
 * DAG 调度器错误类型
 */

/**
 * 调度错误基类
 */
export class SchedulerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchedulerError';
  }
}

/**
 * Worker 未找到错误
 */
export class WorkerNotFoundError extends SchedulerError {
  constructor(workerId: string) {
    super(`Worker not found: ${workerId}`);
    this.name = 'WorkerNotFoundError';
  }
}

/**
 * Worker 执行超时错误
 */
export class WorkerTimeoutError extends SchedulerError {
  constructor(workerId: string, timeoutMs: number) {
    super(`Worker ${workerId} timed out after ${timeoutMs}ms`);
    this.name = 'WorkerTimeoutError';
    this.workerId = workerId;
    this.timeoutMs = timeoutMs;
  }

  workerId: string;
  timeoutMs: number;
}

/**
 * Worker 执行失败错误
 */
export class WorkerExecutionError extends SchedulerError {
  constructor(workerId: string, error: Error) {
    super(`Worker ${workerId} execution failed: ${error.message}`);
    this.name = 'WorkerExecutionError';
    this.workerId = workerId;
    this.originalError = error;
  }

  workerId: string;
  originalError: Error;
}

/**
 * Worker 队列已满错误
 */
export class WorkerQueueFullError extends SchedulerError {
  constructor(maxWorkers: number) {
    super(`Worker queue is full (max: ${maxWorkers})`);
    this.name = 'WorkerQueueFullError';
    this.maxWorkers = maxWorkers;
  }

  maxWorkers: number;
}

/**
 * Worker 状态错误
 */
export class WorkerStateError extends SchedulerError {
  constructor(workerId: string, currentState: string, expectedState: string) {
    super(`Worker ${workerId} is in state '${currentState}', expected '${expectedState}'`);
    this.name = 'WorkerStateError';
    this.workerId = workerId;
    this.currentState = currentState;
    this.expectedState = expectedState;
  }

  workerId: string;
  currentState: string;
  expectedState: string;
}

/**
 * Worker 取消错误
 */
export class WorkerCancelledError extends SchedulerError {
  constructor(workerId: string, reason?: string) {
    super(`Worker ${workerId} was cancelled${reason ? `: ${reason}` : ''}`);
    this.name = 'WorkerCancelledError';
    this.workerId = workerId;
    this.reason = reason;
  }

  workerId: string;
  reason?: string;
}
