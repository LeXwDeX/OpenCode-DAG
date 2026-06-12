// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * WP-B2: Condition evaluation pure-function unit tests.
 *
 * Tests evaluateCondition (8 ops × positive/negative/null cases),
 * splitByCondition (routing + independence + backward compat),
 * and buildOutputMap (pure projection from completed nodes).
 *
 * NOT covered: scheduleReadyNodes integration (DB-level, WP-B3 scenario-25),
 * actual skip execution (WP-B3), workflow finalization.
 *
 * Acceptance criteria (009-dag-capability-expansion.md §7 WP-B2):
 * - 条件为真 → 节点留在执行列表
 * - 条件为假 → 节点进入"待跳过"列表
 * - 无 condition 的节点行为不变
 * - 8 ops 全覆盖
 * - 多条件节点独立求值
 * - 上游 output 缺失有确定语义
 */

import { describe, expect, it } from "bun:test"
import type { DAGNodeCondition, DAGNodeSession, DAGNodeStatus, DAGNodeConfig } from "../types"
import { evaluateCondition, splitByCondition, buildOutputMap } from "../condition-eval"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeNodeSession(
  nodeId: string,
  status: DAGNodeStatus = "pending",
  deps: string[] = [],
  output: unknown = null,
  condition?: DAGNodeCondition,
): DAGNodeSession {
  const config: DAGNodeConfig = {
    id: nodeId,
    name: `Node ${nodeId}`,
    required: false,
    dependencies: deps,
    worker_type: "general",
    worker_config: {},
    ...(condition ? { condition } : {}),
  }
  return {
    node_id: nodeId,
    workflow_id: "wf-test",
    config,
    status,
    output,
    retry_count: 0,
    max_retries: 0,
    timeout_ms: 300_000,
    required_nodes: [],
    dependencies: deps,
    metadata: {},
    start_time: null,
    completed_at: null,
    end_time: null,
    duration_ms: null,
    parent_node: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    logs: [],
  }
}

// =========================================================================
// evaluateCondition — 8 ops
// =========================================================================

describe("evaluateCondition — eq", () => {
  it("true: output matches value", () => {
    const map = new Map<string, unknown>([["a", 42]])
    expect(evaluateCondition({ ref_node: "a", op: "eq", value: 42 }, map)).toBe(true)
  })

  it("true: string match", () => {
    const map = new Map<string, unknown>([["a", "done"]])
    expect(evaluateCondition({ ref_node: "a", op: "eq", value: "done" }, map)).toBe(true)
  })

  it("false: output does not match value", () => {
    const map = new Map<string, unknown>([["a", 99]])
    expect(evaluateCondition({ ref_node: "a", op: "eq", value: 42 }, map)).toBe(false)
  })

  it("null output vs non-null value: false", () => {
    const map = new Map<string, unknown>([["a", null]])
    expect(evaluateCondition({ ref_node: "a", op: "eq", value: 42 }, map)).toBe(false)
  })

  it("null output vs null value: true (null === null)", () => {
    const map = new Map<string, unknown>([["a", null]])
    expect(evaluateCondition({ ref_node: "a", op: "eq", value: null }, map)).toBe(true)
  })

  it("absent ref_node (output treated as null) vs non-null value: false", () => {
    const map = new Map<string, unknown>()
    expect(evaluateCondition({ ref_node: "a", op: "eq", value: 42 }, map)).toBe(false)
  })

  it("absent ref_node vs null value: true", () => {
    const map = new Map<string, unknown>()
    expect(evaluateCondition({ ref_node: "a", op: "eq", value: null }, map)).toBe(true)
  })
})

