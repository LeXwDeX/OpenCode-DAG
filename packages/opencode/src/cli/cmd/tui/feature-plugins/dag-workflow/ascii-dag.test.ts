/**
 * WP4 ascii-dag.tsx tests
 *
 * Tests:
 * - topologicalLayers: Kahn's algorithm correctness (3+ levels)
 * - nodeStatusIcon: all statuses produce correct icons
 */
import { describe, it, expect } from "bun:test"
import { calculateAsciiDagNodeWidth, topologicalLayers, nodeStatusIcon } from "./ascii-dag"
import type { DAGNodeSession, DAGNodeStatus } from "@/dag/session/types"

/**
 * Helper: create a minimal DAGNodeSession for testing.
 */
function makeNode(
  id: string,
  status: DAGNodeStatus,
  deps: string[],
): DAGNodeSession {
  return {
    node_id: id,
    workflow_id: "wf-test",
    config: {
      id,
      name: id,
      dependencies: deps,
      required: true,
      worker_type: "subagent",
      worker_config: {},
    },
    status,
    output: null,
    retry_count: 0,
    max_retries: 0,
    timeout_ms: 60_000,
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

describe("WP4 ascii-dag — topologicalLayers", () => {
  it("returns empty array for empty input", () => {
    const result = topologicalLayers([])
    expect(result).toEqual([])
  })

  it("handles single root node (1 layer)", () => {
    const nodes = [makeNode("a", "completed", [])]
    const result = topologicalLayers(nodes)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(["a"])
  })

  it("handles 3 linear layers: a → b → c", () => {
    const nodes = [
      makeNode("a", "completed", []),
      makeNode("b", "running", ["a"]),
      makeNode("c", "pending", ["b"]),
    ]
    const result = topologicalLayers(nodes)
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual(["a"])
    expect(result[1]).toEqual(["b"])
    expect(result[2]).toEqual(["c"])
  })

  it("groups parallel nodes in same layer: a → b,c both depend on a", () => {
    const nodes = [
      makeNode("a", "completed", []),
      makeNode("b", "pending", ["a"]),
      makeNode("c", "pending", ["a"]),
    ]
    const result = topologicalLayers(nodes)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual(["a"])
    // b and c are in the same layer
    expect(result[1].sort()).toEqual(["b", "c"])
  })

  it("handles diamond: a → b,c → d", () => {
    const nodes = [
      makeNode("a", "completed", []),
      makeNode("b", "completed", ["a"]),
      makeNode("c", "running", ["a"]),
      makeNode("d", "pending", ["b", "c"]),
    ]
    const result = topologicalLayers(nodes)
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual(["a"])
    expect(result[1].sort()).toEqual(["b", "c"])
    expect(result[2]).toEqual(["d"])
  })

  it("handles 3+ independent roots in layer 0", () => {
    const nodes = [
      makeNode("r1", "pending", []),
      makeNode("r2", "running", []),
      makeNode("r3", "completed", []),
      makeNode("x", "pending", ["r1", "r2"]),
    ]
    const result = topologicalLayers(nodes)
    expect(result[0].sort()).toEqual(["r1", "r2", "r3"])
    expect(result[1]).toEqual(["x"])
  })

  it("topologicalLayers: dangling dependency (dep ID not in node list)", () => {
    const nodes = [
      makeNode("a", "running", []),
      makeNode("b", "running", ["a", "ghost"]), // "ghost" not in node list
    ]
    const result = topologicalLayers(nodes)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual(["a"])
    expect(result[1]).toEqual(["b"]) // b must not be silently excluded
  })

  it("pure cycle (a↔b): no roots → both appended as leftover layer", () => {
    const nodes = [
      makeNode("a", "pending", ["b"]),
      makeNode("b", "pending", ["a"]),
    ]
    const result = topologicalLayers(nodes)
    // No node has inDegree 0, so Kahn produces no layers; cycle nodes
    // must still surface (never silently dropped).
    expect(result).toHaveLength(1)
    expect(result[0].sort()).toEqual(["a", "b"])
  })

  it("root feeding a cycle: root placed first, cycle nodes appended last", () => {
    const nodes = [
      makeNode("a", "completed", []),
      makeNode("b", "pending", ["c"]),
      makeNode("c", "pending", ["b"]),
    ]
    const result = topologicalLayers(nodes)
    expect(result[0]).toEqual(["a"])
    const leftover = result[result.length - 1]
    expect(leftover.sort()).toEqual(["b", "c"])
    // every node appears exactly once across all layers
    expect(result.flat().sort()).toEqual(["a", "b", "c"])
  })
})

describe("WP4 ascii-dag — nodeStatusIcon", () => {
  it("returns + for completed", () => {
    expect(nodeStatusIcon("completed").icon).toBe("+")
  })

  it("returns * for running", () => {
    expect(nodeStatusIcon("running").icon).toBe("*")
  })

  it("returns o for pending", () => {
    expect(nodeStatusIcon("pending").icon).toBe("o")
  })

  it("returns x for failed", () => {
    expect(nodeStatusIcon("failed").icon).toBe("x")
  })

  it("returns - for skipped", () => {
    expect(nodeStatusIcon("skipped").icon).toBe("-")
  })

  it("returns @ for queued", () => {
    expect(nodeStatusIcon("queued").icon).toBe("@")
  })
})

describe("WP-A ascii-dag — adaptive node width", () => {
  it("preserves the default readable width when the available width can fit all layers", () => {
    expect(calculateAsciiDagNodeWidth({ availableWidth: 80, layerCount: 3 })).toBe(20)
  })

  it("compacts node width for narrow layouts instead of keeping the fixed default", () => {
    expect(calculateAsciiDagNodeWidth({ availableWidth: 36, layerCount: 3 })).toBe(8)
  })

  it("compacts a single narrow layer instead of keeping the fixed default", () => {
    expect(calculateAsciiDagNodeWidth({ availableWidth: 12, layerCount: 1 })).toBe(12)
  })

  it("preserves the minimum node width for a single layer narrower than the minimum", () => {
    expect(calculateAsciiDagNodeWidth({ availableWidth: 4, layerCount: 1 })).toBe(8)
  })

  it("preserves no-render width semantics for zero layers", () => {
    expect(calculateAsciiDagNodeWidth({ availableWidth: 4, layerCount: 0 })).toBe(20)
  })

  it("preserves the requested width for a single layer when the available width can fit it", () => {
    expect(calculateAsciiDagNodeWidth({ availableWidth: 80, layerCount: 1 })).toBe(20)
  })

  it("respects an explicit smaller node width without widening it", () => {
    expect(calculateAsciiDagNodeWidth({ availableWidth: 80, layerCount: 3, requestedNodeWidth: 12 })).toBe(12)
  })

  it("does not change topologicalLayers semantics while adding width adaptation", () => {
    const nodes = [
      makeNode("a", "completed", []),
      makeNode("b", "running", ["a"]),
      makeNode("c", "pending", ["b"]),
    ]
    const layers = topologicalLayers(nodes)
    expect(calculateAsciiDagNodeWidth({ availableWidth: 36, layerCount: layers.length })).toBe(8)
    expect(layers).toEqual([["a"], ["b"], ["c"]])
  })
})
