// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * WP-C2: Upstream output collection — pure function unit tests.
 *
 * Tests collectInputMapping (normal path / default ref_path / 4 missing
 * scenarios / mixed / backward compat / purity verification).
 *
 * NOT covered: scheduleReadyNodes / spawnReadyNode integration (DB-level,
 * WP-C3), actual prompt injection (WP-C3), workflow finalization.
 *
 * Acceptance criteria (009-dag-capability-expansion.md §7 WP-C2):
 * - 按 input_mapping 取到上游 output 值（正常路径）
 * - 不跨依赖边界取值（运行期 ref_node ∈ dependencies 强制）
 * - ref_path 缺省 = 取整个 output 对象
 * - 4 类运行期缺失去语义明确（不抛异常 + 可审计）
 * - 收集器纯函数（无副作用）
 */

import { describe, expect, it } from "bun:test"
import type { DAGInputMapping } from "../types"
import { collectInputMapping } from "../input-mapping-collector"

// =========================================================================
// Test 1: Normal path — input_mapping valid → collects correct values
// =========================================================================

describe("collectInputMapping — normal path", () => {
  it("collects values from upstream outputs via ref_node", () => {
    const mapping: DAGInputMapping = {
      fromA: { ref_node: "step-a" },
      fromB: { ref_node: "step-b" },
    }
    const outputMap = new Map<string, unknown>([
      ["step-a", "result-a"],
      ["step-b", { nested: 42 }],
    ])
    const deps = ["step-a", "step-b"] as const

    const result = collectInputMapping(mapping, outputMap, deps)

    expect(result.fromA).toEqual({ value: "result-a" })
    expect(result.fromB).toEqual({ value: { nested: 42 } })
  })

  it("resolves dot-notation ref_path into nested output", () => {
    const mapping: DAGInputMapping = {
      deepVal: { ref_node: "upstream", ref_path: "result.value" },
    }
    const outputMap = new Map<string, unknown>([
      ["upstream", { result: { value: "found-it" }, other: "skip" }],
    ])
    const deps = ["upstream"] as const

    const result = collectInputMapping(mapping, outputMap, deps)

    expect(result.deepVal).toEqual({ value: "found-it" })
  })
})

// =========================================================================
// Test 2: ref_path undefined → returns whole output object
// =========================================================================

describe("collectInputMapping — ref_path absent (whole output)", () => {
  it("returns string output as-is when ref_path is absent", () => {
    const mapping: DAGInputMapping = {
      rawOut: { ref_node: "node-x" },
    }
    const outputMap = new Map<string, unknown>([["node-x", "raw-string"]])
    const deps = ["node-x"] as const

    const result = collectInputMapping(mapping, outputMap, deps)

    expect(result.rawOut).toEqual({ value: "raw-string" })
    expect(result.rawOut.__missing).toBeUndefined()
  })

  it("returns number output as-is when ref_path is absent", () => {
    const mapping: DAGInputMapping = {
      rawNum: { ref_node: "node-y" },
    }
    const outputMap = new Map<string, unknown>([["node-y", 99]])
    const deps = ["node-y"] as const

    const result = collectInputMapping(mapping, outputMap, deps)

    expect(result.rawNum).toEqual({ value: 99 })
  })

  it("returns array output as-is when ref_path is absent", () => {
    const mapping: DAGInputMapping = {
      arr: { ref_node: "node-z" },
    }
    const outputMap = new Map<string, unknown>([["node-z", [1, 2, 3]]])
    const deps = ["node-z"] as const

    const result = collectInputMapping(mapping, outputMap, deps)

    expect(result.arr).toEqual({ value: [1, 2, 3] })
  })
})

// =========================================================================
// Test 3: output == null → __missing: 'null_output'
// =========================================================================

describe("collectInputMapping — output null/undefined", () => {
  it("marks null output as null_output", () => {
    const mapping: DAGInputMapping = {
      missing: { ref_node: "empty-node" },
    }
    const outputMap = new Map<string, unknown>([["empty-node", null]])
    const deps = ["empty-node"] as const

    const result = collectInputMapping(mapping, outputMap, deps)

    expect(result.missing.value).toBeUndefined()
    expect(result.missing.__missing).toBe("null_output")
  })

  it("marks undefined output (absent from outputMap) as null_output", () => {
    const mapping: DAGInputMapping = {
      absent: { ref_node: "never-completed" },
    }
    const outputMap = new Map<string, unknown>() // ref_node not in map
    const deps = ["never-completed"] as const

    const result = collectInputMapping(mapping, outputMap, deps)

    expect(result.absent.value).toBeUndefined()
    expect(result.absent.__missing).toBe("null_output")
  })
})

