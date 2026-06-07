// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

import type { WorkerConfig, WorkerInfo, WorkerStatus, WorkerExecutionConfig } from './types';

/**
 * DAG 调度器接口
 * 
 * 负责管理 Worker 的生命周期、并发执行、状态跟踪和结果收集。
 */
export interface IScheduler {
  /**
   * 创建新的 Worker
   * 
   * @param id - Worker ID
   * @param config - Worker 配置
   * @returns Worker 信息
   */
  createWorker(id: string, config: WorkerExecutionConfig): Promise<WorkerInfo>;

  /**
   * 获取 Worker 信息
   * 
   * @param workerId - Worker ID
   * @returns Worker 信息，如果不存在则返回 undefined
   */
  getWorker(workerId: string): Promise<WorkerInfo | undefined>;

  /**
   * 获取所有 Worker
   * 
   * @returns 所有 Worker 的列表
   */
  getAllWorkers(): Promise<WorkerInfo[]>;

  /**
   * 获取指定状态的 Worker 列表
   * 
   * @param status - Worker 状态
   * @returns Worker 列表
   */
  getWorkersByStatus(status: WorkerStatus): Promise<WorkerInfo[]>;

  /**
   * 更新 Worker 状态
   * 
   * @param workerId - Worker ID
   * @param status - 新状态
   */
  updateWorkerStatus(workerId: string, status: WorkerStatus): Promise<void>;

  /**
   * 执行 Worker
   * 
   * @param workerId - Worker ID
   * @param context - 执行上下文
   * @returns 执行结果
   */
  executeWorker(workerId: string, context: any): Promise<any>;

  /**
   * 取消 Worker 执行
   * 
   * @param workerId - Worker ID
   * @param reason - 取消原因
   */
  cancelWorker(workerId: string, reason?: string): Promise<void>;

  /**
   * 批量执行 Worker（并发执行）
   * 
   * @param workerIds - Worker ID 列表
   * @param context - 执行上下文
   * @param maxConcurrency - 最大并发数
   * @returns 执行结果列表
   */
  executeWorkers(
    workerIds: string[],
    context: any,
    maxConcurrency?: number
  ): Promise<any[]>;

  /**
   * 等待所有 Worker 完成
   * 
   * @param workerIds - Worker ID 列表
   * @param timeoutMs - 超时时间（毫秒）
   * @returns 执行结果列表
   */
  waitForWorkers(
    workerIds: string[],
    timeoutMs?: number
  ): Promise<WorkerInfo[]>;

  /**
   * 获取队列中的 Worker 数量
   * 
   * @returns 队列中的 Worker 数量
   */
  getQueueSize(): Promise<number>;

  /**
   * 清空队列
   */
  clearQueue(): Promise<void>;

  /**
   * 获取当前运行的 Worker 数量
   * 
   * @returns 当前运行的 Worker 数量
   */
  getRunningCount(): Promise<number>;

  /**
   * 设置最大并发数
   * 
   * @param maxConcurrency - 最大并发数
   */
  setMaxConcurrency(maxConcurrency: number): Promise<void>;

  /**
   * 获取最大并发数
   * 
   * @returns 最大并发数
   */
  getMaxConcurrency(): Promise<number>;
}
