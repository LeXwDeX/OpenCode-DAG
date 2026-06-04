/**
 * DAG 调度器类型定义
 */

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
