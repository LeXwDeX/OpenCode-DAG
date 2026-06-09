// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * Scenario 30: Cross-feature triple-combination integration tests (§8 of 009-dag-capability-expansion.md)
 *
 * Validates the X7 triple combination: B×C×D — Condition + Data Flow + Sub-DAG
 * all interacting on the same node(s).
 *
 * - 7a: Full pipeline happy path (condition-true → data collection → sub-DAG config intact)
 * - 7b: Condition-false short-circuits (data collection + sub-DAG never execute)
 * - 7c: Multi-node DAG with mixed features across different nodes (A→B→C chain)
 * - 7d: Condition on upstream sub-DAG node's output (cross-level dependency)
 *
 * Infrastructure:
 * - Flag.OPENCODE_DB = ":memory:" enables in-memory SQLite
 * - Database.Client.reset() forces re-initialization
 * - DAGSessionService.make runs via Effect.runSync
 * - Pure function modules (condition-eval, input-mapping-collector, prompt-inject) tested directly
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Database from "@/storage/db"
import { DAGSessionService } from "../session-service"
import { buildOutputMap, splitByCondition } from "../condition-eval"
import { collectInputMapping } from "../input-mapping-collector"
import { injectCollectedDataToPrompt } from "../prompt-inject"
import type { DAGConfig, DAGNodeConfig, DAGNodeCondition } from "../types"

// ============================================================================
// Helpers
// ============================================================================

function makeNodeConfig(
  id: string,
  deps: string[],
  opts?: {
    required?: boolean
    condition?: DAGNodeCondition
    input_mapping?: DAGNodeConfig["input_mapping"]
    worker_type?: string
    worker_config?: Record<string, unknown>
  },
): DAGNodeConfig {
  return {
    id,
    name: id,
    dependencies: deps,
    required: opts?.required ?? false,
    worker_type: opts?.worker_type ?? "general",
    worker_config: opts?.worker_config ?? { prompt: `Do task ${id}` },
    condition: opts?.condition,
    input_mapping: opts?.input_mapping,
  }
}

function setupWorkflow(
  service: {
    readonly createWorkflow: (input: {
      name: string
      chatSessionId: string
      config: DAGConfig
      metadata?: Record<string, unknown>
    }) => Effect.Effect<import("../types").DAGWorkflowSession, unknown>
    readonly createNode: (input: {
      workflowId: string
      nodeId?: string
      name: string
      nodeName: string
      nodeType: string
      config: DAGNodeConfig
      dependencyNodes?: string[]
      timeoutMs?: number
      maxRetries?: number
    }) => Effect.Effect<import("../types").DAGNodeSession>
  },
  name: string,
  nodeConfigs: DAGNodeConfig[],
  maxConcurrency: number = 5,
): { workflowId: string } {
  const config: DAGConfig = {
    name,
    nodes: nodeConfigs,
    max_concurrency: maxConcurrency,
  }
  const workflow = Effect.runSync(
    service.createWorkflow({
      name,
      chatSessionId: `test-session-${name}`,
      config,
    }),
  )
  for (const cfg of nodeConfigs) {
    Effect.runSync(
      service.createNode({
        workflowId: workflow.id,
        nodeId: `${workflow.id}::${cfg.id}`,
        name: cfg.name,
        nodeName: cfg.name,
        nodeType: cfg.worker_type,
        config: cfg,
        dependencyNodes: cfg.dependencies.map((d) => `${workflow.id}::${d}`),
        timeoutMs: cfg.timeout_ms,
        maxRetries: cfg.retry?.max_attempts ?? 0,
      }),
    )
  }
  return { workflowId: workflow.id }
}

// ============================================================================
// Tests
// ============================================================================

