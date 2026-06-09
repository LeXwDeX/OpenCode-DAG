// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * WP-C2: Upstream output collection — pure function module.
 *
 * Collects upstream node outputs according to a node's `input_mapping` and
 * assembles them into a `CollectedInputMap` for downstream prompt injection
 * (WP-C3).
 *
 * **Purity contract (archgate constraint 1):**
 * - No DB reads/writes
 * - No Effect usage
 * - No Logger / event emission
 * - No mutable module-level state
 * - Only `import type` from `./types` (DAGInputMapping)
 *
 * **Caller provides outputMap** (INFO 1 scheme c):
 * The caller reuses `buildOutputMap()` from `condition-eval.ts` to prepare
 * a `Map<string, unknown>` keyed by config-id → completed output value.
 * This collector never calls `listNodes` or reads from DB.
 *
 * **Runtime missing semantics (archgate constraint 4):**
 *
 * | Scenario                                     | Result                                      |
 * |----------------------------------------------|---------------------------------------------|
 * | `ref_node` ∉ `nodeDeps` (beyond deps)       | `{ value: undefined, __missing: 'beyond_deps' }` |
 * | `output == null` (null or undefined)         | `{ value: undefined, __missing: 'null_output' }` |
 * | `ref_path` present but output is non-object  | `{ value: undefined, __missing: 'non_object_output' }` |
 * | `ref_path` present but key not found         | `{ value: undefined, __missing: 'path_not_found' }` |
 * | `ref_path` absent (undefined)                | Returns the whole output object as-is       |
 * | Normal path resolution                       | `{ value: <resolved> }` (no __missing)      |
 *
 * **`ref_path` (archgate constraint 3):**
 * When `ref_path` is `undefined`, the collector returns the entire output
 * (whether it is string, number, boolean, array, object, or null).
 * When `ref_path` is present, simple dot-notation navigation is used
 * (e.g. `"result.value"` → `output.result.value`).
 *
 * **Call sites:**
 * - `spawnReadyNode` (workflow-engine.ts) — before prompt construction.
 *   Collected data is available for WP-C3 prompt injection; WP-C2 itself
 *   does not modify the prompt.
 */

import type { DAGInputMapping } from "./types"

/**
 * Reason codes for missing/unresolvable entries during collection.
 *
 * - `beyond_deps` — `ref_node` is not in the node's declared dependencies
 *   (defense-in-depth; schema validation catches this statically, but runtime
 *   enforcement prevents cross-boundary data access).
 * - `null_output` — the upstream node's output is `null` or `undefined`
 *   (node may not have produced output, or completed with null).
 * - `non_object_output` — output is a primitive (string/number/boolean) or
 *   array, but `ref_path` requires dot-notation navigation into an object.
 * - `path_not_found` — output is an object but the requested `ref_path`
 *   key does not exist in the object tree.
 */
export type OutputMissingReason =
  | 'beyond_deps'
  | 'null_output'
  | 'non_object_output'
  | 'path_not_found'

/**
 * A single collected value from an upstream node output.
 *
 * - Normal: `{ value: <collected> }` — no `__missing` field.
 * - Missing: `{ value: undefined, __missing: <reason> }` — the entry could
 *   not be resolved; `__missing` documents the auditable reason.
 *
 * WP-C3 consumes this structure: entries without `__missing` are injected
 * into the prompt; entries with `__missing` are skipped or handled per
 * WP-C3 policy.
 */
export interface CollectedValue {
  readonly value: unknown
  readonly __missing?: OutputMissingReason
}

/**
 * Result of collecting a node's `input_mapping` against upstream outputs.
 *
 * Keyed by `inputKey` (the same keys declared in `DAGInputMapping`).
 * Normal entries carry `{ value }`; missing entries carry
 * `{ value: undefined, __missing: <reason> }`.
 */
export type CollectedInputMap = Record<string, CollectedValue>