describe("evaluateCondition — ne", () => {
  it("true: output differs from value", () => {
    const map = new Map<string, unknown>([["a", 99]])
    expect(evaluateCondition({ ref_node: "a", op: "ne", value: 42 }, map)).toBe(true)
  })

  it("false: output equals value", () => {
    const map = new Map<string, unknown>([["a", 42]])
    expect(evaluateCondition({ ref_node: "a", op: "ne", value: 42 }, map)).toBe(false)
  })

  it("null output vs non-null value: true (null !== 42)", () => {
    const map = new Map<string, unknown>([["a", null]])
    expect(evaluateCondition({ ref_node: "a", op: "ne", value: 42 }, map)).toBe(true)
  })

  it("null output vs null value: false (null === null → !== is false)", () => {
    const map = new Map<string, unknown>([["a", null]])
    expect(evaluateCondition({ ref_node: "a", op: "ne", value: null }, map)).toBe(false)
  })
})

describe("evaluateCondition — gt", () => {
  it("true: output > value (number)", () => {
    const map = new Map<string, unknown>([["a", 10]])
    expect(evaluateCondition({ ref_node: "a", op: "gt", value: 5 }, map)).toBe(true)
  })

  it("false: output == value", () => {
    const map = new Map<string, unknown>([["a", 5]])
    expect(evaluateCondition({ ref_node: "a", op: "gt", value: 5 }, map)).toBe(false)
  })

  it("false: output < value", () => {
    const map = new Map<string, unknown>([["a", 3]])
    expect(evaluateCondition({ ref_node: "a", op: "gt", value: 5 }, map)).toBe(false)
  })

  it("null output: false (missing data not comparable)", () => {
    const map = new Map<string, unknown>([["a", null]])
    expect(evaluateCondition({ ref_node: "a", op: "gt", value: 5 }, map)).toBe(false)
  })

  it("absent ref_node: false", () => {
    const map = new Map<string, unknown>()
    expect(evaluateCondition({ ref_node: "a", op: "gt", value: 5 }, map)).toBe(false)
  })

  it("true: string comparison (lexicographic)", () => {
    const map = new Map<string, unknown>([["a", "b"]])
    expect(evaluateCondition({ ref_node: "a", op: "gt", value: "a" }, map)).toBe(true)
  })
})

describe("evaluateCondition — lt", () => {
  it("true: output < value", () => {
    const map = new Map<string, unknown>([["a", 3]])
    expect(evaluateCondition({ ref_node: "a", op: "lt", value: 5 }, map)).toBe(true)
  })

  it("false: output > value", () => {
    const map = new Map<string, unknown>([["a", 10]])
    expect(evaluateCondition({ ref_node: "a", op: "lt", value: 5 }, map)).toBe(false)
  })

  it("null output: false", () => {
    const map = new Map<string, unknown>([["a", null]])
    expect(evaluateCondition({ ref_node: "a", op: "lt", value: 5 }, map)).toBe(false)
  })
})

describe("evaluateCondition — gte", () => {
  it("true: output == value", () => {
    const map = new Map<string, unknown>([["a", 5]])
    expect(evaluateCondition({ ref_node: "a", op: "gte", value: 5 }, map)).toBe(true)
  })

  it("true: output > value", () => {
    const map = new Map<string, unknown>([["a", 6]])
    expect(evaluateCondition({ ref_node: "a", op: "gte", value: 5 }, map)).toBe(true)
  })

  it("false: output < value", () => {
    const map = new Map<string, unknown>([["a", 4]])
    expect(evaluateCondition({ ref_node: "a", op: "gte", value: 5 }, map)).toBe(false)
  })

  it("null output: false", () => {
    const map = new Map<string, unknown>([["a", null]])
    expect(evaluateCondition({ ref_node: "a", op: "gte", value: 5 }, map)).toBe(false)
  })
})

