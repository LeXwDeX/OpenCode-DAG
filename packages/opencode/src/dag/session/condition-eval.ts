// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * WP-B2 (WP3E): Condition evaluation — pure function module.
 *
 * Evaluates DAG node conditions against upstream node outputs to determine
 * whether a ready node should execute or be deferred for skipping.
 *
 * **Purity contract (archgate constraint 1):**
 * - No DB reads/writes
 * - No Effect usage
 * - No Logger / event emission
 * - No mutable module-level state
 * - Imports: `./types` (DAGNodeCondition, DAGNodeSession) + `./path-resolve`
 *   (pure leaf — resolvePath + PATH_NOT_FOUND). No runtime DB/Effect/log
 *   dependencies.
 *
 * **WP3E: ref_path sub-field extraction with string→JSON.parse leniency**
 *
 * When `condition.ref_path` is present, the resolution flow is:
 * 1. `raw = outputMap.get(ref_node) ?? null`
 * 2. raw null/undefined → treat as null (8-op null table absorbs).
 * 3. raw is string → `JSON.parse(raw)`. Parse failure OR parsed result is
 *    non-object/null/array → treat as null. Otherwise use parsed object.
 * 4. raw is plain object (typeof object && !Array.isArray) →
 *    `resolvePath(raw, ref_path)`. PATH_NOT_FOUND → null. Else use resolved value.
 * 5. Otherwise (number/boolean/array/other) → null.
 *
 * **Divergence from input_mapping.ref_path (see types.ts:DAGNodeCondition):**
 * input_mapping does NOT allow string→JSON.parse (ruling 2: preserve C2 audit
 * contract). condition allows it because `node_complete` output is always string.
 *
 * **8 ops null/missing semantics (archgate INFO 3):**
 *
 * | op         | output present & non-null                  | output null/undefined or absent |
 * |------------|--------------------------------------------|---------------------------------|
 * | exists     | true                                       | false                           |
 * | not_exists | false                                      | true                            |
 * | eq         | output === value (strict equality)         | null === value                  |
 * | ne         | output !== value (strict inequality)       | null !== value                  |
 * | gt/lt/gte/lte | native JS comparison (number/string)   | false (missing = not comparable)|
 *
 * Comparison operators (gt/lt/gte/lte) require non-null output data.
 * When output is null/undefined (including absent from outputMap), these
 * return **false** — treated as "condition not met". This is an auditable
 * default (§7 WP-B2 boundary condition a): missing data does not silently
 * pass a comparison that expects real values.
 *
 * Call sites:
 * - `scheduleReadyNodes` (workflow-engine.ts) — scheduling path only
 * - NOT `getWorkflowStatus` (workflow-engine.ts:1084) — statistical path, untouched
 */

import type { DAGNodeCondition, DAGNodeSession } from "./types"
import { resolvePath, PATH_NOT_FOUND } from "./path-resolve"

/**
 * Result of splitting ready nodes by condition evaluation (WP-B2).
 *
 * - `executeList` — nodes whose conditions are met (or have no condition).
 *   These proceed to spawnReadyNode in scheduleReadyNodes.
 * - `skipCandidates` — nodes whose conditions evaluated to false.
 *   Not consumed by WP-B2; WP-B3 will perform the actual skip + cascade.
 */
export interface ConditionEvalResult {
  readonly executeList: readonly DAGNodeSession[]
  readonly skipCandidates: readonly DAGNodeSession[]
}

/**
 * Evaluate a single node condition against upstream outputs.
 *
 * Pure function: no side effects, no DB, no logging, no state mutation.
 * All 8 ops (eq/ne/gt/lt/gte/lte/exists/not_exists) are evaluated here,
 * matching DAG_CONDITION_OPS 1:1 (archgate constraint 3).
 *
 * @param condition — the node's declared condition (must be non-null)
 * @param outputMap — config-id → output for completed upstream nodes
 * @returns true if condition is met, false otherwise
 */
