// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * @file execution-core.test.ts
 * @description Unit tests for DAG Execution Core (A Layer) — pure functions only.
 *
 * Tests all 13 pure functions + 2 state transition tables exported from
 * execution-core.ts. No DB, no Effect runtime, no DI needed.
 */

import { describe, it, expect } from "bun:test"
import {
  areDependenciesSatisfied,
  getReadyNodes,
  computeFinalWorkflowStatus,
  computeSpawnBudget,
  detectCycle,
  findPendingDescendants,
  validateReplanPreconditions,
  classifyReplanNodes,
  validateFrozenAndExistence,
  applyReplanPatchToConfig,
  buildReplanDbInputs,
  getValidNextSessionWorkflowStatuses,
  getValidNextSessionNodeStatuses,
} from "../execution-core"
import type {
  DAGNodeConfig,
  DAGNodeSession,
  ReplanPatch,
} from "../types"

// ============================================================================
// Test Helpers
// ============================================================================

function makeNodeConfig(overrides: Partial<DAGNodeConfig> & { id: string }): DAGNodeConfig {
  return {
    name: overrides.id,
    dependencies: [],
    required: false,
    worker_type: "mock",
    worker_config: {},
    ...overrides,
  }
}

function makeNodeSession(
  overrides: Partial<DAGNodeSession> & { node_id: string; status: DAGNodeSession["status"] },
): DAGNodeSession {
  return {
    workflow_id: "wf",
    config: makeNodeConfig({ id: overrides.node_id }),
    output: null,
    retry_count: 0,
    max_retries: 0,
    timeout_ms: 300000,
    required_nodes: [],
    dependencies: [],
    metadata: {},
    start_time: null,
    completed_at: null,
    end_time: null,
    duration_ms: null,
    parent_node: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    logs: [],
    ...overrides,
  }
}

// ============================================================================
// 1. areDependenciesSatisfied
// ============================================================================

describe("areDependenciesSatisfied", () => {
  it("returns true when node has no dependencies", () => {
    const node = makeNodeSession({ node_id: "a", status: "pending", dependencies: [] })
    expect(areDependenciesSatisfied(node, new Set())).toBe(true)
  })

  it("returns true when all dependencies are in completed set", () => {
    const node = makeNodeSession({ node_id: "c", status: "pending", dependencies: ["a", "b"] })
    expect(areDependenciesSatisfied(node, new Set(["a", "b"]))).toBe(true)
  })

  it("returns false when some dependencies are missing from completed set", () => {
    const node = makeNodeSession({ node_id: "c", status: "pending", dependencies: ["a", "b"] })
    expect(areDependenciesSatisfied(node, new Set(["a"]))).toBe(false)
  })

  it("returns false when no dependencies are completed", () => {
    const node = makeNodeSession({ node_id: "b", status: "pending", dependencies: ["a"] })
    expect(areDependenciesSatisfied(node, new Set())).toBe(false)
  })
})

// ============================================================================
// 2. getReadyNodes
// ============================================================================

