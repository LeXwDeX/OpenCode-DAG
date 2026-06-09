// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * WP-C1: DAGNodeConfig.input_mapping schema validation tests.
 *
 * Scope: schema-level validation only — verifies `validateInputMapping` correctly
 * accepts valid input_mappings and rejects invalid ones with clear reason strings.
 *
 * NOT covered here: runtime data collection (WP-C2), prompt/input injection (WP-C3),
 * DB integration. These are reserved for scenario-26+ test files.
 *
 * Acceptance criteria (from 009-dag-capability-expansion.md §7 WP-C1):
 * - 合法 input_mapping（引用 ⊆ dependencies，声明式可序列化）→ accept
 * - 越界引用（ref_node 不在 dependencies）→ reject, clear reason
 * - 非法语法（非声明式/闭包/函数/数组）→ reject
 * - 缺省 input_mapping（无字段）→ accept（向后兼容）
 *
 * 出处: docs/design/009-dag-capability-expansion.md §7 WP-C1.
 */

import { describe, expect, it } from "bun:test"
import type { DAGNodeConfig, DAGInputMapping } from "../types"
import { validateInputMapping } from "../limits"

function makeNode(overrides: Partial<DAGNodeConfig> & Pick<DAGNodeConfig, "id">): DAGNodeConfig {
  return {
    name: overrides.name ?? overrides.id,
    dependencies: [],
    required: true,
    worker_type: "general",
    worker_config: {},
    ...overrides,
  }
}

describe("validateInputMapping (WP-C1 schema)", () => {
  // =====================================================================
  // Scenario 1: valid input_mapping → accepted
  // =====================================================================
  it("accepts a valid input_mapping with ref_node in dependencies", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      input_mapping: {
        upstream: { ref_node: "step-a" },
      },
    })
    expect(validateInputMapping(node)).toEqual({ ok: true })
  })

  it("accepts a valid input_mapping with multiple entries and ref_path", () => {
    const node = makeNode({
      id: "step-c",
      dependencies: ["step-a", "step-b"],
      input_mapping: {
        fromA: { ref_node: "step-a", ref_path: "result.value" },
        fromB: { ref_node: "step-b" },
      },
    })
    expect(validateInputMapping(node)).toEqual({ ok: true })
  })

  it("accepts an empty input_mapping (no entries, still an object)", () => {
    const node = makeNode({
      id: "step-a",
      dependencies: [],
      input_mapping: {},
    })
    expect(validateInputMapping(node)).toEqual({ ok: true })
  })

  it("accepts input_mapping on a required node (orthogonal to condition)", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      required: true,
      input_mapping: {
        upstream: { ref_node: "step-a" },
      },
    })
    expect(validateInputMapping(node)).toEqual({ ok: true })
  })

  // =====================================================================
  // Scenario 2: ref_node not in dependencies → rejected
  // =====================================================================
  it("rejects input_mapping when ref_node is not in dependencies", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      input_mapping: {
        upstream: { ref_node: "step-x" },
      },
    })
    const result = validateInputMapping(node)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("input_mapping refs must ⊆ dependencies")
      expect(result.reason).toContain("step-x")
    }
  })

  it("rejects input_mapping when any ref_node is outside dependencies", () => {
    const node = makeNode({
      id: "step-d",
      dependencies: ["step-a", "step-b"],
      input_mapping: {
        fromA: { ref_node: "step-a" },
        fromX: { ref_node: "step-x" },
      },
    })
    const result = validateInputMapping(node)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("input_mapping refs must ⊆ dependencies")
      expect(result.reason).toContain("step-x")
    }
  })

  it("rejects input_mapping with non-empty ref_node requirement", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      input_mapping: {
        upstream: { ref_node: "" },
      },
    })
    const result = validateInputMapping(node)
    expect(result.ok).toBe(false)
  })

  // =====================================================================
  // Scenario 3: non-serializable / illegal syntax → rejected
  // =====================================================================
  it("rejects function/closure as input_mapping (non-serializable)", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      input_mapping: (() => ({ upstream: "step-a" })) as unknown as DAGInputMapping,
    })
    const result = validateInputMapping(node)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("input_mapping must be a serializable object")
    }
  })

  it("rejects array as input_mapping (must be Record, not array)", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      input_mapping: [
        { inputKey: "upstream", ref_node: "step-a" },
      ] as unknown as DAGInputMapping,
    })
    const result = validateInputMapping(node)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("input_mapping must be a serializable object")
    }
  })

  it("rejects string as input_mapping", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      input_mapping: "upstream=step-a" as unknown as DAGInputMapping,
    })
    const result = validateInputMapping(node)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("input_mapping must be a serializable object")
    }
  })

  it("rejects number as input_mapping", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      input_mapping: 42 as unknown as DAGInputMapping,
    })
    const result = validateInputMapping(node)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("input_mapping must be a serializable object")
    }
  })

  it("rejects entry value that is not an object (function)", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      input_mapping: {
        upstream: (() => "step-a") as unknown as DAGInputMapping[string],
      },
    })
    const result = validateInputMapping(node)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("input_mapping")
    }
  })

  it("rejects entry with non-string ref_node (number)", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      input_mapping: {
        upstream: { ref_node: 123 } as unknown as DAGInputMapping[string],
      },
    })
    const result = validateInputMapping(node)
    expect(result.ok).toBe(false)
  })

  it("rejects entry with non-string ref_path (number)", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      input_mapping: {
        upstream: { ref_node: "step-a", ref_path: 42 } as unknown as DAGInputMapping[string],
      },
    })
    const result = validateInputMapping(node)
    expect(result.ok).toBe(false)
  })

  // =====================================================================
  // Scenario 4: missing input_mapping → accepted (backward compat)
  // =====================================================================
  it("accepts node with no input_mapping field (backward compatible)", () => {
    const node = makeNode({ id: "step-a", dependencies: [], required: true })
    expect(validateInputMapping(node)).toEqual({ ok: true })
  })

  it("accepts node with input_mapping explicitly set to undefined", () => {
    const node = makeNode({
      id: "step-a",
      dependencies: [],
      required: true,
      input_mapping: undefined,
    })
    expect(validateInputMapping(node)).toEqual({ ok: true })
  })

  it("accepts optional node with no input_mapping", () => {
    const node = makeNode({
      id: "optional-step",
      dependencies: ["step-a"],
      required: false,
    })
    expect(validateInputMapping(node)).toEqual({ ok: true })
  })
})
