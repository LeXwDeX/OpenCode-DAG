// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

import { Effect } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import type { WorkflowEngine, WorkflowStatusSnapshot } from "./workflow-engine"
import { unregisterEngine } from "./workflow-engine"
import type { DAGConfig } from "./types"
import type { IDAGSessionService } from "./session-service"
import type { PromptOps } from "@/session/prompt-ops"
import { SessionID } from "@/session/schema"

const log = Log.create({ service: "dag.executor" })

/** DAG executor default max runtime: 10 minutes */
const DEFAULT_MAX_RUNTIME_MS = 10 * 60 * 1000

/**
 * DAG 工作流执行器接口
 * 
 * 负责协调工作流的整体执行生命周期：
 * - 监控工作流状态
 * - 调度和执行就绪节点
 * - 处理并发控制
 * - 管理超时和错误
 */
export interface WorkflowExecutor {
  /**
    * 启动工作流执行
    */
  start(workflowId: string): Effect.Effect<void, never, never>
  
  /**
    * 获取当前工作流状态
    */
  getStatus(workflowId: string): Effect.Effect<WorkflowStatusSnapshot, never>
}

/**
 * 创建 WorkflowExecutor 实例
 * 
 * 执行循环包含超时保护和 cancelled 检测：
 * - 超过 effectiveTimeout 自动中止（timeout_policy='fail'）或通知（timeout_policy='notify'）
 * - 工作流状态变为 cancelled 立即退出
 *
 * Timeout resolution order (highest priority first):
 * 1. config.timeout_ms (if set in DAGConfig)
 * 2. maxRuntimeMs parameter (caller-provided, defaults to DEFAULT_MAX_RUNTIME_MS)
 *
 * §2.2 timeout_policy:
 * - 'fail'（缺省）= 超时后 cancelWorkflow（当前行为）
 * - 'notify' = 超时后不 cancel，向 parent session 注入通知消息，工作流保持 running。
 *   notify 模式下，执行器超时后退出轮询循环（停止主动调度），但工作流状态不变，
 *   仍可被 agent 通过 dagworker pause/cancel/replan 手动控制。
 */
export function createWorkflowExecutor(
  engine: WorkflowEngine,
  config: DAGConfig,
  maxRuntimeMs: number = DEFAULT_MAX_RUNTIME_MS,
  sessionService?: IDAGSessionService,
  promptOps?: PromptOps,
  /**
   * §4.1 I1: 工作流级 timeout_policy 缺省时的回退（来自 Config.dag.default_timeout_policy）。
   * 优先级：config.timeout_policy > fallbackTimeoutPolicy > 'fail'。
   * 缺省 = 'fail'（向后兼容）。
   */
  fallbackTimeoutPolicy?: 'fail' | 'notify',
): WorkflowExecutor {
  // WP1-A: config.timeout_ms takes precedence over param default
  const effectiveTimeout = config.timeout_ms ?? maxRuntimeMs
  const timeoutPolicy = (config.timeout_policy as 'fail' | 'notify' | undefined)
    ?? fallbackTimeoutPolicy
    ?? 'fail'
  return {
    start(workflowId: string): Effect.Effect<void, never, never> {
      return Effect.gen(function* () {
        const startedAt = Date.now()
        let timeoutNotified = false
        
        while (true) {
          // Timeout guard
          if (Date.now() - startedAt > effectiveTimeout) {
            if (timeoutPolicy === 'notify') {
              // §2.2 notify 策略：只通知一次，然后退出轮询（停止主动调度）。
              // 工作流保持 running，running 节点继续各自执行直到自然收敛。
              if (!timeoutNotified) {
                timeoutNotified = true
                yield* notifyWorkflowTimeout(workflowId, config, effectiveTimeout, sessionService, promptOps)
                log.warn(`Workflow ${workflowId} exceeded max runtime (${effectiveTimeout}ms), timeout_policy='notify' — executor polling stopped, workflow stays running`)
              }
              // notify 模式：不再调用 scheduleReadyNodes，退出执行循环。
              // 但不 cancel 工作流——agent 仍可通过 dagworker 手动控制。
              break
            } else {
              // 默认 'fail' 策略：cancel 工作流（当前行为）
              yield* engine.cancelWorkflow(workflowId)
              log.error(`Workflow ${workflowId} exceeded max runtime (${effectiveTimeout}ms), cancelled`)
              break
            }
          }
          
          const status = yield* engine.getWorkflowStatus(workflowId)
          
          // Terminal state check: completed / failed / cancelled
          if (status.status === "completed" || status.status === "failed" || status.status === "cancelled") {
            break
          }
          
          yield* engine.scheduleReadyNodes(workflowId)
          yield* Effect.sleep(100)
        }
      }).pipe(Effect.ensuring(Effect.sync(() => unregisterEngine(workflowId))))
    },
    
    getStatus(workflowId: string): Effect.Effect<WorkflowStatusSnapshot, never> {
      return engine.getWorkflowStatus(workflowId)
    },
  }
}

