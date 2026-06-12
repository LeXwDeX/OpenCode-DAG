// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * WP3: Pure dot-notation path resolver — shared leaf for condition-eval and
 * input-mapping-collector.
 *
 * **Purity contract (archgate: dependency-direction path-resolve pure-leaf):**
 * - No DB reads/writes
 * - No Effect usage
 * - No Logger / event emission
 * - No mutable module-level state
 * - Only `import type` or no runtime imports
 *
 * Semantics mirror the original algorithm from input-mapping-collector.ts:183-201
 * (behavior-identical extraction). Dot-notation walk; returns PATH_NOT_FOUND
 * sentinel if any segment is missing or a non-object intermediate is encountered
 * before the last segment.
 *
 * Call sites:
 * - `condition-eval.ts` — ref_path sub-field extraction (WP3E, with JSON.parse leniency)
 * - `input-mapping-collector.ts` — ref_path sub-field extraction (WP3F, behavior-identical refactor)
 */

/** Sentinel value indicating path resolution failed. */
export const PATH_NOT_FOUND: unique symbol = Symbol('PATH_NOT_FOUND')
export type PathNotFound = typeof PATH_NOT_FOUND

/**
 * Navigate a dot-notation path into a plain object.
 *
 * @returns the resolved value, or `PATH_NOT_FOUND` if any segment is missing
 *          or a non-object intermediate is encountered before the last segment.
 */
export function resolvePath(
  obj: Record<string, unknown>,
  path: string,
): unknown | PathNotFound {
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
