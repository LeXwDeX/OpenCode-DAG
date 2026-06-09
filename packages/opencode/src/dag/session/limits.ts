// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * Workflow creation/replan 配置上限校验（20/10 上限单一来源）。
 *
 * Extracted from workflow-engine.ts to break the session-service ↔ workflow-engine
 * circular import. Both createWorkflow (session-service) and validateReplanPostConfig
 * (workflow-engine) source their cap checks from this single function.
 *
 * WP-B1: 新增 `validateNodeCondition` — 声明式条件 schema 校验（无运行时求值）。
 */

import type { DAGNodeConfig } from "./types"
import { DAG_CONDITION_OPS } from "./types"

/**
 * Single source of truth for the workflow config caps:
 *   - node count ≤ 20
 *   - max_concurrency ∈ [1, 10]
 *
 * Consumed by `createWorkflow` (session-service.ts) at creation and reused by
 * `validateReplanPostConfig` (workflow-engine.ts) for post-replan validation.
 * Reason strings are stable and shared so both entry points report identical messages.
 */
export function validateWorkflowConfigLimits(
  // max_concurrency is typed as `number | undefined` because the runtime config
  // reaching this function (CreateWorkflowInput.config is `any`, HTTP create body
  // is Schema.Unknown) can physically omit the field. A missing/non-numeric value
  // must be rejected, not silently bypassed — see the guard below.
  config: { nodes: readonly unknown[]; max_concurrency: number | undefined },
): { ok: true } | { ok: false; reason: string } {
  if (config.nodes.length > 20) {
    return { ok: false, reason: `node cap exceeded: ${config.nodes.length} > 20` }
  }
  // P0: undefined/null/non-finite must NOT bypass the 1..10 cap. Pre-guard, an
  // undefined value made both `< 1` and `> 10` evaluate false, returning ok:true
  // for a config that violates the concurrency iron rule.
  if (typeof config.max_concurrency !== "number" || !Number.isFinite(config.max_concurrency)) {
    return { ok: false, reason: `max_concurrency must be 1..10, got ${config.max_concurrency}` }
  }
  if (config.max_concurrency < 1 || config.max_concurrency > 10) {
    return { ok: false, reason: `max_concurrency must be 1..10, got ${config.max_concurrency}` }
  }
  return { ok: true }
}

/**
 * WP-B1: 声明式条件 schema 校验（无运行时求值）。
 *
 * 校验内容：
 * 1. **缺省向后兼容**：`condition` 为 undefined / null / 未提供 → OK（节点无条件执行）。
 * 2. **required 互斥**（§3.2 方案 1）：`required === true` 且声明 `condition` → 拒绝。
 *    reason = `"required node cannot declare condition"`。
 * 3. **结构化对象**：`condition` 必须是纯对象（非函数/闭包/非可序列化）。
 *    - `ref_node` 为 string
 *    - `op` 为 `DAGConditionOp` 白名单值
 *    - `value` 可选（exists/not_exists 忽略）
 * 4. **引用 ⊆ dependencies**：`ref_node` 必须在 `node.dependencies` 中。
 *    reason = `"condition refs must ⊆ dependencies"` 且列出越界的 ref_node。
 *
 * 不校验：`ref_node` 在全局 config 中是否存在（由调用方的 dependency resolution 检查覆盖）。
 *
 * 调用方：
 * - `createWorkflow`（session-service.ts）
 * - `validateReplanPostConfig`（workflow-engine.ts, INFO 2）
 *
 * Reason strings 稳定共享，两个入口报告相同消息。
 */
export function validateNodeCondition(
  node: DAGNodeConfig,
): { ok: true } | { ok: false; reason: string } {
  const cond = node.condition as unknown
  // 缺省向后兼容（undefined / null / 未提供）
  if (cond === undefined || cond === null) return { ok: true }

  // required 互斥（§3.2 方案 1）
  if (node.required) {
    return { ok: false, reason: "required node cannot declare condition" }
  }

  // 结构化对象校验：必须是普通对象，非函数/闭包/原始类型/数组
  if (typeof cond !== "object" || Array.isArray(cond)) {
    return {
      ok: false,
      reason: `condition must be a structured object, got ${Array.isArray(cond) ? "array" : typeof cond}`,
    }
  }
  // cond is now known to be a non-null object (null guard passed above); cast for property access
  const c = cond as Record<string, unknown>

  // ref_node: 必须是非空 string
  if (typeof c.ref_node !== "string" || c.ref_node.length === 0) {
    return {
      ok: false,
      reason: `condition.ref_node must be a non-empty string, got ${typeof c.ref_node}`,
    }
  }

  // op: 必须是白名单值
  if (!DAG_CONDITION_OPS.includes(c.op as string)) {
    return {
      ok: false,
      reason: `condition.op must be one of ${DAG_CONDITION_OPS.join("|")}, got ${String(c.op)}`,
    }
  }

  // ref_node ⊆ dependencies
  if (!node.dependencies.includes(c.ref_node)) {
    return {
      ok: false,
      reason: `condition refs must ⊆ dependencies: ref_node '${c.ref_node}' not in dependencies [${node.dependencies.join(", ")}]`,
    }
  }

  return { ok: true }
}
