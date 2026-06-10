// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * @file DAG Probe Tests — behavioral tests (activated 2026-06-10)
 * @description 验证 DAGProbe 4 个诊断方法的真实行为，使用 mock IDAGSessionService。
 *
 * Acceptance:
 * - [x] DAGProbe 可实例化（mock sessionService）
 * - [x] 4 方法 × 2+ 场景 ≥ 8 个行为测试 PASS
 * - [x] IDAGProbe 等类型可被 import（type-level，编译通过即证明）
 */

import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { DAGProbe } from "../dag-probe"
import type {
  IDAGProbe,
  NodeBlockReason,
  TopologyLayer,
  TopologySnapshot,
  ExecutionSnapshot,
  CascadeImpact,
} from "../probe-types"
import type { IDAGSessionService } from "../../session/session-service"
import type {
  DAGNodeSession,
  DAGWorkflowSession,
  DAGNodeConfig,
  DAGViolation,
  DAGNodeStatus,
} from "../../session/types"

// type-level 锚定：若任一类型导出缺失，本文件无法编译，测试套件即失败。
type _ProbeContract = IDAGProbe
type _Reason = NodeBlockReason
type _Layer = TopologyLayer
type _Topology = TopologySnapshot
type _Exec = ExecutionSnapshot
type _Cascade = CascadeImpact

// ============================================================================
// Test Helpers
// ============================================================================

function makeConfig(overrides: Partial<DAGNodeConfig> & { id: string }): DAGNodeConfig {
  return {
    name: overrides.id,
    dependencies: [],
    required: false,
    worker_type: "mock",
    worker_config: {},
    ...overrides,
  }
}