export function evaluateCondition(
  condition: DAGNodeCondition,
  outputMap: Map<string, unknown>,
): boolean {
  const output = condition.ref_path != null
    ? resolveRefPath(outputMap, condition.ref_node, condition.ref_path)
    : (outputMap.get(condition.ref_node) ?? null)

  switch (condition.op) {
    case "exists":
      return output !== null && output !== undefined
    case "not_exists":
      return output === null || output === undefined
    case "eq":
      return output === condition.value
    case "ne":
      return output !== condition.value
    case "gt":
      return output != null && output > (condition.value as number | string)
    case "lt":
      return output != null && output < (condition.value as number | string)
    case "gte":
      return output != null && output >= (condition.value as number | string)
    case "lte":
      return output != null && output <= (condition.value as number | string)
  }
}

/**
 * WP3E: Resolve ref_path sub-field extraction with string→JSON.parse leniency.
 *
 * Resolution flow (per WP3E spec):
 * 1. raw = outputMap.get(ref_node) ?? null
 * 2. raw null/undefined → null (8-op null table absorbs).
 * 3. raw is string → JSON.parse(raw). Parse failure OR parsed result is
 *    non-object/null/array → null. Otherwise use parsed object.
 * 4. raw is plain object (typeof object && !Array.isArray) →
 *    resolvePath(raw, ref_path). PATH_NOT_FOUND → null. Else use resolved value.
 * 5. Otherwise (number/boolean/array/other) → null.
 *
 * Pure: no side effects, no state mutation.
 */
function resolveRefPath(
  outputMap: Map<string, unknown>,
  refNode: string,
  refPath: string,
): unknown {
  const raw = outputMap.get(refNode) ?? null
  if (raw == null) return null

  if (typeof raw === 'string') {
    const parsed = tryParseJson(raw)
    return parsed == null
      ? null
      : extractField(parsed, refPath)
  }

  if (typeof raw === 'object' && !Array.isArray(raw) && raw !== null) {
    return extractField(raw as Record<string, unknown>, refPath)
  }

  return null
}

/**
 * Try JSON.parse; return undefined on failure (caller maps to null).
 * Only accepts parse results that are plain objects (excludes array/null/primitives).
 */
function tryParseJson(s: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(s)
  } catch {
    return undefined
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined
  }
  return parsed as Record<string, unknown>
}

/**
 * Extract a dot-notation field from an object using the shared path-resolve leaf.
 * PATH_NOT_FOUND → null (8-op null table absorbs).
 */
function extractField(
  obj: Record<string, unknown>,
  refPath: string,
): unknown {
  const resolved = resolvePath(obj, refPath)
  return resolved === PATH_NOT_FOUND ? null : resolved
}

/**
 * Split ready nodes into execute and skip-candidate lists based on conditions.
 *
 * Nodes without a condition (undefined/null) always go to executeList
 * (backward compatible — archgate constraint 4).
 * Each node's condition is evaluated independently (archgate constraint 6).
 *
 * @param readyNodes — dependency-satisfied nodes from getReadyNodes
 * @param outputMap — config-id → output for completed upstream nodes
 * @returns split result with executeList and skipCandidates
 */
export function splitByCondition(
  readyNodes: readonly DAGNodeSession[],
  outputMap: Map<string, unknown>,
): ConditionEvalResult {
  const executeList: DAGNodeSession[] = []
  const skipCandidates: DAGNodeSession[] = []

  for (const node of readyNodes) {
    const cond = node.config.condition
    if (cond == null) {
      executeList.push(node)
    } else if (evaluateCondition(cond, outputMap)) {
      executeList.push(node)
    } else {
      skipCandidates.push(node)
    }
  }

  return { executeList, skipCandidates }
}

/**
 * Build an output map from completed nodes, keyed by config ID.
 *
 * Key: `node.config.id` (bare config ID, same as condition.ref_node).
 * Value: `node.output` (may be null per session-service `row.output ?? null`).
 *
 * This is a pure projection — no DB, no side effects.
 *
 * @param nodes — all nodes in the workflow (mixed statuses)
 * @returns outputMap suitable for evaluateCondition / splitByCondition
 */
export function buildOutputMap(
  nodes: readonly DAGNodeSession[],
): Map<string, unknown> {
  const map = new Map<string, unknown>()
  for (const node of nodes) {
    if (node.status === "completed") {
      map.set(node.config.id, node.output)
    }
  }
  return map
}
