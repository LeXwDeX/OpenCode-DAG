/**
 * WP4 ascii-dag.tsx tests
 *
 * Tests:
 * - topologicalLayers: Kahn's algorithm correctness (3+ levels)
 * - nodeStatusIcon: all statuses produce correct icons
 */
import { describe, it, expect } from "bun:test"
import { topologicalLayers, nodeStatusIcon } from "./ascii-dag"
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
})

describe("WP4 ascii-dag — nodeStatusIcon", () => {
  it("returns ✓ for completed", () => {
    expect(nodeStatusIcon("completed").icon).toBe("\u2713")
  })

  it("returns ● for running", () => {
    expect(nodeStatusIcon("running").icon).toBe("\u25cf")
  })

  it("returns ◌ for pending", () => {
    expect(nodeStatusIcon("pending").icon).toBe("\u25cb")
  })

  it("returns ✗ for failed", () => {
    expect(nodeStatusIcon("failed").icon).toBe("\u2717")
  })

  it("returns ⊘ for skipped", () => {
    expect(nodeStatusIcon("skipped").icon).toBe("\u2298")
  })

  it("returns ◍ for queued", () => {
    expect(nodeStatusIcon("queued").icon).toBe("\u25ce")
  })
})