describe("evaluateCondition — lte", () => {
  it("true: output == value", () => {
    const map = new Map<string, unknown>([["a", 5]])
    expect(evaluateCondition({ ref_node: "a", op: "lte", value: 5 }, map)).toBe(true)
  })

  it("true: output < value", () => {
    const map = new Map<string, unknown>([["a", 4]])
    expect(evaluateCondition({ ref_node: "a", op: "lte", value: 5 }, map)).toBe(true)
  })

  it("false: output > value", () => {
    const map = new Map<string, unknown>([["a", 6]])
    expect(evaluateCondition({ ref_node: "a", op: "lte", value: 5 }, map)).toBe(false)
  })

  it("null output: false", () => {
    const map = new Map<string, unknown>([["a", null]])
    expect(evaluateCondition({ ref_node: "a", op: "lte", value: 5 }, map)).toBe(false)
  })
})

describe("evaluateCondition — exists", () => {
  it("true: output is non-null number", () => {
    const map = new Map<string, unknown>([["a", 42]])
    expect(evaluateCondition({ ref_node: "a", op: "exists" }, map)).toBe(true)
  })

  it("true: output is empty string (still exists)", () => {
    const map = new Map<string, unknown>([["a", ""]])
    expect(evaluateCondition({ ref_node: "a", op: "exists" }, map)).toBe(true)
  })

  it("true: output is 0 (still exists)", () => {
    const map = new Map<string, unknown>([["a", 0]])
    expect(evaluateCondition({ ref_node: "a", op: "exists" }, map)).toBe(true)
  })

  it("true: output is false (still exists)", () => {
    const map = new Map<string, unknown>([["a", false]])
    expect(evaluateCondition({ ref_node: "a", op: "exists" }, map)).toBe(true)
  })

  it("false: output is null", () => {
    const map = new Map<string, unknown>([["a", null]])
    expect(evaluateCondition({ ref_node: "a", op: "exists" }, map)).toBe(false)
  })

  it("false: output is undefined", () => {
    const map = new Map<string, unknown>([["a", undefined]])
    expect(evaluateCondition({ ref_node: "a", op: "exists" }, map)).toBe(false)
  })

  it("false: ref_node absent from map (treated as undefined)", () => {
    const map = new Map<string, unknown>()
    expect(evaluateCondition({ ref_node: "a", op: "exists" }, map)).toBe(false)
  })

  it("ignores value field", () => {
    const map = new Map<string, unknown>([["a", "data"]])
    expect(evaluateCondition({ ref_node: "a", op: "exists", value: "anything" }, map)).toBe(true)
  })
})

describe("evaluateCondition — not_exists", () => {
  it("true: output is null", () => {
    const map = new Map<string, unknown>([["a", null]])
    expect(evaluateCondition({ ref_node: "a", op: "not_exists" }, map)).toBe(true)
  })

  it("true: output is undefined", () => {
    const map = new Map<string, unknown>([["a", undefined]])
    expect(evaluateCondition({ ref_node: "a", op: "not_exists" }, map)).toBe(true)
  })

  it("true: ref_node absent from map", () => {
    const map = new Map<string, unknown>()
    expect(evaluateCondition({ ref_node: "a", op: "not_exists" }, map)).toBe(true)
  })

  it("false: output is non-null number", () => {
    const map = new Map<string, unknown>([["a", 42]])
    expect(evaluateCondition({ ref_node: "a", op: "not_exists" }, map)).toBe(false)
  })

  it("false: output is empty string (still exists)", () => {
    const map = new Map<string, unknown>([["a", ""]])
    expect(evaluateCondition({ ref_node: "a", op: "not_exists" }, map)).toBe(false)
  })

  it("ignores value field", () => {
    const map = new Map<string, unknown>([["a", null]])
    expect(evaluateCondition({ ref_node: "a", op: "not_exists", value: "anything" }, map)).toBe(true)
  })
})

// =========================================================================
// splitByCondition — routing + independence + backward compat
// =========================================================================