/**
 * Collect input values from upstream outputs according to `inputMapping`.
 *
 * Pure function: no side effects, no DB, no logging, no state mutation.
 *
 * For each entry in `inputMapping`:
 * 1. Enforce that `entry.ref_node` is in `nodeDeps` (archgate constraint 2:
 *    defense-in-depth beyond static schema validation).
 * 2. Look up the output from `outputMap` using `entry.ref_node`.
 * 3. If the output is null/undefined → mark as `null_output`.
 * 4. If `entry.ref_path` is undefined → return the whole output.
 * 5. If output is not a plain object but `ref_path` exists → mark as
 *    `non_object_output`.
 * 6. Navigate dot-notation path; if unresolved → mark as `path_not_found`.
 *
 * @param inputMapping — the node's declared input mapping (undefined = no mapping → returns `{}`)
 * @param outputMap — config-id → output for completed upstream nodes (from `buildOutputMap`)
 * @param nodeDeps — the node's declared dependency IDs (bare config IDs)
 * @returns `CollectedInputMap` with normal values and/or `__missing` markers
 */
export function collectInputMapping(
  inputMapping: DAGInputMapping | undefined,
  outputMap: Map<string, unknown>,
  nodeDeps: readonly string[],
): CollectedInputMap {
  if (inputMapping == null) return {}

  const depsSet = new Set(nodeDeps)
  const result: CollectedInputMap = {}

  for (const [inputKey, entry] of Object.entries(inputMapping)) {
    // Constraint 2: defense-in-depth — ref_node must be in nodeDeps.
    // Schema validation (WP-C1) rejects invalid refs statically; this
    // runtime check prevents cross-boundary data access if the static
    // layer is bypassed (e.g., replan path, DB corruption).
    if (!depsSet.has(entry.ref_node)) {
      result[inputKey] = { value: undefined, __missing: 'beyond_deps' }
      continue
    }

    // outputMap.get(key) returns undefined when key is absent (node not
    // completed or not present). Treat both explicit null and absent as
    // null_output — semantically "no usable output available".
    const output = outputMap.get(entry.ref_node)
    if (output == null) {
      result[inputKey] = { value: undefined, __missing: 'null_output' }
      continue
    }

    // ref_path absent → return the whole output object as-is
    // (archgate constraint 3: "缺省 = 取整个 output 对象")
    if (entry.ref_path == null) {
      result[inputKey] = { value: output }
      continue
    }

    // ref_path present but output is not a plain object: cannot navigate
    // dot-notation into string/number/boolean/array → non_object_output.
    // Arrays are excluded: "0.key" indexing is not supported; pass the
    // whole array via ref_path-absent if array access is needed.
    if (typeof output !== 'object' || Array.isArray(output)) {
      result[inputKey] = { value: undefined, __missing: 'non_object_output' }
      continue
    }

    // Navigate dot-notation path into the output object
    const resolved = resolvePath(output as Record<string, unknown>, entry.ref_path)
    if (resolved === PATH_NOT_FOUND) {
      result[inputKey] = { value: undefined, __missing: 'path_not_found' }
    } else {
      result[inputKey] = { value: resolved }
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Internal helpers (pure, no side effects)
// ---------------------------------------------------------------------------

/** Sentinel value indicating path resolution failed. */
const PATH_NOT_FOUND: unique symbol = Symbol('PATH_NOT_FOUND')

/**
 * Navigate a dot-notation path into a plain object.
 *
 * @returns the resolved value, or `PATH_NOT_FOUND` if any segment is missing
 *          or a non-object intermediate is encountered before the last segment.
 */
function resolvePath(
  obj: Record<string, unknown>,
  path: string,
): unknown | typeof PATH_NOT_FOUND {
  const segments = path.split('.')
  let current: unknown = obj

  for (const seg of segments) {
    if (current == null || typeof current !== 'object' || Array.isArray(current)) {
      return PATH_NOT_FOUND
    }
    if (!(seg in (current as Record<string, unknown>))) {
      return PATH_NOT_FOUND
    }
    current = (current as Record<string, unknown>)[seg]
  }

  return current
}