/**
 * §2.2 notify 策略的工作流级超时通知。
 * 向 parent chat session 注入 `<dag_workflow_timeout>` 消息，
 * agent 收到后可自主决定 pause/cancel/replan/继续等待。
 *
 * Best-effort: 任何失败静默忽略（不阻塞 executor 退出）。
 */
function notifyWorkflowTimeout(
  workflowId: string,
  config: DAGConfig,
  timeoutMs: number,
  sessionService?: IDAGSessionService,
  promptOps?: PromptOps,
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    if (!sessionService) return

    const workflow = yield* sessionService.getWorkflow(workflowId).pipe(
      Effect.catchCause(() => Effect.succeed(undefined)),
    )
    if (!workflow?.chat_session_id) return

    // 1. 记录 timeout_exceeded 违规（审计）
    yield* sessionService.createViolation({
      workflowId,
      type: 'timeout_exceeded',
      severity: 'warning',
      message: `workflow exceeded timeout_ms=${timeoutMs} (timeout_policy='notify', workflow kept running)`,
      details: { timeout_ms: timeoutMs, timeout_policy: 'notify' },
      chatSessionId: workflow.chat_session_id,
    }).pipe(
      Effect.tapError(err => Effect.logWarning(`[DAG] workflow notify-timeout violation failed for ${workflowId}: ${err}`)),
      Effect.ignore,
    )

    // 2. 审计日志。工作流级事件无对应 node，用哨兵值标记（避免与真实 nodeId 混淆）。
    yield* sessionService.appendNodeLog({
      nodeId: '__workflow__',
      workflowId,
      chatSessionId: workflow.chat_session_id,
      logLevel: 'warn',
      logMessage: `Workflow timeout (notify policy): exceeded timeout_ms=${timeoutMs}, executor polling stopped, workflow stays running`,
      executionPhase: 'workflow_timeout_notify',
      logData: { timeout_ms: timeoutMs, timeout_policy: 'notify' },
    }).pipe(
      Effect.tapError(err => Effect.logWarning(`[DAG] workflow notify-timeout log failed for ${workflowId}: ${err}`)),
      Effect.ignore,
    )

    // 3. §2.2 向 parent chat session 注入 `<dag_workflow_timeout>` 通知消息。
    //    agent 收到后自主决定 pause/cancel/replan/继续等待——保留 agent 的完全控制权。
    if (promptOps) {
      const timeoutNotice = [
        `<dag_workflow_timeout workflow_id="${workflowId}" timeout_ms="${timeoutMs}">`,
        `Workflow "${config.name}" has exceeded its configured timeout of ${timeoutMs}ms.`,
        `The timeout_policy is set to 'notify', so the workflow remains running and you retain full control.`,
        `Executor polling has stopped (no new nodes will be auto-scheduled), but all running nodes continue.`,
        `You can now decide:`,
        `  - Call dagworker pause to halt scheduling while running nodes finish`,
        `  - Call dagworker cancel to abort the entire workflow`,
        `  - Call dagworker replan to restructure the remaining tail`,
        `  - Do nothing and let running nodes converge naturally (they will still call node_complete)`,
        `</dag_workflow_timeout>`,
      ].join("\n")
      yield* promptOps.prompt({
        sessionID: workflow.chat_session_id as SessionID,
        noReply: true,
        parts: [{
          type: "text",
          synthetic: true,
          text: timeoutNotice,
          metadata: {
            dag_workflow_timeout: true,
            dag_workflow_id: workflowId,
            dag_timeout_ms: timeoutMs,
          },
        }],
      }).pipe(
        Effect.tapError(err => Effect.logWarning(`[DAG] workflow notify-timeout message injection failed for ${workflowId}: ${err}`)),
        Effect.ignore,
      )
    }
  })
}