// =========================================================================
// Test 4: ref_path does not exist in object → __missing: 'path_not_found'
// =========================================================================

describe("collectInputMapping — ref_path not found", () => {
  it("marks missing key as path_not_found", () => {
    const mapping: DAGInputMapping = {
      badPath: { ref_node: "upstream", ref_path: "nonexistent.key" },
    }
    const outputMap = new Map<string, unknown>([
      ["upstream", { otherData: "here" }],
    ])
    const deps = ["upstream"] as const

    const result = collectInputMapping(mapping, outputMap, deps)

    expect(result.badPath.value).toBeUndefined()
    expect(result.badPath.__missing).toBe("path_not_found")
  })

  it("marks deeply missing path as path_not_found", () => {
    const mapping: DAGInputMapping = {
      tooDeep: { ref_node: "upstream", ref_path: "a.b.c.d" },
    }
    const outputMap = new Map<string, unknown>([
      ["upstream", { a: { b: { c: "shallow" } } }],
    ])
    const deps = ["upstream"] as const

    const result = collectInputMapping(mapping, outputMap, deps)

    expect(result.tooDeep.value).toBeUndefined()
    expect(result.tooDeep.__missing).toBe("path_not_found")
  })
})

// =========================================================================
// Test 5: output non-object but ref_path present → __missing: 'non_object_output'
// =========================================================================

describe("collectInputMapping — non_object_output", () => {
  it("string output with ref_path → non_object_output", () => {
    const mapping: DAGInputMapping = {
      badRef: { ref_node: "str-node", ref_path: "key" },
    }
    const outputMap = new Map<string, unknown>([["str-node", "just-a-string"]])
    const deps = ["str-node"] as const

    const result = collectInputMapping(mapping, outputMap, deps)

    expect(result.badRef.value).toBeUndefined()
    expect(result.badRef.__missing).toBe("non_object_output")
  })

  it("number output with ref_path → non_object_output", () => {
    const mapping: DAGInputMapping = {
      badRef: { ref_node: "num-node", ref_path: "sub" },
    }
    const outputMap = new Map<string, unknown>([["num-node", 42]])
    const deps = ["num-node"] as const

    const result = collectInputMapping(mapping, outputMap, deps)

    expect(result.badRef.value).toBeUndefined()
    expect(result.badRef.__missing).toBe("non_object_output")
  })

  it("boolean output with ref_path → non_object_output", () => {
    const mapping: DAGInputMapping = {
      badRef: { ref_node: "bool-node", ref_path: "inner" },
    }
    const outputMap = new Map<string, unknown>([["bool-node", true]])
    const deps = ["bool-node"] as const

    const result = collectInputMapping(mapping, outputMap, deps)

    expect(result.badRef.value).toBeUndefined()
    expect(result.badRef.__missing).toBe("non_object_output")
  })

  it("array output with ref_path → non_object_output", () => {
    const mapping: DAGInputMapping = {
      badRef: { ref_node: "arr-node", ref_path: "first" },
    }
    const outputMap = new Map<string, unknown>([["arr-node", [1, 2, 3]]])
    const deps = ["arr-node"] as const

    const result = collectInputMapping(mapping, outputMap, deps)

    expect(result.badRef.value).toBeUndefined()
    expect(result.badRef.__missing).toBe("non_object_output")
  })
})

// =========================================================================
// Test 6: ref_node ∉ dependencies → __missing: 'beyond_deps'
// =========================================================================