describe("splitByCondition", () => {
  it("node without condition → always executeList", () => {
    const node = makeNodeSession("n1", "pending", [])
    const result = splitByCondition([node], new Map())
    expect(result.executeList.map(n => n.node_id)).toEqual(["n1"])
    expect(result.skipCandidates).toEqual([])
  })

  it("condition true → executeList", () => {
    const node = makeNodeSession("n2", "pending", ["n1"], null, {
      ref_node: "n1",
      op: "eq",
      value: "done",
    })
    const map = new Map<string, unknown>([["n1", "done"]])
    const result = splitByCondition([node], map)
    expect(result.executeList.map(n => n.node_id)).toEqual(["n2"])
    expect(result.skipCandidates).toEqual([])
  })

  it("condition false → skipCandidates", () => {
    const node = makeNodeSession("n2", "pending", ["n1"], null, {
      ref_node: "n1",
      op: "eq",
      value: "done",
    })
    const map = new Map<string, unknown>([["n1", "failed"]])
    const result = splitByCondition([node], map)
    expect(result.executeList).toEqual([])
    expect(result.skipCandidates.map(n => n.node_id)).toEqual(["n2"])
  })

  it("mixed: some conditions true, some false, some absent", () => {
    const n1 = makeNodeSession("n1") // no condition
    const n2 = makeNodeSession("n2", "pending", ["n1"], null, {
      ref_node: "n1",
      op: "exists",
    })
    const n3 = makeNodeSession("n3", "pending", ["n1"], null, {
      ref_node: "n1",
      op: "not_exists",
    })
    const map = new Map<string, unknown>([["n1", "value"]])
    const result = splitByCondition([n1, n2, n3], map)
    expect(result.executeList.map(n => n.node_id)).toEqual(["n1", "n2"])
    expect(result.skipCandidates.map(n => n.node_id)).toEqual(["n3"])
  })

  it("independent evaluation: A condition false does not affect B condition", () => {
    const nA = makeNodeSession("nA", "pending", ["n1"], null, {
      ref_node: "n1",
      op: "eq",
      value: "X",
    })
    const nB = makeNodeSession("nB", "pending", ["n1"], null, {
      ref_node: "n1",
      op: "exists",
    })
    const map = new Map<string, unknown>([["n1", "data"]])
    const result = splitByCondition([nA, nB], map)
    // nA: "data" === "X" → false → skipCandidates
    // nB: "data" exists → true → executeList
    expect(result.executeList.map(n => n.node_id)).toEqual(["nB"])
    expect(result.skipCandidates.map(n => n.node_id)).toEqual(["nA"])
  })

  it("empty readyNodes → empty lists", () => {
    const result = splitByCondition([], new Map())
    expect(result.executeList).toEqual([])
    expect(result.skipCandidates).toEqual([])
  })

  it("all nodes without conditions → all executed", () => {
    const nodes = [
      makeNodeSession("n1"),
      makeNodeSession("n2"),
      makeNodeSession("n3"),
    ]
    const result = splitByCondition(nodes, new Map())
    expect(result.executeList.map(n => n.node_id)).toEqual(["n1", "n2", "n3"])
    expect(result.skipCandidates).toEqual([])
  })
})

// =========================================================================
// buildOutputMap — pure projection
// =========================================================================

describe("buildOutputMap", () => {
  it("extracts output from completed nodes keyed by config.id", () => {
    const nodes = [
      makeNodeSession("n1", "completed", [], "result-1"),
      makeNodeSession("n2", "completed", ["n1"], "result-2"),
      makeNodeSession("n3", "pending", ["n1", "n2"]),
    ]
    const map = buildOutputMap(nodes)
    expect(map.get("n1")).toBe("result-1")
    expect(map.get("n2")).toBe("result-2")
    expect(map.has("n3")).toBe(false)
  })

  it("null output included (null is a valid output value)", () => {
    const nodes = [
      makeNodeSession("n1", "completed", [], null),
    ]
    const map = buildOutputMap(nodes)
    expect(map.has("n1")).toBe(true)
    expect(map.get("n1")).toBe(null)
  })

  it("skips non-completed nodes (pending, running, failed, skipped)", () => {
    const nodes = [
      makeNodeSession("n1", "pending", [], "should-not-appear"),
      makeNodeSession("n2", "running", [], "should-not-appear"),
      makeNodeSession("n3", "failed", [], "should-not-appear"),
      makeNodeSession("n4", "skipped", [], "should-not-appear"),
      makeNodeSession("n5", "completed", [], "only-this"),
    ]
    const map = buildOutputMap(nodes)
    expect(map.size).toBe(1)
    expect(map.get("n5")).toBe("only-this")
  })

  it("empty nodes → empty map", () => {
    const map = buildOutputMap([])
    expect(map.size).toBe(0)
  })
})