describe("getReadyNodes", () => {
  it("returns nodes with all deps satisfied and not in running/completed/failed", () => {
    const a = makeNodeSession({ node_id: "a", status: "completed", dependencies: [] })
    const b = makeNodeSession({ node_id: "b", status: "pending", dependencies: ["a"] })
    const c = makeNodeSession({ node_id: "c", status: "pending", dependencies: ["a"] })
    const d = makeNodeSession({ node_id: "d", status: "pending", dependencies: ["b"] })

    const completed = new Set(["a"])
    const failed = new Set<string>()
    const running = new Set<string>()

    const ready = getReadyNodes([a, b, c, d], completed, failed, running)
    const readyIds = ready.map(n => n.node_id).sort()
    expect(readyIds).toEqual(["b", "c"])
  })

  it("excludes nodes that are running", () => {
    const a = makeNodeSession({ node_id: "a", status: "running", dependencies: [] })
    const ready = getReadyNodes([a], new Set(), new Set(), new Set(["a"]))
    expect(ready).toEqual([])
  })

  it("excludes nodes that are failed", () => {
    const a = makeNodeSession({ node_id: "a", status: "failed", dependencies: [] })
    const ready = getReadyNodes([a], new Set(), new Set(["a"]), new Set())
    expect(ready).toEqual([])
  })

  it("excludes nodes that are skipped (WP1: cascade-skipped nodes must not re-enter ready set)", () => {
    const a = makeNodeSession({ node_id: "a", status: "completed", dependencies: [] })
    const b = makeNodeSession({ node_id: "b", status: "skipped", dependencies: ["a"] })
    const ready = getReadyNodes([a, b], new Set(["a"]), new Set(), new Set())
    expect(ready).toEqual([])
  })

  it("skipped node with all deps satisfied is still excluded", () => {
    const a = makeNodeSession({ node_id: "a", status: "completed", dependencies: [] })
    const b = makeNodeSession({ node_id: "b", status: "completed", dependencies: [] })
    const c = makeNodeSession({ node_id: "c", status: "skipped", dependencies: ["a", "b"] })
    const ready = getReadyNodes([a, b, c], new Set(["a", "b"]), new Set(), new Set())
    expect(ready).toEqual([])
  })

  it("returns empty array when no nodes are ready", () => {
    const a = makeNodeSession({ node_id: "a", status: "pending", dependencies: ["x"] })
    const ready = getReadyNodes([a], new Set(), new Set(), new Set())
    expect(ready).toEqual([])
  })
})

// ============================================================================
// 3. computeFinalWorkflowStatus
// ============================================================================

describe("computeFinalWorkflowStatus", () => {
  it("returns null when there are pending nodes", () => {
    const nodes = [
      makeNodeSession({ node_id: "a", status: "completed" }),
      makeNodeSession({ node_id: "b", status: "pending" }),
    ]
    expect(computeFinalWorkflowStatus(nodes)).toBeNull()
  })

  it("returns null when there are running nodes", () => {
    const nodes = [
      makeNodeSession({ node_id: "a", status: "completed" }),
      makeNodeSession({ node_id: "b", status: "running" }),
    ]
    expect(computeFinalWorkflowStatus(nodes)).toBeNull()
  })

  it("returns null when there are queued nodes", () => {
    const nodes = [
      makeNodeSession({ node_id: "a", status: "completed" }),
      makeNodeSession({ node_id: "b", status: "queued" }),
    ]
    expect(computeFinalWorkflowStatus(nodes)).toBeNull()
  })

  it("returns 'failed' when a required node has failed", () => {
    const nodes = [
      makeNodeSession({
        node_id: "a",
        status: "failed",
        config: makeNodeConfig({ id: "a", required: true }),
      }),
      makeNodeSession({ node_id: "b", status: "completed" }),
    ]
    expect(computeFinalWorkflowStatus(nodes)).toBe("failed")
  })

  it("returns 'completed' when all nodes are terminal and no required failed", () => {
    const nodes = [
      makeNodeSession({ node_id: "a", status: "completed" }),
      makeNodeSession({ node_id: "b", status: "completed" }),
      makeNodeSession({ node_id: "c", status: "skipped" }),
    ]
    expect(computeFinalWorkflowStatus(nodes)).toBe("completed")
  })

  it("returns 'completed' when optional node failed but no required failed", () => {
    const nodes = [
      makeNodeSession({
        node_id: "a",
        status: "failed",
        config: makeNodeConfig({ id: "a", required: false }),
      }),
      makeNodeSession({ node_id: "b", status: "completed" }),
    ]
    expect(computeFinalWorkflowStatus(nodes)).toBe("completed")
  })
})

// ============================================================================
// 4. computeSpawnBudget
// ============================================================================