describe("collectInputMapping — beyond_deps guard", () => {
  it("skips ref_node not in dependencies with beyond_deps marker", () => {
    const mapping: DAGInputMapping = {
      sneaky: { ref_node: "not-a-dep", ref_path: "val" },
    }
    const outputMap = new Map<string, unknown>([
      ["not-a-dep", { val: "should-not-appear" }],
    ])
    const deps = ["other-dep"] as const

    const result = collectInputMapping(mapping, outputMap, deps)

    expect(result.sneaky.value).toBeUndefined()
    expect(result.sneaky.__missing).toBe("beyond_deps")
  })

  it("empty deps blocks all ref_nodes", () => {
    const mapping: DAGInputMapping = {
      anyRef: { ref_node: "anything" },
    }
    const outputMap = new Map<string, unknown>([["anything", "data"]])
    const deps = [] as const

    const result = collectInputMapping(mapping, outputMap, deps)

    expect(result.anyRef.value).toBeUndefined()
    expect(result.anyRef.__missing).toBe("beyond_deps")
  })
})

// =========================================================================
// Test 7: Mixed scenario — some normal, some missing
// =========================================================================

describe("collectInputMapping — mixed scenario", () => {
  it("handles multiple entries with mixed outcomes", () => {
    const mapping: DAGInputMapping = {
      goodPath: { ref_node: "dep-a", ref_path: "result.id" },
      wholeOutput: { ref_node: "dep-b" },
      nullOutput: { ref_node: "dep-c" },
      pathNotFound: { ref_node: "dep-a", ref_path: "missing.key" },
      beyondDeps: { ref_node: "intruder" },
    }
    const outputMap = new Map<string, unknown>([
      ["dep-a", { result: { id: "abc-123" } }],
      ["dep-b", "raw-value"],
      ["dep-c", null],
    ])
    const deps = ["dep-a", "dep-b", "dep-c"] as const

    const result = collectInputMapping(mapping, outputMap, deps)

    expect(result.goodPath).toEqual({ value: "abc-123" })
    expect(result.wholeOutput).toEqual({ value: "raw-value" })
    expect(result.nullOutput.__missing).toBe("null_output")
    expect(result.pathNotFound.__missing).toBe("path_not_found")
    expect(result.beyondDeps.__missing).toBe("beyond_deps")
  })
})

// =========================================================================
// Test 8: input_mapping == undefined → returns empty Record (backward compat)
// =========================================================================

describe("collectInputMapping — undefined mapping (backward compat)", () => {
  it("returns empty Record when inputMapping is undefined", () => {
    const outputMap = new Map<string, unknown>([["any", "data"]])
    const deps = ["any"] as const

    const result = collectInputMapping(undefined, outputMap, deps)

    expect(Object.keys(result).length).toBe(0)
    expect(result).toEqual({})
  })

  it("returns empty Record when inputMapping is empty object", () => {
    const mapping: DAGInputMapping = {}
    const outputMap = new Map<string, unknown>()
    const deps = [] as const

    const result = collectInputMapping(mapping, outputMap, deps)

    expect(Object.keys(result).length).toBe(0)
  })
})

// =========================================================================
// Test 9: Purity verification
// =========================================================================

describe("collectInputMapping — purity contract", () => {
  it("does not mutate outputMap", () => {
    const mapping: DAGInputMapping = {
      k1: { ref_node: "a", ref_path: "x" },
    }
    const outputMap = new Map<string, unknown>([["a", { x: 1, y: 2 }]])
    const deps = ["a"] as const
    const sizeBefore = outputMap.size

    collectInputMapping(mapping, outputMap, deps)

    expect(outputMap.size).toBe(sizeBefore)
    expect(outputMap.get("a")).toEqual({ x: 1, y: 2 })
  })

  it("produces same result on repeated calls (idempotent)", () => {
    const mapping: DAGInputMapping = {
      v: { ref_node: "src", ref_path: "data" },
    }
    const outputMap = new Map<string, unknown>([["src", { data: "val" }]])
    const deps = ["src"] as const

    const r1 = collectInputMapping(mapping, outputMap, deps)
    const r2 = collectInputMapping(mapping, outputMap, deps)

    expect(r1).toEqual(r2)
  })

  it("result is a new object (does not reference inputMapping)", () => {
    const mapping: DAGInputMapping = {
      k: { ref_node: "n" },
    }
    const outputMap = new Map<string, unknown>([["n", "out"]])
    const deps = ["n"] as const

    const result = collectInputMapping(mapping, outputMap, deps)

    // result should not be the same reference as mapping
    expect(result).not.toBe(mapping)
    // Modifying result should not affect mapping
    result.k = { value: "tampered" }
    expect(mapping.k).toEqual({ ref_node: "n" })
  })
})