// =========================================================================
// Purity verification (structural, not runtime)
// =========================================================================

describe("purity contract", () => {
  it("evaluateCondition does not mutate outputMap", () => {
    const map = new Map<string, unknown>([["a", 42]])
    const keysBefore = [...map.keys()]
    evaluateCondition({ ref_node: "a", op: "eq", value: 42 }, map)
    expect([...map.keys()]).toEqual(keysBefore)
    expect(map.get("a")).toBe(42)
  })

  it("evaluateCondition produces same result on repeated calls (idempotent)", () => {
    const map = new Map<string, unknown>([["a", 10]])
    const cond: DAGNodeCondition = { ref_node: "a", op: "gt", value: 5 }
    const r1 = evaluateCondition(cond, map)
    const r2 = evaluateCondition(cond, map)
    expect(r1).toBe(r2)
  })

  it("splitByCondition does not mutate input array", () => {
    const nodes = [
      makeNodeSession("n1", "pending", ["dep"], null, { ref_node: "dep", op: "eq", value: "x" }),
    ]
    const original = [...nodes]
    splitByCondition(nodes, new Map([["dep", "y"]]))
    expect(nodes).toEqual(original)
  })
})

// =========================================================================
// WP3E: ref_path sub-field extraction
// =========================================================================

describe("evaluateCondition — ref_path with plain object output", () => {
  it("eq: ref_path resolves to matching value → true", () => {
    const map = new Map<string, unknown>([
      ["a", { result: { status: "done" } }],
    ])
    expect(
      evaluateCondition(
        { ref_node: "a", op: "eq", value: "done", ref_path: "result.status" },
        map,
      ),
    ).toBe(true)
  })

  it("eq: ref_path resolves to non-matching value → false", () => {
    const map = new Map<string, unknown>([
      ["a", { result: { status: "pending" } }],
    ])
    expect(
      evaluateCondition(
        { ref_node: "a", op: "eq", value: "done", ref_path: "result.status" },
        map,
      ),
    ).toBe(false)
  })

  it("exists: ref_path resolves → true", () => {
    const map = new Map<string, unknown>([["a", { x: 0 }]])
    expect(
      evaluateCondition(
        { ref_node: "a", op: "exists", ref_path: "x" },
        map,
      ),
    ).toBe(true)
  })

  it("PATH_NOT_FOUND: ref_path missing → null (exists=false, eq null=true)", () => {
    const map = new Map<string, unknown>([["a", { x: 1 }]])
    // PATH_NOT_FOUND → null → exists = false
    expect(
      evaluateCondition(
        { ref_node: "a", op: "exists", ref_path: "missing" },
        map,
      ),
    ).toBe(false)
    // null === null → eq true (8-op table: null output eq null value = true)
    expect(
      evaluateCondition(
        { ref_node: "a", op: "eq", value: null, ref_path: "missing" },
        map,
      ),
    ).toBe(true)
  })

  it("gt: ref_path resolves to number → comparison works", () => {
    const map = new Map<string, unknown>([["a", { metrics: { count: 10 } }]])
    expect(
      evaluateCondition(
        { ref_node: "a", op: "gt", value: 5, ref_path: "metrics.count" },
        map,
      ),
    ).toBe(true)
  })

  it("gt: ref_path null (missing) → false (not comparable)", () => {
    const map = new Map<string, unknown>([["a", { x: 1 }]])
    expect(
      evaluateCondition(
        { ref_node: "a", op: "gt", value: 5, ref_path: "missing" },
        map,
      ),
    ).toBe(false)
  })
})