describe("computeSpawnBudget", () => {
  it("computes correct budget", () => {
    expect(computeSpawnBudget(5, 2, 1)).toBe(2)
  })

  it("returns 0 when at capacity", () => {
    expect(computeSpawnBudget(3, 2, 1)).toBe(0)
  })

  it("returns negative when over capacity", () => {
    expect(computeSpawnBudget(2, 2, 1)).toBe(-1)
  })

  it("returns full budget when nothing running", () => {
    expect(computeSpawnBudget(10, 0, 0)).toBe(10)
  })
})

// ============================================================================
// 5. detectCycle
// ============================================================================

describe("detectCycle", () => {
  it("returns false for acyclic graph", () => {
    const nodes = [
      makeNodeConfig({ id: "a" }),
      makeNodeConfig({ id: "b", dependencies: ["a"] }),
      makeNodeConfig({ id: "c", dependencies: ["b"] }),
    ]
    expect(detectCycle(nodes)).toBe(false)
  })

  it("returns true for direct cycle", () => {
    const nodes = [
      makeNodeConfig({ id: "a", dependencies: ["b"] }),
      makeNodeConfig({ id: "b", dependencies: ["a"] }),
    ]
    expect(detectCycle(nodes)).toBe(true)
  })

  it("returns true for indirect cycle", () => {
    const nodes = [
      makeNodeConfig({ id: "a", dependencies: ["c"] }),
      makeNodeConfig({ id: "b", dependencies: ["a"] }),
      makeNodeConfig({ id: "c", dependencies: ["b"] }),
    ]
    expect(detectCycle(nodes)).toBe(true)
  })

  it("returns false for empty graph", () => {
    expect(detectCycle([])).toBe(false)
  })

  it("returns false for independent nodes", () => {
    const nodes = [
      makeNodeConfig({ id: "a" }),
      makeNodeConfig({ id: "b" }),
    ]
    expect(detectCycle(nodes)).toBe(false)
  })
})

// ============================================================================
// 6. findPendingDescendants
// ============================================================================

describe("findPendingDescendants", () => {
  it("returns pending downstream nodes", () => {
    const nodes = [
      makeNodeSession({ node_id: "a", status: "failed", dependencies: [] }),
      makeNodeSession({ node_id: "b", status: "pending", dependencies: ["a"] }),
      makeNodeSession({ node_id: "c", status: "pending", dependencies: ["b"] }),
    ]
    const result = findPendingDescendants(nodes, "a")
    const ids = result.map(n => n.node_id).sort()
    expect(ids).toEqual(["b", "c"])
  })

  it("skips non-pending downstream nodes", () => {
    const nodes = [
      makeNodeSession({ node_id: "a", status: "failed", dependencies: [] }),
      makeNodeSession({ node_id: "b", status: "completed", dependencies: ["a"] }),
      makeNodeSession({ node_id: "c", status: "pending", dependencies: ["b"] }),
    ]
    // b is completed, so BFS stops — c is not reachable through pending nodes
    const result = findPendingDescendants(nodes, "a")
    expect(result).toEqual([])
  })

  it("returns empty for leaf node (no dependents)", () => {
    const nodes = [
      makeNodeSession({ node_id: "a", status: "failed", dependencies: [] }),
    ]
    expect(findPendingDescendants(nodes, "a")).toEqual([])
  })
})

// ============================================================================
// 7. validateReplanPreconditions
// ============================================================================

describe("validateReplanPreconditions", () => {
  it("rejects terminal workflow", () => {
    const r = validateReplanPreconditions(
      { status: "completed" },
      { workflow_id: "wf", add_nodes: [makeNodeConfig({ id: "x" })] },
    )
    expect(r.ok).toBe(false)
  })

  it("rejects empty patch", () => {
    const r = validateReplanPreconditions(
      { status: "running" },
      { workflow_id: "wf" },
    )
    expect(r.ok).toBe(false)
  })

  it("accepts valid running workflow with non-empty patch", () => {
    const r = validateReplanPreconditions(
      { status: "running" },
      { workflow_id: "wf", add_nodes: [makeNodeConfig({ id: "x" })] },
    )
    expect(r.ok).toBe(true)
  })
})

