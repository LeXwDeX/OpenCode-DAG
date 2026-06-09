// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * WP-C3: Prompt injection helper — pure function unit tests.
 *
 * Tests injectCollectedDataToPrompt:
 * - Normal value injection (no __missing) → produces correct block lines
 * - 4 missing-type skip strategies → each produces distinct audit reason
 * - Large output truncation (per-entry + total payload)
 * - Mixed (partial normal + partial missing)
 * - Backward compatibility (empty collectedInputData → empty block)
 * - Purity verification (does not mutate input)
 *
 * NOT covered: workflow-engine integration (DB-level → scenario-26),
 * actual DAG execution, condition/skip scenarios.
 */

import { describe, expect, it } from "bun:test"
import type { CollectedInputMap } from "../input-mapping-collector"
import { injectCollectedDataToPrompt } from "../prompt-inject"

// =========================================================================
// Helpers
// =========================================================================

/** Build a CollectedInputMap literal (typed convenience). */
function makeCollected(entries: CollectedInputMap): CollectedInputMap {
  return entries
}

/** Join injection block lines for string assertions. */
function joinBlock(block: readonly string[]): string {
  return block.join("\n")
}

// =========================================================================
// Test 1: Normal value — no __missing → injected
// =========================================================================

describe("injectCollectedDataToPrompt — normal value injection", () => {
  it("injects a single string value with delimiters and audit", () => {
    const collected = makeCollected({
      upstream: { value: "hello world" },
    })
    const result = injectCollectedDataToPrompt(collected)

    expect(result.injected).toBe(true)
    const block = joinBlock(result.injectionBlock)
    expect(block).toContain("=== Collected Input Data ===")
    expect(block).toContain("=== End Collected Data ===")
    expect(block).toContain("[upstream]:")
    expect(block).toContain('"hello world"')

    expect(result.audit).toHaveLength(1)
    expect(result.audit[0].inputKey).toBe("upstream")
    expect(result.audit[0].status).toBe("injected")
  })

  it("injects a nested object value as JSON", () => {
    const collected = makeCollected({
      data: { value: { result: 42, nested: [1, 2, 3] } },
    })
    const result = injectCollectedDataToPrompt(collected)

    expect(result.injected).toBe(true)
    const block = joinBlock(result.injectionBlock)
    expect(block).toContain("[data]:")
    expect(block).toContain("42")
    expect(result.audit[0].status).toBe("injected")
  })

  it("injects multiple entries preserving key order", () => {
    const collected = makeCollected({
      alpha: { value: "first" },
      beta: { value: "second" },
    })
    const result = injectCollectedDataToPrompt(collected)

    const block = joinBlock(result.injectionBlock)
    const alphaIdx = block.indexOf("[alpha]:")
    const betaIdx = block.indexOf("[beta]:")
    expect(alphaIdx).toBeGreaterThan(-1)
    expect(betaIdx).toBeGreaterThan(-1)
    expect(alphaIdx).toBeLessThan(betaIdx)
    expect(result.audit).toHaveLength(2)
  })
})

// =========================================================================
// Test 2: null_output → skip injection
// =========================================================================

describe("injectCollectedDataToPrompt — null_output skip", () => {
  it("skips entry with __missing: null_output and records audit", () => {
    const collected = makeCollected({
      fromNull: { value: undefined, __missing: "null_output" },
    })
    const result = injectCollectedDataToPrompt(collected)

    expect(result.injected).toBe(false)
    expect(result.injectionBlock).toHaveLength(0)

    expect(result.audit).toHaveLength(1)
    expect(result.audit[0].inputKey).toBe("fromNull")
    expect(result.audit[0].status).toBe("skipped")
    expect(result.audit[0].reason).toBe("null_output")
  })
})

// =========================================================================
// Test 3: non_object_output → skip injection
// =========================================================================

describe("injectCollectedDataToPrompt — non_object_output skip", () => {
  it("skips entry with __missing: non_object_output and records audit", () => {
    const collected = makeCollected({
      fromPrimitive: { value: undefined, __missing: "non_object_output" },
    })
    const result = injectCollectedDataToPrompt(collected)

    expect(result.injected).toBe(false)
    expect(result.injectionBlock).toHaveLength(0)

    expect(result.audit).toHaveLength(1)
    expect(result.audit[0].status).toBe("skipped")
    expect(result.audit[0].reason).toBe("non_object_output")
  })
})

// =========================================================================
// Test 4: path_not_found → skip injection
// =========================================================================

describe("injectCollectedDataToPrompt — path_not_found skip", () => {
  it("skips entry with __missing: path_not_found and records audit", () => {
    const collected = makeCollected({
      fromMissing: { value: undefined, __missing: "path_not_found" },
    })
    const result = injectCollectedDataToPrompt(collected)

    expect(result.injected).toBe(false)
    expect(result.injectionBlock).toHaveLength(0)

    expect(result.audit).toHaveLength(1)
    expect(result.audit[0].status).toBe("skipped")
    expect(result.audit[0].reason).toBe("path_not_found")
  })
})

// =========================================================================
// Test 5: beyond_deps → skip injection
// =========================================================================

