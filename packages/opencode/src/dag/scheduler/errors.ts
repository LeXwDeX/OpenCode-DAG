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

// ============================================================================
// Iron Law 错误 — §1.3
// ============================================================================

/**
 * Scheduler 状态持久化失败错误
 *
 * 铁律 #18: persister.save() 失败时抛出
 */
export class SchedulerStateNotPersistedError extends SchedulerError {
  readonly reason: string;

  constructor(reason: string) {
    super(`Scheduler state not persisted: ${reason}`);
    this.name = 'SchedulerStateNotPersistedError';
    this.reason = reason;
  }
}

/**
 * Worker 终态违规错误
 *
 * 铁律 #19: 试图从终态转移时抛出
 */
export class WorkerTerminalViolationError extends SchedulerError {
  readonly workerId: string;
  readonly currentStatus: string;
  readonly attemptedStatus: string;

  constructor(workerId: string, currentStatus: string, attemptedStatus: string) {
    super(
      `Worker ${workerId} is in terminal state '${currentStatus}', cannot transition to '${attemptedStatus}'`
    );
    this.name = 'WorkerTerminalViolationError';
    this.workerId = workerId;
    this.currentStatus = currentStatus;
    this.attemptedStatus = attemptedStatus;
  }
}

/**
 * 非法 Worker 状态转移错误
 *
 * 铁律 #19 (状态机不可绕过): 目标状态不在当前状态的合法转移集合中时抛出
 */
export class InvalidWorkerTransitionError extends SchedulerError {
  readonly workerId: string;
  readonly currentStatus: string;
  readonly attemptedStatus: string;

  constructor(workerId: string, currentStatus: string, attemptedStatus: string) {
    super(
      `Invalid worker transition for ${workerId}: ${currentStatus} -> ${attemptedStatus}`
    );
    this.name = 'InvalidWorkerTransitionError';
    this.workerId = workerId;
    this.currentStatus = currentStatus;
    this.attemptedStatus = attemptedStatus;
  }
}