// ============================================================================
// 8. classifyReplanNodes
// ============================================================================

describe("classifyReplanNodes", () => {
  it("partitions nodes into frozen and mutable", () => {
    const nodes = [
      makeNodeSession({ node_id: "a", status: "completed" }),
      makeNodeSession({ node_id: "b", status: "running" }),
      makeNodeSession({ node_id: "c", status: "pending" }),
      makeNodeSession({ node_id: "d", status: "failed" }),
    ]
    const { frozen, mutable, frozenIds } = classifyReplanNodes(nodes)
    expect(frozen.length).toBe(3)
    expect(mutable.length).toBe(1)
    expect(mutable[0].node_id).toBe("c")
    expect(frozenIds.has("a")).toBe(true)
    expect(frozenIds.has("b")).toBe(true)
    expect(frozenIds.has("d")).toBe(true)
    expect(frozenIds.has("c")).toBe(false)
  })
})

// ============================================================================
// 9. validateFrozenAndExistence
// ============================================================================

describe("validateFrozenAndExistence", () => {
  const frozenIds = new Set(["a", "b"])
  const currentNodeIds = new Set(["a", "b", "c"])

  it("rejects removal of frozen nodes", () => {
    const r = validateFrozenAndExistence(
      { workflow_id: "wf", remove_nodes: ["a"] },
      frozenIds,
      currentNodeIds,
    )
    expect(r.ok).toBe(false)
  })

  it("rejects update of frozen nodes", () => {
    const r = validateFrozenAndExistence(
      { workflow_id: "wf", update_nodes: [{ node_id: "b" }] },
      frozenIds,
      currentNodeIds,
    )
    expect(r.ok).toBe(false)
  })

  it("rejects removal of unknown nodes", () => {
    const r = validateFrozenAndExistence(
      { workflow_id: "wf", remove_nodes: ["z"] },
      frozenIds,
      currentNodeIds,
    )
    expect(r.ok).toBe(false)
  })

  it("accepts valid patch targeting mutable existing nodes", () => {
    const r = validateFrozenAndExistence(
      { workflow_id: "wf", remove_nodes: ["c"] },
      frozenIds,
      currentNodeIds,
    )
    expect(r.ok).toBe(true)
  })
})

// ============================================================================
// 10. applyReplanPatchToConfig
// ============================================================================

describe("applyReplanPatchToConfig", () => {
  it("removes nodes by config ID (reverse namespace lookup)", () => {
    const cfgNodes = [
      makeNodeConfig({ id: "a" }),
      makeNodeConfig({ id: "b" }),
    ]
    const r = applyReplanPatchToConfig("wf", cfgNodes, {
      workflow_id: "wf",
      remove_nodes: ["wf::a"],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.newConfigNodes.length).toBe(1)
      expect(r.newConfigNodes[0].id).toBe("b")
    }
  })

  it("applies update patches", () => {
    const cfgNodes = [makeNodeConfig({ id: "a", name: "old" })]
    const r = applyReplanPatchToConfig("wf", cfgNodes, {
      workflow_id: "wf",
      update_nodes: [{ node_id: "wf::a", new_config: { name: "new" } }],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.newConfigNodes[0].name).toBe("new")
    }
  })

  it("appends added nodes", () => {
    const cfgNodes = [makeNodeConfig({ id: "a" })]
    const r = applyReplanPatchToConfig("wf", cfgNodes, {
      workflow_id: "wf",
      add_nodes: [makeNodeConfig({ id: "b" })],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.newConfigNodes.length).toBe(2)
      expect(r.newConfigNodes[1].id).toBe("b")
    }
  })
})

// ============================================================================
// 11. buildReplanDbInputs
// ============================================================================