function makeNode(
  overrides: Partial<DAGNodeSession> & { node_id: string; status: DAGNodeStatus },
): DAGNodeSession {
  return {
    workflow_id: "wf-1",
    config: makeConfig({ id: overrides.node_id }),
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

function mockService(fixture: {
  nodes: DAGNodeSession[]
  workflow?: Partial<DAGWorkflowSession>
  violations?: DAGViolation[]
}): IDAGSessionService {
  const configNodes = fixture.nodes.map(n => n.config)
  const workflow: DAGWorkflowSession = {
    id: "wf-1",
    chat_session_id: "cs-1",
    config: {
      name: "test",
      nodes: configNodes,
      max_concurrency: 3,
      ...(fixture.workflow?.config ?? {}),
    } as DAGWorkflowSession["config"],
    status: "running",
    node_sessions: {},
    violations: [],
    metadata: {},
    start_time: Date.now(),
    end_time: null,
    current_node: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    completed_at: null,
    duration_ms: null,
    ...(fixture.workflow ?? {}),
  } as DAGWorkflowSession

  return {
    listNodes: (_wfId: string) => Effect.succeed(fixture.nodes),
    getWorkflow: (_wfId: string) => Effect.succeed(workflow as DAGWorkflowSession | undefined),
    getNode: (nodeId: string) =>
      Effect.succeed(fixture.nodes.find(n => n.node_id === nodeId) as DAGNodeSession | undefined),
    listViolations: (_wfId: string) => Effect.succeed(fixture.violations ?? []),
    incrementRetryCount: (_nodeId: string) => Effect.succeed(undefined),
  } as IDAGSessionService
}

// ============================================================================
// Tests
// ============================================================================

describe("DAGProbe — behavioral tests (active but hidden)", () => {
  test("可实例化（构造注入 sessionService）", () => {
    const probe = new DAGProbe({} as IDAGSessionService)
    expect(probe).toBeInstanceOf(DAGProbe)
  })

  // ── explainBlock ──

  describe("explainBlock", () => {
    test("pending + deps 全满足 → reason='ready'", async () => {
      const nodes = [
        makeNode({ node_id: "a", status: "completed" }),
        makeNode({ node_id: "b", status: "pending", dependencies: ["a"] }),
      ]
      const probe = new DAGProbe(mockService({ nodes }))
      const result = await probe.explainBlock("wf-1")

      expect(result).toHaveLength(1) // only non-terminal nodes
      const bReason = result.find(r => r.nodeId === "b")!
      expect(bReason.blocked).toBe(false)
      expect(bReason.reason).toBe("ready")
      expect(bReason.unsatisfiedDependencies).toEqual([])
    })

    test("pending + 部分 deps 未满足 → reason='deps_unsatisfied' + 含未满足 ID", async () => {
      const nodes = [
        makeNode({ node_id: "a", status: "completed" }),
        makeNode({ node_id: "b", status: "pending", dependencies: [] }),
        makeNode({ node_id: "c", status: "pending", dependencies: ["a", "b"] }),
      ]
      const probe = new DAGProbe(mockService({ nodes }))
      const result = await probe.explainBlock("wf-1")

      const cReason = result.find(r => r.nodeId === "c")!
      expect(cReason.blocked).toBe(true)
      expect(cReason.reason).toBe("deps_unsatisfied")
      expect(cReason.unsatisfiedDependencies).toContain("b")
      expect(cReason.unsatisfiedDependencies).not.toContain("a")
    })
  })

  // ── getTopology ──

  describe("getTopology", () => {
    test("线性 A→B→C → 3 layers, depth=2, hasCycle=false", async () => {
      const nodes = [
        makeNode({ node_id: "A", status: "pending", config: makeConfig({ id: "A", dependencies: [] }) }),
        makeNode({ node_id: "B", status: "pending", dependencies: ["A"], config: makeConfig({ id: "B", dependencies: ["A"] }) }),
        makeNode({ node_id: "C", status: "pending", dependencies: ["B"], config: makeConfig({ id: "C", dependencies: ["B"] }) }),
      ]
      const probe = new DAGProbe(mockService({ nodes }))
      const result = await probe.getTopology("wf-1")

      expect(result.hasCycle).toBe(false)
      expect(result.layers).toHaveLength(3)
      expect(result.layers[0]).toEqual({ depth: 0, nodeIds: ["A"] })
      expect(result.layers[1]).toEqual({ depth: 1, nodeIds: ["B"] })
      expect(result.layers[2]).toEqual({ depth: 2, nodeIds: ["C"] })
      expect(result.totalDepth).toBe(3)
    })

    test("有环图 A→B→A → hasCycle=true", async () => {
      const nodes = [
        makeNode({ node_id: "A", status: "pending", dependencies: ["B"], config: makeConfig({ id: "A", dependencies: ["B"] }) }),
        makeNode({ node_id: "B", status: "pending", dependencies: ["A"], config: makeConfig({ id: "B", dependencies: ["A"] }) }),
      ]
      const probe = new DAGProbe(mockService({ nodes }))
      const result = await probe.getTopology("wf-1")

      expect(result.hasCycle).toBe(true)
    })
  })

  // ── getExecutionSnapshot ──

  describe("getExecutionSnapshot", () => {
    test("max_concurrency=3 + 1 running + 1 ready → spawnBudget=2, ready 含 ready node", async () => {
      const nodes = [
        makeNode({ node_id: "a", status: "running" }),
        makeNode({ node_id: "b", status: "pending" }), // no deps → ready
      ]
      const probe = new DAGProbe(
        mockService({
          nodes,
          workflow: { config: { name: "test", nodes: nodes.map(n => n.config), max_concurrency: 3 } },
        }),
      )
      const result = await probe.getExecutionSnapshot("wf-1")

      expect(result.spawnBudget).toBe(2) // 3 - 1 running - 0 queued
      expect(result.running).toEqual(["a"])
      expect(result.ready).toContain("b")
    })

    test("pending with unsatisfied deps → blocked list 含该节点", async () => {
      const nodes = [
        makeNode({ node_id: "a", status: "pending" }),
        makeNode({ node_id: "b", status: "pending", dependencies: ["a"] }),
      ]
      const probe = new DAGProbe(mockService({ nodes }))
      const result = await probe.getExecutionSnapshot("wf-1")

      expect(result.ready).toContain("a") // no deps → ready
      expect(result.pending).toContain("b") // blocked by dep on a
      expect(result.blocked).toHaveLength(1)
      expect(result.blocked[0].nodeId).toBe("b")
    })
  })

  // ── predictCascade ──

  describe("predictCascade", () => {
    test("单节点 fail → 下游 pending nodes 全收集", async () => {
      const nodes = [
        makeNode({ node_id: "a", status: "failed" }),
        makeNode({ node_id: "b", status: "pending", dependencies: ["a"] }),
        makeNode({ node_id: "c", status: "pending", dependencies: ["b"] }),
      ]
      const probe = new DAGProbe(mockService({ nodes }))
      const result = await probe.predictCascade("wf-1", "a")

      expect(result.originNodeId).toBe("a")
      expect(result.affectedPendingNodeIds.sort()).toEqual(["b", "c"])
    })

    test("无下游 → affectedPendingNodeIds=[]", async () => {
      const nodes = [
        makeNode({ node_id: "a", status: "failed" }),
        makeNode({ node_id: "b", status: "completed" }),
      ]
      const probe = new DAGProbe(mockService({ nodes }))
      const result = await probe.predictCascade("wf-1", "a")

      expect(result.originNodeId).toBe("a")
      expect(result.affectedPendingNodeIds).toEqual([])
    })
  })
})