describe("injectCollectedDataToPrompt — beyond_deps skip", () => {
  it("skips entry with __missing: beyond_deps and records audit", () => {
    const collected = makeCollected({
      fromOutside: { value: undefined, __missing: "beyond_deps" },
    })
    const result = injectCollectedDataToPrompt(collected)

    expect(result.injected).toBe(false)
    expect(result.injectionBlock).toHaveLength(0)

    expect(result.audit).toHaveLength(1)
    expect(result.audit[0].status).toBe("skipped")
    expect(result.audit[0].reason).toBe("beyond_deps")
  })
})

// =========================================================================
// Test 6: Large output truncation (per-entry + total)
// =========================================================================

describe("injectCollectedDataToPrompt — volume truncation", () => {
  it("truncates a single entry exceeding 5000 chars", () => {
    const bigValue = "x".repeat(6000)
    const collected = makeCollected({
      big: { value: bigValue },
    })
    const result = injectCollectedDataToPrompt(collected)

    expect(result.injected).toBe(true)
    const block = joinBlock(result.injectionBlock)
    expect(block).toContain("truncated")
    // Per-entry cap: the serialized line (inside the block) should be truncated
    const bigLine = block.split("\n").find((l: string) => l.startsWith("[big]:"))!
    expect(bigLine.length).toBeLessThanOrEqual(5100) // 5000 + suffix + overhead
    expect(result.audit[0].status).toBe("truncated")
    expect(result.audit[0].originalCharCount).toBeGreaterThanOrEqual(6000)
  })

  it("stops injecting entries when total payload exceeds 20000 chars", () => {
    const entries: CollectedInputMap = {}
    // Each value ~3000 chars → after 7 entries = 21000 > 20000
    for (let i = 0; i < 10; i++) {
      entries[`key${i}`] = { value: "a".repeat(3000) }
    }
    const result = injectCollectedDataToPrompt(entries)

    // Some entries must have been dropped (payload_overflow)
    const dropped = result.audit.filter((a) => a.status === "skipped" && a.reason === "payload_overflow")
    expect(dropped.length).toBeGreaterThan(0)

    // Injected/truncated entries must exist
    const injected = result.audit.filter((a) => a.status === "injected" || a.status === "truncated")
    expect(injected.length).toBeGreaterThan(0)
    expect(injected.length).toBeLessThan(10)
  })
})

// =========================================================================
// Test 7: Mixed — partial normal + partial missing
// =========================================================================

describe("injectCollectedDataToPrompt — mixed entries", () => {
  it("injects normal entries and skips missing ones", () => {
    const collected = makeCollected({
      good: { value: { score: 100 } },
      nullEntry: { value: undefined, __missing: "null_output" },
      pathMissing: { value: undefined, __missing: "path_not_found" },
      another: { value: "text" },
    })
    const result = injectCollectedDataToPrompt(collected)

    expect(result.injected).toBe(true)
    const block = joinBlock(result.injectionBlock)
    expect(block).toContain("[good]:")
    expect(block).toContain("[another]:")
    expect(block).not.toContain("[nullEntry]:")
    expect(block).not.toContain("[pathMissing]:")

    expect(result.audit).toHaveLength(4)
    const skipped = result.audit.filter((a) => a.status === "skipped")
    expect(skipped).toHaveLength(2)
    const injected = result.audit.filter((a) => a.status === "injected")
    expect(injected).toHaveLength(2)
  })
})

// =========================================================================
// Test 8: Backward compatibility — empty collectedInputData
// =========================================================================

describe("injectCollectedDataToPrompt — backward compatibility", () => {
  it("returns empty block when collectedInputData is empty", () => {
    const result = injectCollectedDataToPrompt({})

    expect(result.injected).toBe(false)
    expect(result.injectionBlock).toHaveLength(0)
    expect(result.audit).toHaveLength(0)
  })

  it("returns empty block when all entries are missing", () => {
    const collected = makeCollected({
      a: { value: undefined, __missing: "null_output" },
      b: { value: undefined, __missing: "path_not_found" },
    })
    const result = injectCollectedDataToPrompt(collected)

    expect(result.injected).toBe(false)
    expect(result.injectionBlock).toHaveLength(0)
    expect(result.audit).toHaveLength(2)
    expect(result.audit.every((a) => a.status === "skipped")).toBe(true)
  })
})

// =========================================================================
// Test 9: Purity verification — does not mutate input
// =========================================================================

describe("injectCollectedDataToPrompt — purity", () => {
  it("does not mutate collectedInputData", () => {
    const collected = makeCollected({
      key1: { value: { data: "original" } },
      key2: { value: undefined, __missing: "null_output" },
    })
    const snapshot = JSON.stringify(collected)

    injectCollectedDataToPrompt(collected)

    expect(JSON.stringify(collected)).toBe(snapshot)
  })

  it("is idempotent: same input → same output", () => {
    const collected = makeCollected({
      x: { value: 42 },
    })
    const r1 = injectCollectedDataToPrompt(collected)
    const r2 = injectCollectedDataToPrompt(collected)

    expect(r1.injectionBlock).toEqual(r2.injectionBlock)
    expect(r1.audit).toEqual(r2.audit)
    expect(r1.injected).toBe(r2.injected)
  })
})