describe("buildReplanDbInputs", () => {
  it("produces correct DB inputs for a mixed patch", () => {
    const cfgNodes = [
      makeNodeConfig({ id: "a" }),
      makeNodeConfig({ id: "b", dependencies: ["a"] }),
    ]
    const currentNodes = [
      makeNodeSession({ node_id: "wf::a", status: "pending", dependencies: [] }),
      makeNodeSession({ node_id: "wf::b", status: "pending", dependencies: ["wf::a"] }),
    ]
    const patch: ReplanPatch = {
      workflow_id: "wf",
      add_nodes: [makeNodeConfig({ id: "c", dependencies: ["a"] })],
      remove_nodes: ["wf::b"],
      new_max_concurrency: 5,
    }
    const result = buildReplanDbInputs("wf", patch, cfgNodes, currentNodes, 3)
    expect(result.removeNodeIds).toEqual(["wf::b"])
    expect(result.newNodes.length).toBe(1)
    expect(result.newNodes[0].nodeId).toBe("wf::c")
    expect(result.newMaxConcurrency).toBe(5)
  })

  it("namespaces new node dependencies", () => {
    const cfgNodes = [makeNodeConfig({ id: "a" })]
    const patch: ReplanPatch = {
      workflow_id: "wf",
      add_nodes: [makeNodeConfig({ id: "b", dependencies: ["a"] })],
    }
    const result = buildReplanDbInputs("wf", patch, cfgNodes, [], 3)
    expect(result.newNodes[0].dependencyNodes).toEqual(["wf::a"])
  })

  it("falls back to current max concurrency when patch omits it", () => {
    const patch: ReplanPatch = { workflow_id: "wf", add_nodes: [makeNodeConfig({ id: "x" })] }
    const result = buildReplanDbInputs("wf", patch, [], [], 7)
    expect(result.newMaxConcurrency).toBe(7)
  })
})

// ============================================================================
// 12. getValidNextSessionWorkflowStatuses
// ============================================================================

describe("getValidNextSessionWorkflowStatuses", () => {
  it("pending → running, failed, cancelled", () => {
    const valid = getValidNextSessionWorkflowStatuses("pending")
    expect(valid).toEqual(["running", "failed", "cancelled"])
  })

  it("running → completed, failed, cancelled, paused", () => {
    const valid = getValidNextSessionWorkflowStatuses("running")
    expect(valid).toEqual(["completed", "failed", "cancelled", "paused"])
  })

  it("paused → running, cancelled", () => {
    const valid = getValidNextSessionWorkflowStatuses("paused")
    expect(valid).toEqual(["running", "cancelled"])
  })

  it("terminal states return empty", () => {
    expect(getValidNextSessionWorkflowStatuses("completed")).toEqual([])
    expect(getValidNextSessionWorkflowStatuses("failed")).toEqual([])
    expect(getValidNextSessionWorkflowStatuses("cancelled")).toEqual([])
  })
})

// ============================================================================
// 13. getValidNextSessionNodeStatuses
// ============================================================================

describe("getValidNextSessionNodeStatuses", () => {
  it("pending → queued, running, skipped", () => {
    expect(getValidNextSessionNodeStatuses("pending")).toEqual(["queued", "running", "skipped"])
  })

  it("queued → running, skipped", () => {
    expect(getValidNextSessionNodeStatuses("queued")).toEqual(["running", "skipped"])
  })

  it("running → completed, failed, pending, recoverable", () => {
    expect(getValidNextSessionNodeStatuses("running")).toEqual(["completed", "failed", "pending", "recoverable"])
  })

  it("terminal states return empty", () => {
    expect(getValidNextSessionNodeStatuses("completed")).toEqual([])
    expect(getValidNextSessionNodeStatuses("failed")).toEqual([])
    expect(getValidNextSessionNodeStatuses("skipped")).toEqual([])
  })
})