describe("scenario-30: cross-feature triple combination X7: B×C×D (§8)", () => {
  const originalDb = Flag.OPENCODE_DB

  beforeEach(() => {
    Flag.OPENCODE_DB = ":memory:"
    Database.Client.reset()
  })

  afterEach(() => {
    try { Database.close() } catch { /* ignore */ }
    Flag.OPENCODE_DB = originalDb
    Database.Client.reset()
  })

  // ==========================================================================
  // 7a: Full pipeline — condition-true + data-flow + sub-DAG (happy path)
  // ==========================================================================

  it("7a: condition-true + data-flow + sub-DAG node (happy path)", () => {
    const service = Effect.runSync(DAGSessionService.make)

    const subDagConfig: DAGConfig = {
      name: "child-7a",
      nodes: [
        {
          id: "c1",
          name: "c1",
          dependencies: [],
          required: false,
          worker_type: "general",
          worker_config: {},
        },
      ],
      max_concurrency: 2,
    }

    // ROOT(completed, output={mode:"active", config:{workers:3}})
    // → SUB_DAG(pending, condition=exists, input_mapping, worker_type=dag)
    const nodeConfigs = [
      makeNodeConfig("ROOT", []),
      makeNodeConfig("SUB_DAG", ["ROOT"], {
        condition: { ref_node: "ROOT", op: "exists" },
        input_mapping: {
          parent_mode: { ref_node: "ROOT", ref_path: "mode" },
          parent_config: { ref_node: "ROOT", ref_path: "config" },
        },
        worker_type: "dag",
        worker_config: { subDagConfig },
      }),
    ]
    const { workflowId: wid } = setupWorkflow(service, "x7a-triple-happy", nodeConfigs)

    // Complete ROOT with structured output
    Effect.runSync(service.updateWorkflowStatus(wid, "running"))
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::ROOT`, status: "running" }))
    Effect.runSync(service.updateNodeStatus({
      sessionId: `${wid}::ROOT`,
      status: "completed",
      outputData: { mode: "active", config: { workers: 3 } },
    }))

    // Build output map from DB state
    const allNodes = Effect.runSync(service.listNodes(wid))
    const outputMap = buildOutputMap(allNodes)

    // 1. splitByCondition → SUB_DAG in executeList (condition=exists, ROOT output truthy → TRUE)
    const readyNodes = allNodes.filter((n) => n.status === "pending")
    const { executeList, skipCandidates } = splitByCondition(readyNodes, outputMap)
    expect(executeList).toHaveLength(1)
    expect(executeList[0].config.id).toBe("SUB_DAG")
    expect(skipCandidates).toHaveLength(0)

    // 2. collectInputMapping → parent_mode="active", parent_config={workers:3}
    const subDagNode = executeList[0]
    const collected = collectInputMapping(
      subDagNode.config.input_mapping,
      outputMap,
      subDagNode.config.dependencies,
    )
    expect(collected["parent_mode"]).toBeDefined()
    expect(collected["parent_mode"].value).toBe("active")
    expect(collected["parent_mode"].__missing).toBeUndefined()
    expect(collected["parent_config"]).toBeDefined()
    expect(collected["parent_config"].value).toEqual({ workers: 3 })
    expect(collected["parent_config"].__missing).toBeUndefined()

    // 3. injectCollectedDataToPrompt → block contains both entries
    const injection = injectCollectedDataToPrompt(collected)
    expect(injection.injected).toBe(true)
    const block = injection.injectionBlock.join("\n")
    expect(block).toContain("=== Collected Input Data ===")
    expect(block).toContain("[parent_mode]:")
    expect(block).toContain('"active"')
    expect(block).toContain("[parent_config]:")
    expect(block).toContain('"workers"')
    expect(block).toContain("=== End Collected Data ===")

    // 4. SUB_DAG config integrity: worker_type=dag + subDagConfig intact
    expect(subDagNode.config.worker_type).toBe("dag")
    expect(subDagNode.config.worker_config.subDagConfig).toBeDefined()
    const recoveredSubDag = subDagNode.config.worker_config.subDagConfig as DAGConfig
    expect(recoveredSubDag.name).toBe("child-7a")
    expect(recoveredSubDag.nodes).toHaveLength(1)
    expect(recoveredSubDag.nodes[0].id).toBe("c1")
    expect(recoveredSubDag.max_concurrency).toBe(2)
  })

  // ==========================================================================
  // 7b: Condition-false short-circuits — data collection + sub-DAG never execute
  // ==========================================================================

  it("7b: condition-false short-circuits data collection + sub-DAG dispatch", () => {
    const service = Effect.runSync(DAGSessionService.make)

    const subDagConfig: DAGConfig = {
      name: "child-7b",
      nodes: [
        {
          id: "c1",
          name: "c1",
          dependencies: [],
          required: false,
          worker_type: "general",
          worker_config: {},
        },
      ],
      max_concurrency: 1,
    }

    // ROOT(completed, output="inactive")
    // → SUB_DAG(pending, condition: eq "active" → FALSE, input_mapping, worker_type=dag)
    const nodeConfigs = [
      makeNodeConfig("ROOT", []),
      makeNodeConfig("SUB_DAG", ["ROOT"], {
        condition: { ref_node: "ROOT", op: "eq", value: "active" },
        input_mapping: { data: { ref_node: "ROOT" } },
        worker_type: "dag",
        worker_config: { subDagConfig },
      }),
    ]
    const { workflowId: wid } = setupWorkflow(service, "x7b-triple-false", nodeConfigs)

    // Complete ROOT with output that does NOT match condition
    Effect.runSync(service.updateWorkflowStatus(wid, "running"))
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::ROOT`, status: "running" }))
    Effect.runSync(service.updateNodeStatus({
      sessionId: `${wid}::ROOT`,
      status: "completed",
      outputData: "inactive",
    }))

    // Build output map
    const allNodes = Effect.runSync(service.listNodes(wid))
    const outputMap = buildOutputMap(allNodes)

    // 1. splitByCondition → SUB_DAG in skipCandidates ("inactive" !== "active")
    const readyNodes = allNodes.filter((n) => n.status === "pending")
    const { executeList, skipCandidates } = splitByCondition(readyNodes, outputMap)
    expect(executeList).toHaveLength(0)
    expect(skipCandidates).toHaveLength(1)
    expect(skipCandidates[0].config.id).toBe("SUB_DAG")

    // 2. Since condition=false, data collection should never run in production
    //    (skip happens before spawn/data-flow in scheduleReadyNodes pipeline).
    //    Verify node is in skipCandidates, not executeList — pipeline would skip.
    expect(skipCandidates[0].config.worker_type).toBe("dag")
    expect(skipCandidates[0].config.input_mapping).toBeDefined()

    // 3. No child workflows spawned (only parent workflow exists)
    const allWorkflows = Effect.runSync(service.listAllWorkflows())
    expect(allWorkflows).toHaveLength(1)
    expect(allWorkflows[0].id).toBe(wid)
  })

  // ==========================================================================
  // 7c: Multi-node DAG with mixed features across different nodes (A→B→C)
  // ==========================================================================

  it("7c: multi-node chain A→B→C with condition + data flow + sub-DAG across nodes", () => {
    const service = Effect.runSync(DAGSessionService.make)

    const subDagConfig: DAGConfig = {
      name: "child-7c",
      nodes: [
        {
          id: "child-1",
          name: "child-1",
          dependencies: [],
          required: false,
          worker_type: "general",
          worker_config: { prompt: "child task" },
        },
      ],
      max_concurrency: 2,
    }

    // A(no deps, completes with output "go")
    // → B(depends on A, condition: eq "go" → TRUE, input_mapping: signal from A)
    //   B completes with output {processed: true, result: "done"}
    // → C(depends on B, condition: exists → TRUE, input_mapping: upstream from B, worker_type=dag)
    const nodeConfigs = [
      makeNodeConfig("A", []),
      makeNodeConfig("B", ["A"], {
        condition: { ref_node: "A", op: "eq", value: "go" },
        input_mapping: { signal: { ref_node: "A" } },
      }),
      makeNodeConfig("C", ["B"], {
        condition: { ref_node: "B", op: "exists" },
        input_mapping: { upstream: { ref_node: "B", ref_path: "result" } },
        worker_type: "dag",
        worker_config: { subDagConfig },
      }),
    ]
    const { workflowId: wid } = setupWorkflow(service, "x7c-triple-chain", nodeConfigs)

    // Complete A with output "go"
    Effect.runSync(service.updateWorkflowStatus(wid, "running"))
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
    Effect.runSync(service.updateNodeStatus({
      sessionId: `${wid}::A`,
      status: "completed",
      outputData: "go",
    }))

    // Complete B with structured output
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::B`, status: "running" }))
    Effect.runSync(service.updateNodeStatus({
      sessionId: `${wid}::B`,
      status: "completed",
      outputData: { processed: true, result: "done" },
    }))

    // Build output map from all completed nodes (A, B)
    const allNodes = Effect.runSync(service.listNodes(wid))
    const outputMap = buildOutputMap(allNodes)

    // Verify output map has both A and B
    expect(outputMap.get("A")).toBe("go")
    expect(outputMap.get("B")).toEqual({ processed: true, result: "done" })

    // 1. splitByCondition on C → executeList (condition: exists on B → TRUE)
    const readyNodes = allNodes.filter((n) => n.status === "pending")
    expect(readyNodes).toHaveLength(1)
    expect(readyNodes[0].config.id).toBe("C")

    const { executeList, skipCandidates } = splitByCondition(readyNodes, outputMap)
    expect(executeList).toHaveLength(1)
    expect(executeList[0].config.id).toBe("C")
    expect(skipCandidates).toHaveLength(0)

    // 2. collectInputMapping for C → upstream="done"
    const cNode = executeList[0]
    const collected = collectInputMapping(
      cNode.config.input_mapping,
      outputMap,
      cNode.config.dependencies,
    )
    expect(collected["upstream"]).toBeDefined()
    expect(collected["upstream"].value).toBe("done")
    expect(collected["upstream"].__missing).toBeUndefined()

    // 3. injectCollectedDataToPrompt → block with upstream:"done"
    const injection = injectCollectedDataToPrompt(collected)
    expect(injection.injected).toBe(true)
    const block = injection.injectionBlock.join("\n")
    expect(block).toContain("[upstream]:")
    expect(block).toContain('"done"')

    // 4. C.worker_type = "dag" + subDagConfig intact
    expect(cNode.config.worker_type).toBe("dag")
    expect(cNode.config.worker_config.subDagConfig).toBeDefined()
    const recoveredSubDag = cNode.config.worker_config.subDagConfig as DAGConfig
    expect(recoveredSubDag.name).toBe("child-7c")
    expect(recoveredSubDag.nodes).toHaveLength(1)
    expect(recoveredSubDag.max_concurrency).toBe(2)
  })

  // ==========================================================================
  // 7d: Condition on upstream sub-DAG node's output (cross-level dependency)
  // ==========================================================================

  it("7d: sub-DAG output feeds into downstream sub-DAG condition + data flow", () => {
    const service = Effect.runSync(DAGSessionService.make)

    const subDagConfigA: DAGConfig = {
      name: "child-a-7d",
      nodes: [
        {
          id: "ca1",
          name: "ca1",
          dependencies: [],
          required: false,
          worker_type: "general",
          worker_config: {},
        },
      ],
      max_concurrency: 1,
    }

    const subDagConfigB: DAGConfig = {
      name: "child-b-7d",
      nodes: [
        {
          id: "cb1",
          name: "cb1",
          dependencies: [],
          required: false,
          worker_type: "general",
          worker_config: {},
        },
      ],
      max_concurrency: 1,
    }

    // A(worker_type=dag, no condition, completes with output {sub_result:"success"})
    // → B(depends on A, condition: exists, input_mapping: sub_data from A.sub_result, worker_type=dag)
    const nodeConfigs = [
      makeNodeConfig("A", [], {
        worker_type: "dag",
        worker_config: { subDagConfig: subDagConfigA },
      }),
      makeNodeConfig("B", ["A"], {
        condition: { ref_node: "A", op: "exists" },
        input_mapping: { sub_data: { ref_node: "A", ref_path: "sub_result" } },
        worker_type: "dag",
        worker_config: { subDagConfig: subDagConfigB },
      }),
    ]
    const { workflowId: wid } = setupWorkflow(service, "x7d-cross-level", nodeConfigs)

    // A is already completed (simulating a sub-DAG node that finished)
    Effect.runSync(service.updateWorkflowStatus(wid, "running"))
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
    Effect.runSync(service.updateNodeStatus({
      sessionId: `${wid}::A`,
      status: "completed",
      outputData: { sub_result: "success" },
    }))

    // Build output map
    const allNodes = Effect.runSync(service.listNodes(wid))
    const outputMap = buildOutputMap(allNodes)

    // 1. A is completed; verify A's output in outputMap
    expect(outputMap.get("A")).toEqual({ sub_result: "success" })

    // 2. B's condition evaluates A's output → exists → TRUE
    const readyNodes = allNodes.filter((n) => n.status === "pending")
    expect(readyNodes).toHaveLength(1)
    const { executeList, skipCandidates } = splitByCondition(readyNodes, outputMap)
    expect(executeList).toHaveLength(1)
    expect(executeList[0].config.id).toBe("B")
    expect(skipCandidates).toHaveLength(0)

    // 3. B's input_mapping collects sub_data="success" from A
    const bNode = executeList[0]
    const collected = collectInputMapping(
      bNode.config.input_mapping,
      outputMap,
      bNode.config.dependencies,
    )
    expect(collected["sub_data"]).toBeDefined()
    expect(collected["sub_data"].value).toBe("success")
    expect(collected["sub_data"].__missing).toBeUndefined()

    // 4. Injection block
    const injection = injectCollectedDataToPrompt(collected)
    expect(injection.injected).toBe(true)
    const block = injection.injectionBlock.join("\n")
    expect(block).toContain("[sub_data]:")
    expect(block).toContain('"success"')

    // 5. Both nodes are worker_type="dag" — proves sub-DAG outputs feed into subsequent sub-DAG
    expect(bNode.config.worker_type).toBe("dag")
    expect(bNode.config.worker_config.subDagConfig).toBeDefined()
    const recoveredSubDagB = bNode.config.worker_config.subDagConfig as DAGConfig
    expect(recoveredSubDagB.name).toBe("child-b-7d")

    // A was also a sub-DAG node
    const aNode = allNodes.find((n) => n.config.id === "A")!
    expect(aNode.config.worker_type).toBe("dag")
    expect(aNode.config.worker_config.subDagConfig).toBeDefined()
    const recoveredSubDagA = aNode.config.worker_config.subDagConfig as DAGConfig
    expect(recoveredSubDagA.name).toBe("child-a-7d")
  })
})
