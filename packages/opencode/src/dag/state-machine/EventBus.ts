// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * @file Event Bus Implementation
 * @description DAG 事件总线实现
 *
 * 参考：workflow-dag-architecture.md §3B.4
 *
 * 铁律：
 * - #17: 事件必须广播
 */

import type {
  IEventBus,
  EventEmitter,
  UnsubscribeFunction,
} from './IStateMachine';
import type { WorkflowEvent, NodeEvent } from './types';
import type { WorktreeEvent } from '../worktree-manager/types';
import type { GroupEvent } from '../group-manager/types';

/**
 * 简单的事件总线实现
 *
 * @example
 * ```typescript
 * const eventBus = new EventBus();
 *
 * // 订阅事件
 * const unsubscribe = eventBus.subscribe('workflow.started', (event) => {
 *   console.log('Workflow started:', event.workflow_id);
 * });
 *
 * // 广播事件
 * eventBus.emit({
 *   type: 'workflow.started',
 *   workflow_id: 'abc123',
 *   timestamp: new Date(),
 * });
 *
 * // 取消订阅
 * unsubscribe();
 * ```
 */
export class EventBus implements IEventBus {
  private listeners: Map<string, Set<EventEmitter>> = new Map();
  private wildcardListeners: Set<EventEmitter> = new Set();
  private eventLog: Array<WorkflowEvent | NodeEvent | GroupEvent | WorktreeEvent> = [];
  private maxLogSize = 1000;

  /**
   * 订阅事件
   *
   * @param event - 事件类型（支持通配符 '*' 匹配所有事件）
   * @param listener - 事件监听器
   * @returns 取消订阅函数
   */
  subscribe(event: string, listener: EventEmitter): UnsubscribeFunction {
    if (event === '*') {
      this.wildcardListeners.add(listener);
      return () => {
        this.wildcardListeners.delete(listener);
      };
    }

    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }

    const eventListeners = this.listeners.get(event)!;
    eventListeners.add(listener);

    return () => {
      eventListeners.delete(listener);
      if (eventListeners.size === 0) {
        this.listeners.delete(event);
      }
    };
  }

  /**
   * 广播事件
   *
   * @param event - 事件对象
   */
  emit(event: WorkflowEvent | NodeEvent | GroupEvent | WorktreeEvent): void {
    // 记录日志
    this.eventLog.push(event);
    if (this.eventLog.length > this.maxLogSize) {
      this.eventLog.shift(); // 移除最旧的日志
    }

    // 通知特定事件监听器
    const specificListeners = this.listeners.get(event.type);
    if (specificListeners) {
      specificListeners.forEach((listener) => {
        try {
          listener(event);
        } catch (error) {
          console.error(`Error in event listener for ${event.type}:`, error);
        }
      });
    }

    // 通知通配符监听器
    this.wildcardListeners.forEach((listener) => {
      try {
        listener(event);
      } catch (error) {
        console.error(`Error in wildcard event listener:`, error);
      }
    });
  }

  /**
   * 获取事件日志
   *
   * @param eventType - 可选的事件类型过滤器
   * @returns 事件日志数组
   */
  getEventLog(eventType?: string): Array<WorkflowEvent | NodeEvent | GroupEvent | WorktreeEvent> {
    if (!eventType) {
      return [...this.eventLog];
    }
    return this.eventLog.filter((e) => e.type === eventType);
  }

  /**
   * 清理事件总线
   */
  destroy(): void {
    this.listeners.clear();
    this.wildcardListeners.clear();
    this.eventLog = [];
  }

  /**
   * 获取监听器数量
   *
   * @param event - 事件类型
   * @returns 监听器数量
   */
  getListenerCount(event: string): number {
    const specificCount = this.listeners.get(event)?.size || 0;
    const wildcardCount = this.wildcardListeners.size;
    return specificCount + wildcardCount;
  }
}