describe("evaluateCondition — ref_path with string output (JSON.parse leniency)", () => {
  it("valid JSON object string + ref_path → resolves sub-field", () => {
    // node_complete output is always string; JSON.parse succeeds to object
    const map = new Map<string, unknown>([["a", '{"result":{"id":"abc"}}']])
    expect(
      evaluateCondition(
        { ref_node: "a", op: "eq", value: "abc", ref_path: "result.id" },
        map,
      ),
    ).toBe(true)
  })

  it("valid JSON but non-object (array) string → treated as null", () => {
    // JSON.parse("[1,2,3]") succeeds but result is array → non-object → null
    const map = new Map<string, unknown>([["a", "[1,2,3]"]])
    expect(
      evaluateCondition(
        { ref_node: "a", op: "exists", ref_path: "length" },
        map,
      ),
    ).toBe(false)
  })

  it("valid JSON but non-object (number) string → treated as null", () => {
    const map = new Map<string, unknown>([["a", "42"]])
    expect(
      evaluateCondition(
        { ref_node: "a", op: "eq", value: 42, ref_path: "value" },
        map,
      ),
    ).toBe(false)
  })

  it("valid JSON null string → treated as null", () => {
    const map = new Map<string, unknown>([["a", "null"]])
    expect(
      evaluateCondition(
        { ref_node: "a", op: "not_exists", ref_path: "x" },
        map,
      ),
    ).toBe(true)
  })

  it("malformed JSON string → parse failure → treated as null", () => {
    const map = new Map<string, unknown>([["a", "{not valid json"]])
    expect(
      evaluateCondition(
        { ref_node: "a", op: "exists", ref_path: "key" },
        map,
      ),
    ).toBe(false)
  })
})

describe("evaluateCondition — ref_path with non-object/non-string output", () => {
  it("number output + ref_path → null", () => {
    const map = new Map<string, unknown>([["a", 42]])
    expect(
      evaluateCondition(
        { ref_node: "a", op: "exists", ref_path: "sub" },
        map,
      ),
    ).toBe(false)
  })

  it("boolean output + ref_path → null", () => {
    const map = new Map<string, unknown>([["a", true]])
    expect(
      evaluateCondition(
        { ref_node: "a", op: "exists", ref_path: "x" },
        map,
      ),
    ).toBe(false)
  })

  it("array output + ref_path → null (array excluded)", () => {
    const map = new Map<string, unknown>([["a", [1, 2]]])
    expect(
      evaluateCondition(
        { ref_node: "a", op: "exists", ref_path: "0" },
        map,
      ),
    ).toBe(false)
  })

  it("null output + ref_path → null", () => {
    const map = new Map<string, unknown>([["a", null]])
    expect(
      evaluateCondition(
        { ref_node: "a", op: "eq", value: null, ref_path: "x" },
        map,
      ),
    ).toBe(true)
  })
})

describe("evaluateCondition — ref_path absent (backward compatibility)", () => {
  it("no ref_path: eq on raw output (unchanged behavior)", () => {
    const map = new Map<string, unknown>([["a", 42]])
    expect(evaluateCondition({ ref_node: "a", op: "eq", value: 42 }, map)).toBe(true)
  })

  it("no ref_path: exists on object output", () => {
    const map = new Map<string, unknown>([["a", { nested: true }]])
    expect(evaluateCondition({ ref_node: "a", op: "exists" }, map)).toBe(true)
  })

  it("no ref_path on string output: no JSON.parse → string compared directly", () => {
    // Without ref_path, string output should NOT be JSON-parsed (ruling 2 preserved
    // at the raw layer). string "42" === value "42" → true.
    const map = new Map<string, unknown>([["a", "42"]])
    expect(evaluateCondition({ ref_node: "a", op: "eq", value: "42" }, map)).toBe(true)
  })
})
