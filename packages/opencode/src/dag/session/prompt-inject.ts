// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * WP-C3: Prompt injection of collected upstream data — pure function module.
 *
 * Produces a structured block of upstream collected outputs as an array of
 * text lines. The caller inserts these lines into the prompt array (typically
 * after DAG instructions and before `Your task:`). The injection is **additive**
 * (never replaces the original `worker_config.prompt`).
 *
 * **Purity contract:**
 * - No DB reads/writes
 * - No Effect usage
 * - No Logger / event emission
 * - No mutable module-level state
 * - Synchronous execution (no async — archgate constraint 5)
 *
 * **Missing entry injection policy (archgate constraint 4):**
 *
 * When `CollectedValue.__missing` is present, the entry is handled as follows:
 *
 * | `__missing` reason    | Injection action | Audit status | Rationale                                     |
 * |------------------------|------------------|--------------|-----------------------------------------------|
 * | `null_output`          | Skip             | `skipped`    | Upstream produced null; no data to inject.     |
 * | `non_object_output`    | Skip             | `skipped`    | Upstream is primitive but ref_path needed;    |
 * |                        |                  |              | `CollectedValue.value` is undefined, no data   |
 * |                        |                  |              | available for injection.                       |
 * | `path_not_found`       | Skip             | `skipped`    | Path doesn't exist in output; no data.         |
 * | `beyond_deps`          | Skip             | `skipped`    | Defense-in-depth (never reachable in normal    |
 * |                        |                  |              | flow); ref_node not in declared dependencies.  |
 *
 * All 4 missing reasons result in skip + audit with distinct reason code,
 * ensuring the audit trail differentiates each failure mode.
 *
 * **Volume protection (archgate constraint + INFO 1):**
 *
 * - Per-entry cap: 5000 characters. Serialized values exceeding this limit
 *   are truncated to 5000 chars with a "...[truncated N chars]" suffix.
 *   Audit records `status: 'truncated'` with `originalCharCount`.
 * - Total payload cap: 20000 characters. When the cumulative injected text
 *   (across all entries) exceeds this, remaining entries are dropped.
 *   Audit records `status: 'skipped'` with `reason: 'payload_overflow'`.
 *
 * **Injection format (returned as lines array):**
 * ```
 * === Collected Input Data ===
 * [inputKey1]: <JSON-serialized value>
 * [inputKey2]: <JSON-serialized value>
 * === End Collected Data ===
 * ```
 *
 * Caller inserts these lines (plus surrounding blank lines) into the prompt
 * array before `Your task:` (INFO 3 position).
 *
 * **Backward compatibility (archgate constraint 2):**
 * When `collectedInputData` is empty (no `input_mapping` or all entries
 * missing), `injectionBlock` is an empty array — no delimiters added.
 */

import type { CollectedInputMap } from "./input-mapping-collector"

/** Per-character volume cap for a single injected entry (INFO 1). */
const PER_ENTRY_CHAR_CAP = 5000

/** Total character cap for all injected entries combined (INFO 1). */
const TOTAL_PAYLOAD_CHAR_CAP = 20000

/**
 * Audit status for a single injection entry.
 *
 * - `injected` — value serialized and injected normally.
 * - `skipped` — entry had `__missing` or payload overflow; not injected.
 *   `reason` field set.
 * - `truncated` — value serialized but exceeded per-entry cap; truncated.
 */
export type InjectionStatus = "injected" | "skipped" | "truncated"

/**
 * Per-entry audit record.
 *
 * Records what happened to each `inputKey` during injection:
 * whether it was injected, skipped (with reason), or truncated.
 */
export interface InjectionAuditEntry {
  readonly inputKey: string
  readonly status: InjectionStatus
  readonly reason?: string
  readonly charCount?: number
  readonly originalCharCount?: number
}

/**
 * Result of prompt injection.
 *
 * - `injectionBlock`: array of text lines to insert (empty = no injection).
 *   The caller inserts these lines (with surrounding blanks) into the prompt
 *   array before `Your task:` (INFO 3 position).
 * - `audit`: per-entry audit trail (same key order as input).
 * - `injected`: `true` if at least one entry was injected; `false` if all
 *   entries were skipped (backward-compatible: no block to insert).
 */
export interface InjectionResult {
  readonly injectionBlock: readonly string[]
  readonly audit: readonly InjectionAuditEntry[]
  readonly injected: boolean
}

/**
 * Produce an injection block from collected upstream data (pure, synchronous).
 *
 * Pure function: no side effects, no DB, no logging, no state mutation.
 *
 * @param collectedInputData — WP-C2 collection result (empty Record = no injection)
 * @returns injection result with block lines and audit trail
 */
export function injectCollectedDataToPrompt(
  collectedInputData: CollectedInputMap,
): InjectionResult {
  const entries = Object.entries(collectedInputData)

  // Backward compatibility: no input_mapping → no injection, block empty.
  if (entries.length === 0) {
    return { injectionBlock: [], audit: [], injected: false }
  }

  const audit: InjectionAuditEntry[] = []
  const injectedLines: string[] = []
  let totalChars = 0
  let atLeastOneInjected = false

  for (const [inputKey, cv] of entries) {
    // All 4 __missing reasons → skip injection. Distinct audit reason preserved.
    if (cv.__missing != null) {
      audit.push({ inputKey, status: "skipped", reason: cv.__missing })
      continue
    }

    // Serialize value to JSON. JSON.stringify for all types including
    // primitives — produces compact, deterministic, reversible representation.
    const serialized = JSON.stringify(cv.value)
    const charCount = serialized.length

    // Per-entry volume cap (INFO 1): truncate entries exceeding threshold.
    let finalLine: string
    let entryStatus: InjectionStatus = "injected"
    if (charCount > PER_ENTRY_CHAR_CAP) {
      const truncated = serialized.slice(0, PER_ENTRY_CHAR_CAP)
      const dropped = charCount - PER_ENTRY_CHAR_CAP
      finalLine = `[${inputKey}]: ${truncated}...[truncated ${dropped} chars]`
      entryStatus = "truncated"
    } else {
      finalLine = `[${inputKey}]: ${serialized}`
    }

    // Total payload cap (INFO 1): stop injecting when cumulative exceeds limit.
    if (totalChars + finalLine.length > TOTAL_PAYLOAD_CHAR_CAP) {
      audit.push({ inputKey, status: "skipped", reason: "payload_overflow" })
      continue
    }

    injectedLines.push(finalLine)
    totalChars += finalLine.length
    atLeastOneInjected = true
    audit.push({
      inputKey,
      status: entryStatus,
      charCount: entryStatus === "truncated" ? PER_ENTRY_CHAR_CAP : charCount,
      ...(entryStatus === "truncated" ? { originalCharCount: charCount } : {}),
    })
  }

  // If nothing was injected (all skipped/overflow), return empty block.
  if (!atLeastOneInjected) {
    return { injectionBlock: [], audit, injected: false }
  }

  // Wrap injected lines with delimiters.
  const block = [
    "=== Collected Input Data ===",
    ...injectedLines,
    "=== End Collected Data ===",
  ]

  return { injectionBlock: block, audit, injected: true }
}
