// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * WP-B1: DAGNodeConfig.condition schema validation tests.
 *
 * Scope: schema-level validation only — verifies `validateNodeCondition` correctly
 * accepts valid conditions and rejects invalid ones with clear reason strings.
 *
 * NOT covered here: runtime evaluation (WP-B2), skip cascade (WP-B3), DB integration.
 * scenario-25-conditional-skip.test.ts is reserved for WP-B3 full scenario tests.
 *
 * Acceptance criteria (from 009-dag-capability-expansion.md §7 WP-B1):
 * - 合法 condition（引用 ⊆ dependencies，非 required 节点）→ accept
 * - 越界引用（condition 引用了不在 dependencies 的节点）→ reject, clear reason
 * - required 节点声明 condition → reject, reason = "required node cannot declare condition"
 * - 非声明式（如 closure/function 类型）→ reject
 * - 缺省 condition（无 condition 字段）→ accept（向后兼容）
 */

import { describe, expect, it } from "bun:test"
import type { DAGNodeConfig } from "../types"
import { validateNodeCondition } from "../limits"

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

describe("validateNodeCondition (WP-B1 schema)", () => {
  // -----------------------------------------------------------------
  // Acceptance 1: valid condition → accepted
  // -----------------------------------------------------------------
  it("accepts a valid condition with ref_node in dependencies and required=false", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      required: false,
      condition: { ref_node: "step-a", op: "eq", value: "done" },
    })
    expect(validateNodeCondition(node)).toEqual({ ok: true })
  })

  it("accepts condition with exists op (no value required)", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      required: false,
      condition: { ref_node: "step-a", op: "exists" },
    })
    expect(validateNodeCondition(node)).toEqual({ ok: true })
  })

  it("accepts condition with not_exists op", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a", "step-z"],
      required: false,
      condition: { ref_node: "step-z", op: "not_exists" },
    })
    expect(validateNodeCondition(node)).toEqual({ ok: true })
  })

  it("accepts a valid condition referencing one of multiple dependencies", () => {
    const node = makeNode({
      id: "step-d",
      dependencies: ["step-a", "step-b", "step-c"],
      required: false,
      condition: { ref_node: "step-c", op: "ne", value: 0 },
    })
    expect(validateNodeCondition(node)).toEqual({ ok: true })
  })

  // -----------------------------------------------------------------
  // Acceptance 2: ref_node not in dependencies → rejected
  // -----------------------------------------------------------------
  it("rejects condition when ref_node is not in dependencies", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      required: false,
      condition: { ref_node: "step-x", op: "eq", value: "done" },
    })
    const result = validateNodeCondition(node)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("condition refs must ⊆ dependencies")
      expect(result.reason).toContain("step-x")
    }
  })

  it("rejects condition when ref_node is an empty string (not a real dependency)", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      required: false,
      condition: { ref_node: "", op: "eq", value: "x" },
    })
    const result = validateNodeCondition(node)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // Either the non-empty-string check or the dependencies check may fire first
      expect(result.reason).toMatch(/ref_node|condition refs must/)
    }
  })

  // -----------------------------------------------------------------
  // Acceptance 3: required + condition → rejected (§3.2 方案 1)
  // -----------------------------------------------------------------
  it("rejects required node with any condition", () => {
    const node = makeNode({
      id: "step-a",
      dependencies: [],
      required: true,
      condition: { ref_node: "other", op: "eq", value: "x" },
    })
    const result = validateNodeCondition(node)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("required node cannot declare condition")
    }
  })

  it("rejects required node even when condition would otherwise be structurally valid", () => {
    const node = makeNode({
      id: "step-a",
      dependencies: ["dep"],
      required: true,
      condition: { ref_node: "dep", op: "exists" },
    })
    const result = validateNodeCondition(node)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("required node cannot declare condition")
    }
  })

  // -----------------------------------------------------------------
  // Acceptance 4: non-structural/closure form → rejected
  // -----------------------------------------------------------------
  it("rejects function/closure as condition value (non-serializable)", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      required: false,
      condition: (() => true) as unknown as NonNullable<DAGNodeConfig["condition"]>,
    })
    const result = validateNodeCondition(node)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("condition must be a structured object")
    }
  })

  it("rejects array as condition value", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      required: false,
      condition: [{ ref_node: "step-a", op: "eq" }] as unknown as NonNullable<DAGNodeConfig["condition"]>,
    })
    const result = validateNodeCondition(node)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("condition must be a structured object")
    }
  })

  it("rejects string as condition value", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      required: false,
      condition: "ref_node=step-a && status==done" as unknown as NonNullable<DAGNodeConfig["condition"]>,
    })
    const result = validateNodeCondition(node)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("condition must be a structured object")
    }
  })

  it("rejects number as condition value", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      required: false,
      condition: 42 as unknown as NonNullable<DAGNodeConfig["condition"]>,
    })
    const result = validateNodeCondition(node)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("condition must be a structured object")
    }
  })

  it("rejects condition with non-string ref_node", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      required: false,
      condition: { ref_node: 123, op: "eq", value: "x" } as unknown as NonNullable<DAGNodeConfig["condition"]>,
    })
    const result = validateNodeCondition(node)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("ref_node must be a non-empty string")
    }
  })

  it("rejects condition with invalid op (not in whitelist)", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      required: false,
      condition: { ref_node: "step-a", op: "regex", value: ".*" } as unknown as NonNullable<DAGNodeConfig["condition"]>,
    })
    const result = validateNodeCondition(node)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("condition.op must be one of")
    }
  })

  it("rejects condition with missing op", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      required: false,
      condition: { ref_node: "step-a" } as unknown as NonNullable<DAGNodeConfig["condition"]>,
    })
    const result = validateNodeCondition(node)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("condition.op must be one of")
    }
  })

  // -----------------------------------------------------------------
  // Acceptance 5: omitted condition → accepted (backward compat)
  // -----------------------------------------------------------------
  it("accepts node with no condition field (backward compatible)", () => {
    const node = makeNode({ id: "step-a", dependencies: [], required: true })
    expect(validateNodeCondition(node)).toEqual({ ok: true })
  })

  it("accepts node with condition explicitly set to undefined", () => {
    const node = makeNode({
      id: "step-a",
      dependencies: [],
      required: true,
      condition: undefined,
    })
    expect(validateNodeCondition(node)).toEqual({ ok: true })
  })

  it("accepts required=false node with no condition", () => {
    const node = makeNode({
      id: "optional-step",
      dependencies: ["step-a"],
      required: false,
    })
    expect(validateNodeCondition(node)).toEqual({ ok: true })
  })

  // -----------------------------------------------------------------
  // Acceptance 6: WP3D — ref_path static validation
  // -----------------------------------------------------------------
  it("accepts condition with ref_path as string", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      required: false,
      condition: { ref_node: "step-a", op: "eq", value: "done", ref_path: "result.status" },
    })
    expect(validateNodeCondition(node)).toEqual({ ok: true })
  })

  it("accepts condition with ref_path absent (undefined)", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      required: false,
      condition: { ref_node: "step-a", op: "eq", value: 42 },
    })
    expect(validateNodeCondition(node)).toEqual({ ok: true })
  })

  it("rejects condition with ref_path as number", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      required: false,
      condition: { ref_node: "step-a", op: "eq", value: "x", ref_path: 42 } as unknown as NonNullable<DAGNodeConfig["condition"]>,
    })
    const result = validateNodeCondition(node)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("condition.ref_path must be string")
    }
  })

  it("rejects condition with ref_path as null (typeof null = object, not string)", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      required: false,
      condition: { ref_node: "step-a", op: "eq", value: "x", ref_path: null } as unknown as NonNullable<DAGNodeConfig["condition"]>,
    })
    const result = validateNodeCondition(node)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("condition.ref_path must be string")
    }
  })

  it("rejects condition with ref_path as boolean", () => {
    const node = makeNode({
      id: "step-b",
      dependencies: ["step-a"],
      required: false,
      condition: { ref_node: "step-a", op: "eq", value: "x", ref_path: true } as unknown as NonNullable<DAGNodeConfig["condition"]>,
    })
    const result = validateNodeCondition(node)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("condition.ref_path must be string")
    }
  })
})
