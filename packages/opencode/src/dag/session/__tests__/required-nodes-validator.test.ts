// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

import { describe, test, expect, beforeEach } from "bun:test"
import { RequiredNodesValidator } from "../required-nodes-validator"
import type { DAGConfig, DAGNodeConfig } from "../types"

// Helper to create a complete node config
function createNode(
  id: string,
  required: boolean,
  dependencies: string[] = []
): DAGNodeConfig {
  return {
    id,
    name: `Node ${id}`,
    required,
    dependencies,
    worker_type: "llm",
    worker_config: {},
  }
}

// Helper to create a complete config
function createConfig(nodes: DAGNodeConfig[]): DAGConfig {
  return {
    name: "test-workflow",
    max_concurrency: 3,
    nodes,
  }
}

describe("RequiredNodesValidator", () => {
  let validator: RequiredNodesValidator

  beforeEach(() => {
    validator = new RequiredNodesValidator()
  })

  describe("validate", () => {
    test("should pass for config with no required nodes", () => {
      const config = createConfig([
        createNode("node1", false),
        createNode("node2", false),
      ])

      const result = validator.validate(config)
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    test("should pass for config with valid required nodes", () => {
      const config = createConfig([
        createNode("node1", true),
        createNode("node2", false),
        createNode("node3", true),
      ])

      const result = validator.validate(config)
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    test("should fail if required nodes form a cycle", () => {
      const config = createConfig([
        createNode("node1", true, ["node2"]),
        createNode("node2", true, ["node3"]),
        createNode("node3", true, ["node1"]), // cycle
      ])

      const result = validator.validate(config)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.toLowerCase().includes("cycle"))).toBe(true)
    })

    test("should pass for optional nodes with cycles", () => {
      const config = createConfig([
        createNode("node1", true),
        createNode("node2", false, ["node3"]),
        createNode("node3", false, ["node2"]), // cycle in optional
      ])

      const result = validator.validate(config)
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    test("should warn if all nodes are required", () => {
      const config = createConfig([
        createNode("node1", true),
        createNode("node2", true),
        createNode("node3", true),
      ])

      const result = validator.validate(config)
      expect(result.valid).toBe(true)
      expect(result.warnings.length).toBeGreaterThan(0)
      expect(result.warnings.some(w => w.toLowerCase().includes("all"))).toBe(true)
    })

    test("should handle linear dependency chain", () => {
      const config = createConfig([
        createNode("node1", true),
        createNode("node2", true, ["node1"]),
        createNode("node3", true, ["node2"]),
      ])

      const result = validator.validate(config)
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    test("should handle empty config", () => {
      const config = createConfig([])

      const result = validator.validate(config)
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })
  })

  describe("buildRequiredGraph", () => {
    test("should build graph with only required nodes", () => {
      const config = createConfig([
        createNode("node1", true),
        createNode("node2", false, ["node1"]),
        createNode("node3", true, ["node1", "node2"]),
      ])

      const graph = (validator as any).buildRequiredGraph(config)
      
      expect(graph.has("node1")).toBe(true)
      expect(graph.has("node2")).toBe(false) // optional, excluded
      expect(graph.has("node3")).toBe(true)
      expect(graph.get("node3")).toEqual(["node1"]) // node2 excluded from dependencies
    })

    test("should handle nodes without dependencies", () => {
      const config = createConfig([
        createNode("node1", true),
        createNode("node2", true),
      ])

      const graph = (validator as any).buildRequiredGraph(config)
      
      expect(graph.get("node1")).toEqual([])
      expect(graph.get("node2")).toEqual([])
    })
  })

  describe("hasCycle", () => {
    test("should detect simple cycle", () => {
      const graph = new Map([
        ["a", ["b"]],
        ["b", ["c"]],
        ["c", ["a"]],
      ])

      expect((validator as any).hasCycle(graph)).toBe(true)
    })

    test("should detect self-cycle", () => {
      const graph = new Map([
        ["a", ["a"]],
      ])

      expect((validator as any).hasCycle(graph)).toBe(true)
    })

    test("should return false for acyclic graph", () => {
      const graph = new Map([
        ["a", ["b"]],
        ["b", ["c"]],
        ["c", []],
      ])

      expect((validator as any).hasCycle(graph)).toBe(false)
    })

    test("should handle disconnected components", () => {
      const graph = new Map([
        ["a", ["b"]],
        ["b", []],
        ["c", ["d"]],
        ["d", []],
      ])

      expect((validator as any).hasCycle(graph)).toBe(false)
    })

    test("should detect cycle in one component", () => {
      const graph = new Map([
        ["a", ["b"]],
        ["b", []],
        ["c", ["d"]],
        ["d", ["c"]], // cycle in second component
      ])

      expect((validator as any).hasCycle(graph)).toBe(true)
    })

    test("should handle empty graph", () => {
      const graph = new Map()
      expect((validator as any).hasCycle(graph)).toBe(false)
    })

    test("should handle diamond pattern without cycle", () => {
      const graph = new Map([
        ["a", ["b", "c"]],
        ["b", ["d"]],
        ["c", ["d"]],
        ["d", []],
      ])

      expect((validator as any).hasCycle(graph)).toBe(false)
    })
  })
})
