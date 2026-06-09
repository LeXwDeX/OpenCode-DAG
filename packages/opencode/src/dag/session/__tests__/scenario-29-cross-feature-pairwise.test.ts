// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * Scenario 29: Cross-feature pairwise integration tests (§8 of 009-dag-capability-expansion.md)
 *
 * Validates pairwise combinations beyond recovery:
 * - X4: B×C — Condition + Data Flow
 * - X5: B×D — Condition + Sub-DAG
 * - X6: C×D — Data Flow + Sub-DAG
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

describe("scenario-29: cross-feature pairwise combinations (§8)", () => {
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
  // X4: B×C — Condition + Data Flow
  // ==========================================================================

  describe("X4: Condition + Data Flow", () => {
    it("4a: condition-true node proceeds → its input_mapping resolves correctly", () => {
      const service = Effect.runSync(DAGSessionService.make)

      // Topology: A(completed, output={answer:42}) → B(pending, condition=exists, input_mapping)
      const nodeConfigs = [
        makeNodeConfig("A", []),
        makeNodeConfig("B", ["A"], {
          condition: { ref_node: "A", op: "exists" },
          input_mapping: { data: { ref_node: "A", ref_path: "answer" } },
        }),
      ]
      const { workflowId: wid } = setupWorkflow(service, "x4a-cond-true-data", nodeConfigs)

      // Complete A with structured output
      Effect.runSync(service.updateWorkflowStatus(wid, "running"))
      Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
      Effect.runSync(service.updateNodeStatus({
        sessionId: `${wid}::A`,
        status: "completed",
        outputData: { answer: 42 },
      }))

      // Build output map from DB state
      const allNodes = Effect.runSync(service.listNodes(wid))
      const outputMap = buildOutputMap(allNodes)

      // Verify condition: exists check on A's output (truthy object) → TRUE
      const readyNodes = allNodes.filter((n) => n.status === "pending")
      const { executeList, skipCandidates } = splitByCondition(readyNodes, outputMap)
      expect(executeList).toHaveLength(1)
      expect(executeList[0].config.id).toBe("B")
      expect(skipCandidates).toHaveLength(0)

      // Verify data flow: input_mapping resolves data=42
      const bNode = executeList[0]
      const collected = collectInputMapping(bNode.config.input_mapping, outputMap, bNode.config.dependencies)
      expect(collected["data"]).toBeDefined()
      expect(collected["data"].value).toBe(42)
      expect(collected["data"].__missing).toBeUndefined()

      // Verify injection block
      const injection = injectCollectedDataToPrompt(collected)
      expect(injection.injected).toBe(true)
      const block = injection.injectionBlock.join("\n")
      expect(block).toContain("=== Collected Input Data ===")
      expect(block).toContain("[data]:")
      expect(block).toContain("42")
      expect(block).toContain("=== End Collected Data ===")
    })

    it("4b: condition-false → node skipped → input_mapping irrelevant", () => {
      const service = Effect.runSync(DAGSessionService.make)

      // Topology: A(completed, output="skip") → B(pending, condition: eq "execute", input_mapping)
      const nodeConfigs = [
        makeNodeConfig("A", []),
        makeNodeConfig("B", ["A"], {
          condition: { ref_node: "A", op: "eq", value: "execute" },
          input_mapping: { stuff: { ref_node: "A" } },
        }),
      ]
      const { workflowId: wid } = setupWorkflow(service, "x4b-cond-false", nodeConfigs)

      Effect.runSync(service.updateWorkflowStatus(wid, "running"))
      Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
      Effect.runSync(service.updateNodeStatus({
        sessionId: `${wid}::A`,
        status: "completed",
        outputData: "skip",
      }))

      // Build output map and evaluate condition
      const allNodes = Effect.runSync(service.listNodes(wid))
      const outputMap = buildOutputMap(allNodes)

      const readyNodes = allNodes.filter((n) => n.status === "pending")
      const { executeList, skipCandidates } = splitByCondition(readyNodes, outputMap)

      // B goes to skipCandidates (condition false: "skip" !== "execute")
      expect(executeList).toHaveLength(0)
      expect(skipCandidates).toHaveLength(1)
      expect(skipCandidates[0].config.id).toBe("B")
    })

    it("4c: condition evaluation and data flow both reference same upstream output", () => {
      const service = Effect.runSync(DAGSessionService.make)

      // Topology: A(completed, output={mode:"active", payload:"secret"}) → B(condition+input_mapping)
      const nodeConfigs = [
        makeNodeConfig("A", []),
        makeNodeConfig("B", ["A"], {
          condition: { ref_node: "A", op: "exists" },
          input_mapping: {
            mode_val: { ref_node: "A", ref_path: "mode" },
            full_payload: { ref_node: "A", ref_path: "payload" },
          },
        }),
      ]
      const { workflowId: wid } = setupWorkflow(service, "x4c-same-source", nodeConfigs)

      Effect.runSync(service.updateWorkflowStatus(wid, "running"))
      Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
      Effect.runSync(service.updateNodeStatus({
        sessionId: `${wid}::A`,
        status: "completed",
        outputData: { mode: "active", payload: "secret" },
      }))

      const allNodes = Effect.runSync(service.listNodes(wid))
      const outputMap = buildOutputMap(allNodes)

      // Condition: exists on A → TRUE (output is truthy object)
      const readyNodes = allNodes.filter((n) => n.status === "pending")
      const { executeList, skipCandidates } = splitByCondition(readyNodes, outputMap)
      expect(executeList).toHaveLength(1)
      expect(skipCandidates).toHaveLength(0)

      // Data flow: both paths resolve from same output
      const bNode = executeList[0]
      const collected = collectInputMapping(bNode.config.input_mapping, outputMap, bNode.config.dependencies)
      expect(collected["mode_val"].value).toBe("active")
      expect(collected["mode_val"].__missing).toBeUndefined()
      expect(collected["full_payload"].value).toBe("secret")
      expect(collected["full_payload"].__missing).toBeUndefined()

      // Injection produces block with both entries
      const injection = injectCollectedDataToPrompt(collected)
      expect(injection.injected).toBe(true)
      const block = injection.injectionBlock.join("\n")
      expect(block).toContain("[mode_val]:")
      expect(block).toContain('"active"')
      expect(block).toContain("[full_payload]:")
      expect(block).toContain('"secret"')
    })
  })

  // ==========================================================================
  // X5: B×D — Condition + Sub-DAG
  // ==========================================================================

  describe("X5: Condition + Sub-DAG", () => {
    it("5a: sub-DAG node condition false → skipped, sub-graph never starts", () => {
      const service = Effect.runSync(DAGSessionService.make)

      const subDagConfig: DAGConfig = {
        name: "child-workflow-5a",
        nodes: [
          {
            id: "child-1",
            name: "child-1",
            dependencies: [],
            required: true,
            worker_type: "general",
            worker_config: { prompt: "child task" },
          },
        ],
        max_concurrency: 2,
      }

      // Topology: A(completed, output="no") → B(pending, worker_type=dag, condition eq "yes")
      const nodeConfigs = [
        makeNodeConfig("A", []),
        makeNodeConfig("B", ["A"], {
          condition: { ref_node: "A", op: "eq", value: "yes" },
          worker_type: "dag",
          worker_config: { subDagConfig },
        }),
      ]
      const { workflowId: wid } = setupWorkflow(service, "x5a-subdag-skip", nodeConfigs)

      Effect.runSync(service.updateWorkflowStatus(wid, "running"))
      Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
      Effect.runSync(service.updateNodeStatus({
        sessionId: `${wid}::A`,
        status: "completed",
        outputData: "no",
      }))

      // Condition evaluation: "no" !== "yes" → B in skipCandidates
      const allNodes = Effect.runSync(service.listNodes(wid))
      const outputMap = buildOutputMap(allNodes)
      const readyNodes = allNodes.filter((n) => n.status === "pending")
      const { executeList, skipCandidates } = splitByCondition(readyNodes, outputMap)

      expect(executeList).toHaveLength(0)
      expect(skipCandidates).toHaveLength(1)
      expect(skipCandidates[0].config.id).toBe("B")
      expect(skipCandidates[0].config.worker_type).toBe("dag")

      // Verify no child workflows spawned (only the parent workflow exists)
      const allWorkflows = Effect.runSync(service.listAllWorkflows())
      expect(allWorkflows).toHaveLength(1)
      expect(allWorkflows[0].id).toBe(wid)
    })

    it("5b: sub-DAG node condition true → in executeList with config intact", () => {
      const service = Effect.runSync(DAGSessionService.make)

      const subDagConfig: DAGConfig = {
        name: "child-workflow-5b",
        nodes: [
          {
            id: "child-1",
            name: "child-1",
            dependencies: [],
            required: true,
            worker_type: "general",
            worker_config: { prompt: "child task" },
          },
          {
            id: "child-2",
            name: "child-2",
            dependencies: ["child-1"],
            required: false,
            worker_type: "verify",
            worker_config: { prompt: "verify child" },
          },
        ],
        max_concurrency: 3,
      }

      // Topology: A(completed, output="yes") → B(pending, worker_type=dag, condition eq "yes")
      const nodeConfigs = [
        makeNodeConfig("A", []),
        makeNodeConfig("B", ["A"], {
          condition: { ref_node: "A", op: "eq", value: "yes" },
          worker_type: "dag",
          worker_config: { subDagConfig },
        }),
      ]
      const { workflowId: wid } = setupWorkflow(service, "x5b-subdag-proceed", nodeConfigs)

      Effect.runSync(service.updateWorkflowStatus(wid, "running"))
      Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
      Effect.runSync(service.updateNodeStatus({
        sessionId: `${wid}::A`,
        status: "completed",
        outputData: "yes",
      }))

      // Condition evaluation: "yes" === "yes" → B in executeList
      const allNodes = Effect.runSync(service.listNodes(wid))
      const outputMap = buildOutputMap(allNodes)
      const readyNodes = allNodes.filter((n) => n.status === "pending")
      const { executeList, skipCandidates } = splitByCondition(readyNodes, outputMap)

      expect(executeList).toHaveLength(1)
      expect(skipCandidates).toHaveLength(0)

      // Config integrity: worker_type and subDagConfig preserved
      const bNode = executeList[0]
      expect(bNode.config.id).toBe("B")
      expect(bNode.config.worker_type).toBe("dag")
      expect(bNode.config.worker_config.subDagConfig).toBeDefined()

      const recoveredSubDag = bNode.config.worker_config.subDagConfig as DAGConfig
      expect(recoveredSubDag.name).toBe("child-workflow-5b")
      expect(recoveredSubDag.nodes).toHaveLength(2)
      expect(recoveredSubDag.nodes[0].id).toBe("child-1")
      expect(recoveredSubDag.nodes[1].id).toBe("child-2")
      expect(recoveredSubDag.nodes[1].dependencies).toEqual(["child-1"])
      expect(recoveredSubDag.max_concurrency).toBe(3)
    })
  })

  // ==========================================================================
  // X6: C×D — Data Flow + Sub-DAG
  // ==========================================================================

  describe("X6: Data Flow + Sub-DAG", () => {
    it("6a: sub-DAG node with input_mapping → parent data resolves into injection block", () => {
      const service = Effect.runSync(DAGSessionService.make)

      const subDagConfig: DAGConfig = {
        name: "child-workflow-6a",
        nodes: [
          {
            id: "child-1",
            name: "child-1",
            dependencies: [],
            required: true,
            worker_type: "general",
            worker_config: { prompt: "child task using parent context" },
          },
        ],
        max_concurrency: 1,
      }

      // Topology: A(completed, output={context:"important-data", version:3}) → B(dag, input_mapping)
      const nodeConfigs = [
        makeNodeConfig("A", []),
        makeNodeConfig("B", ["A"], {
          worker_type: "dag",
          worker_config: { subDagConfig },
          input_mapping: { parent_ctx: { ref_node: "A", ref_path: "context" } },
        }),
      ]
      const { workflowId: wid } = setupWorkflow(service, "x6a-subdag-data", nodeConfigs)

      Effect.runSync(service.updateWorkflowStatus(wid, "running"))
      Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
      Effect.runSync(service.updateNodeStatus({
        sessionId: `${wid}::A`,
        status: "completed",
        outputData: { context: "important-data", version: 3 },
      }))

      // Data flow chain
      const allNodes = Effect.runSync(service.listNodes(wid))
      const outputMap = buildOutputMap(allNodes)
      const bNode = allNodes.find((n) => n.config.id === "B")!

      const collected = collectInputMapping(bNode.config.input_mapping, outputMap, bNode.config.dependencies)
      expect(collected["parent_ctx"]).toBeDefined()
      expect(collected["parent_ctx"].value).toBe("important-data")
      expect(collected["parent_ctx"].__missing).toBeUndefined()

      // Injection produces block containing parent_ctx
      const injection = injectCollectedDataToPrompt(collected)
      expect(injection.injected).toBe(true)
      const block = injection.injectionBlock.join("\n")
      expect(block).toContain("[parent_ctx]:")
      expect(block).toContain('"important-data"')

      // Verify sub-DAG config is still intact on the node
      expect(bNode.config.worker_type).toBe("dag")
      expect(bNode.config.worker_config.subDagConfig).toBeDefined()
      expect((bNode.config.worker_config.subDagConfig as DAGConfig).name).toBe("child-workflow-6a")
    })

    it("6b: sub-DAG node with multiple input_mapping entries from different upstream nodes", () => {
      const service = Effect.runSync(DAGSessionService.make)

      const subDagConfig: DAGConfig = {
        name: "child-workflow-6b",
        nodes: [
          {
            id: "child-1",
            name: "child-1",
            dependencies: [],
            required: true,
            worker_type: "general",
            worker_config: { prompt: "synthesize inputs" },
          },
        ],
        max_concurrency: 1,
      }

      // Topology: A(completed) + B(completed) → C(dag, input_mapping from both A and B)
      const nodeConfigs = [
        makeNodeConfig("A", []),
        makeNodeConfig("B", []),
        makeNodeConfig("C", ["A", "B"], {
          worker_type: "dag",
          worker_config: { subDagConfig },
          input_mapping: {
            from_a: { ref_node: "A", ref_path: "result" },
            from_b: { ref_node: "B", ref_path: "result" },
          },
        }),
      ]
      const { workflowId: wid } = setupWorkflow(service, "x6b-multi-input", nodeConfigs)

      Effect.runSync(service.updateWorkflowStatus(wid, "running"))
      // Complete A
      Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
      Effect.runSync(service.updateNodeStatus({
        sessionId: `${wid}::A`,
        status: "completed",
        outputData: { result: "alpha" },
      }))
      // Complete B
      Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::B`, status: "running" }))
      Effect.runSync(service.updateNodeStatus({
        sessionId: `${wid}::B`,
        status: "completed",
        outputData: { result: "beta" },
      }))

      // Data flow chain from multiple upstream
      const allNodes = Effect.runSync(service.listNodes(wid))
      const outputMap = buildOutputMap(allNodes)
      const cNode = allNodes.find((n) => n.config.id === "C")!

      const collected = collectInputMapping(cNode.config.input_mapping, outputMap, cNode.config.dependencies)
      expect(collected["from_a"]).toBeDefined()
      expect(collected["from_a"].value).toBe("alpha")
      expect(collected["from_a"].__missing).toBeUndefined()
      expect(collected["from_b"]).toBeDefined()
      expect(collected["from_b"].value).toBe("beta")
      expect(collected["from_b"].__missing).toBeUndefined()

      // Injection block contains both entries
      const injection = injectCollectedDataToPrompt(collected)
      expect(injection.injected).toBe(true)
      const block = injection.injectionBlock.join("\n")
      expect(block).toContain("[from_a]:")
      expect(block).toContain('"alpha"')
      expect(block).toContain("[from_b]:")
      expect(block).toContain('"beta"')

      // Audit: both entries injected
      expect(injection.audit).toHaveLength(2)
      const auditKeys = injection.audit.map((a) => a.inputKey)
      expect(auditKeys).toContain("from_a")
      expect(auditKeys).toContain("from_b")
      expect(injection.audit.every((a) => a.status === "injected")).toBe(true)

      // Sub-DAG config intact
      expect(cNode.config.worker_type).toBe("dag")
      expect((cNode.config.worker_config.subDagConfig as DAGConfig).name).toBe("child-workflow-6b")
    })
  })
})
