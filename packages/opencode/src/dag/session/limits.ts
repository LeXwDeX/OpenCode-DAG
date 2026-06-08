// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * Workflow creation/replan 配置上限校验（20/10 上限单一来源）。
 *
 * Extracted from workflow-engine.ts to break the session-service ↔ workflow-engine
 * circular import. Both createWorkflow (session-service) and validateReplanPostConfig
 * (workflow-engine) source their cap checks from this single function.
 */

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
