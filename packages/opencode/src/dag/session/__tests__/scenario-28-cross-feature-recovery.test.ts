// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * Scenario 28: Cross-feature recovery combinations (§8 of 009-dag-capability-expansion.md)
 *
 * Validates that recovery (Feature A) correctly interacts with:
 * - X1: A×B — Recovery + Conditions (conditional skip after recovery)
 * - X2: A×C — Recovery + Data Flow (persisted output accessible post-recovery)
 * - X3: A×D — Recovery + Sub-DAG (config integrity across recovery reset)
 *
 * Infrastructure:
 * - Flag.OPENCODE_DB = ":memory:" enables in-memory SQLite
 * - Database.Client.reset() forces re-initialization
 * - DAGSessionService.make and WorkflowEngine.make run via Effect.runSync
 * - Mock PromptOps (injected into engine, never actually invoked)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Database from "@/storage/db"
import { DAGSessionService } from "../session-service"
import { WorkflowEngine, unregisterEngine } from "../workflow-engine"
import { recoverOrphanedWorkflows } from "../recovery"
import { buildOutputMap } from "../condition-eval"
import { collectInputMapping } from "../input-mapping-collector"
import { injectCollectedDataToPrompt } from "../prompt-inject"
import type { PromptOps } from "@/session/prompt-ops"
import type { DAGConfig, DAGNodeConfig, DAGNodeCondition, DAGNodeSession, DAGWorkflowSession } from "../types"
import type { MessageV2 } from "@/session/message-v2"
import type { SessionPrompt } from "@/session/prompt"

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
    }) => Effect.Effect<DAGWorkflowSession, unknown>
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
    }) => Effect.Effect<DAGNodeSession>
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

function mockPromptOps(): PromptOps {
  const stubParts = [] as SessionPrompt.PromptInput["parts"]
  const stubWithParts = { messages: [], parts: [] } as unknown as MessageV2.WithParts
  return {
    cancel: () => Effect.void,
    resolvePromptParts: () => Effect.succeed(stubParts),
    prompt: () => Effect.succeed(stubWithParts),
    loop: () => Effect.succeed(stubWithParts),
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("scenario-28: cross-feature recovery combinations (§8)", () => {
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
  // X1: A×B — Recovery + Conditional Skip
  // ==========================================================================

  describe("X1: Recovery + Conditional Skip", () => {
    it("recovery triggers condition evaluation → B skipped (condition false) + C cascade skipped", () => {
      const service = Effect.runSync(DAGSessionService.make)

      // Topology: A(completed) → B(pending, condition: ref_node=A, op=eq, value="execute") → C(pending)
      // All nodes non-required so skipping doesn't fail the workflow.
      const nodeConfigs = [
        makeNodeConfig("A", []),
        makeNodeConfig("B", ["A"], {
          condition: { ref_node: "A", op: "eq", value: "execute" },
        }),
        makeNodeConfig("C", ["B"]),
      ]
      const { workflowId: wid } = setupWorkflow(service, "x1-recovery-cond", nodeConfigs)

      // Push workflow to running
      Effect.runSync(service.updateWorkflowStatus(wid, "running"))

      // Complete node A with output that does NOT match B's condition value
      Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
      Effect.runSync(service.updateNodeStatus({
        sessionId: `${wid}::A`,
        status: "completed",
        outputData: { status: "skip_downstream" },
      }))

      // B and C remain pending. No engine registered → orphan.
      expect(WorkflowEngine.get(wid)).toBeUndefined()

      // Trigger recovery
      const result = Effect.runSync(recoverOrphanedWorkflows(service, mockPromptOps()))

      // Recovery succeeded
      expect(result.scanned).toBe(1)
      expect(result.resumed).toBe(1)
      expect(result.marked).toBe(0)

      // After recovery: scheduleReadyNodes was called.
      // B is ready (dep A completed), but condition ref_node=A, op=eq, value="execute"
      // evaluates to false (A's output is {status:"skip_downstream"} ≠ "execute").
      // B → skipped. C depends on B → cascade skipped.
      const nodes = Effect.runSync(service.listNodes(wid))
      const nodeMap = new Map(nodes.map((n) => [n.node_id, n.status] as const))

      expect(nodeMap.get(`${wid}::A`)).toBe("completed")
      expect(nodeMap.get(`${wid}::B`)).toBe("skipped")
      expect(nodeMap.get(`${wid}::C`)).toBe("skipped")

      // Violation: condition_skipped for B
      const violations = Effect.runSync(service.listViolations(wid))
      const condViolation = violations.find((v) => v.nodeId === `${wid}::B`)
      expect(condViolation).toBeDefined()
      expect(condViolation!.type).toBe("condition_skipped")
      expect(condViolation!.details).toBeDefined()
      expect((condViolation!.details as Record<string, unknown>)["trigger"]).toBe("condition_false")

      // All nodes terminal → workflow should finalize to "completed" (no required nodes failed)
      const wfAfter = Effect.runSync(service.getWorkflow(wid))
      expect(wfAfter?.status).toBe("completed")

      // Cleanup
      unregisterEngine(wid)
    })

    it("recovery with condition true → node proceeds normally (not skipped)", () => {
      const service = Effect.runSync(DAGSessionService.make)

      // A completes with "execute" → B's condition (eq "execute") evaluates TRUE
      const nodeConfigs = [
        makeNodeConfig("A", []),
        makeNodeConfig("B", ["A"], {
          condition: { ref_node: "A", op: "eq", value: "execute" },
        }),
      ]
      const { workflowId: wid } = setupWorkflow(service, "x1-cond-true", nodeConfigs)

      Effect.runSync(service.updateWorkflowStatus(wid, "running"))
      Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
      Effect.runSync(service.updateNodeStatus({
        sessionId: `${wid}::A`,
        status: "completed",
        outputData: "execute",
      }))

      // No engine → orphan
      expect(WorkflowEngine.get(wid)).toBeUndefined()

      const result = Effect.runSync(recoverOrphanedWorkflows(service, mockPromptOps()))
      expect(result.resumed).toBe(1)

      // B should NOT be skipped (condition is true: output "execute" === "execute")
      const nodes = Effect.runSync(service.listNodes(wid))
      const bNode = nodes.find((n) => n.node_id === `${wid}::B`)
      expect(bNode).toBeDefined()
      // B is in executeList → spawnReadyNode forks (but won't actually run agent in test)
      // It should NOT be skipped
      expect(bNode!.status).not.toBe("skipped")

      // No condition_skipped violation for B
      const violations = Effect.runSync(service.listViolations(wid))
      const condViolations = violations.filter((v) => v.type === "condition_skipped")
      expect(condViolations.length).toBe(0)

      // Cleanup
      unregisterEngine(wid)
    })
  })

  // ==========================================================================
  // X2: A×C — Recovery + Data Flow
  // ==========================================================================

  describe("X2: Recovery + Data Flow", () => {
    it("upstream output persists across recovery → data flow chain resolves correctly", () => {
      const service = Effect.runSync(DAGSessionService.make)

      // Topology: A(completed, output={result:"hello-from-A", score:42}) → B(pending, input_mapping)
      const nodeConfigs = [
        makeNodeConfig("A", []),
        makeNodeConfig("B", ["A"], {
          input_mapping: {
            upstream_result: { ref_node: "A", ref_path: "result" },
          },
        }),
      ]
      const { workflowId: wid } = setupWorkflow(service, "x2-recovery-dataflow", nodeConfigs)

      // Push workflow to running, complete A with structured output
      Effect.runSync(service.updateWorkflowStatus(wid, "running"))
      Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
      Effect.runSync(service.updateNodeStatus({
        sessionId: `${wid}::A`,
        status: "completed",
        outputData: { result: "hello-from-A", score: 42 },
      }))

      // B stays pending. No engine → orphan.
      expect(WorkflowEngine.get(wid)).toBeUndefined()

      // Trigger recovery
      const result = Effect.runSync(recoverOrphanedWorkflows(service, mockPromptOps()))
      expect(result.resumed).toBe(1)

      // Verify DB data integrity: upstream output persisted and accessible
      const aNode = Effect.runSync(service.getNode(`${wid}::A`))
      expect(aNode).toBeDefined()
      expect(aNode!.status).toBe("completed")
      expect(aNode!.output).toEqual({ result: "hello-from-A", score: 42 })

      // Simulate data flow chain (same pattern as scenario-26):
      // buildOutputMap → collectInputMapping → injectCollectedDataToPrompt
      const allNodes = Effect.runSync(service.listNodes(wid))
      const outputMap = buildOutputMap(allNodes)

      // outputMap should contain A's output (keyed by config id "A")
      expect(outputMap.get("A")).toEqual({ result: "hello-from-A", score: 42 })

      const bNode = Effect.runSync(service.getNode(`${wid}::B`))
      expect(bNode).toBeDefined()
      expect(bNode!.config.input_mapping).toBeDefined()

      const collected = collectInputMapping(
        bNode!.config.input_mapping,
        outputMap,
        bNode!.config.dependencies,
      )

      // upstream_result should resolve via ref_path="result" → "hello-from-A"
      expect(collected["upstream_result"]).toBeDefined()
      expect(collected["upstream_result"].value).toBe("hello-from-A")
      expect(collected["upstream_result"].__missing).toBeUndefined()

      // Inject into prompt
      const injection = injectCollectedDataToPrompt(collected)
      expect(injection.injected).toBe(true)
      const block = injection.injectionBlock.join("\n")
      expect(block).toContain("=== Collected Input Data ===")
      expect(block).toContain("[upstream_result]:")
      expect(block).toContain("hello-from-A")
      expect(block).toContain("=== End Collected Data ===")

      // Audit trail
      expect(injection.audit).toHaveLength(1)
      expect(injection.audit[0].inputKey).toBe("upstream_result")
      expect(injection.audit[0].status).toBe("injected")

      // Cleanup
      unregisterEngine(wid)
    })

    it("recovery with null upstream output → data flow gracefully reports null_output", () => {
      const service = Effect.runSync(DAGSessionService.make)

      const nodeConfigs = [
        makeNodeConfig("A", []),
        makeNodeConfig("B", ["A"], {
          input_mapping: {
            from_a: { ref_node: "A" },
          },
        }),
      ]
      const { workflowId: wid } = setupWorkflow(service, "x2-null-output", nodeConfigs)

      Effect.runSync(service.updateWorkflowStatus(wid, "running"))
      Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
      // Complete A with null output
      Effect.runSync(service.updateNodeStatus({
        sessionId: `${wid}::A`,
        status: "completed",
        outputData: null,
      }))

      // No engine → orphan → recovery
      const result = Effect.runSync(recoverOrphanedWorkflows(service, mockPromptOps()))
      expect(result.resumed).toBe(1)

      // Data flow chain: null output → __missing = 'null_output'
      const allNodes = Effect.runSync(service.listNodes(wid))
      const outputMap = buildOutputMap(allNodes)
      const bNode = Effect.runSync(service.getNode(`${wid}::B`))

      const collected = collectInputMapping(
        bNode!.config.input_mapping,
        outputMap,
        bNode!.config.dependencies,
      )

      expect(collected["from_a"].__missing).toBe("null_output")
      expect(collected["from_a"].value).toBeUndefined()

      // Injection: no data → not injected
      const injection = injectCollectedDataToPrompt(collected)
      expect(injection.injected).toBe(false)
      expect(injection.injectionBlock).toHaveLength(0)

      // Cleanup
      unregisterEngine(wid)
    })
  })

  // ==========================================================================
  // X3: A×D — Recovery + Sub-DAG Node
  // ==========================================================================

  describe("X3: Recovery + Sub-DAG Node", () => {
    it("running sub-DAG node resets to pending with config preserved (worker_type + subDagConfig)", () => {
      const service = Effect.runSync(DAGSessionService.make)

      // Sub-DAG config for node B
      const subDagConfig: DAGConfig = {
        name: "child-workflow",
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

      const nodeConfigs = [
        makeNodeConfig("A", []),
        makeNodeConfig("B", ["A"], {
          worker_type: "dag",
          worker_config: { subDagConfig },
        }),
      ]
      const { workflowId: wid } = setupWorkflow(service, "x3-recovery-subdag", nodeConfigs)

      // Push workflow to running, complete A, push B to running
      Effect.runSync(service.updateWorkflowStatus(wid, "running"))
      Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
      Effect.runSync(service.updateNodeStatus({
        sessionId: `${wid}::A`,
        status: "completed",
        outputData: "done",
      }))
      Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::B`, status: "running" }))

      // No engine → orphan (simulates crash while B was actively executing sub-DAG)
      expect(WorkflowEngine.get(wid)).toBeUndefined()

      // Trigger recovery
      const result = Effect.runSync(recoverOrphanedWorkflows(service, mockPromptOps()))
      expect(result.resumed).toBe(1)

      // WP-A3: B should be reset from running → pending
      const bNode = Effect.runSync(service.getNode(`${wid}::B`))
      expect(bNode).toBeDefined()
      expect(bNode!.status).toBe("pending")

      // Config integrity: worker_type and subDagConfig preserved
      expect(bNode!.config.worker_type).toBe("dag")
      expect(bNode!.config.worker_config.subDagConfig).toBeDefined()
      expect((bNode!.config.worker_config.subDagConfig as DAGConfig).name).toBe("child-workflow")
      expect((bNode!.config.worker_config.subDagConfig as DAGConfig).nodes).toHaveLength(1)
      expect((bNode!.config.worker_config.subDagConfig as DAGConfig).max_concurrency).toBe(2)

      // Recovery reset log entry
      const logs = Effect.runSync(service.listNodeLogs(`${wid}::B`))
      const resetLogs = logs.filter((l) => l.execution_phase === "recovery_reset")
      expect(resetLogs.length).toBe(1)
      expect(resetLogs[0].log_level).toBe("info")

      // A stays completed (not touched by reset)
      const aNode = Effect.runSync(service.getNode(`${wid}::A`))
      expect(aNode!.status).toBe("completed")

      // Engine registered for the workflow
      expect(WorkflowEngine.get(wid)).not.toBeUndefined()

      // Cleanup
      unregisterEngine(wid)
    })

    it("sub-DAG node config with nested nodes survives recovery round-trip", () => {
      const service = Effect.runSync(DAGSessionService.make)

      // Larger sub-DAG config to verify deep structure preservation
      const subDagConfig: DAGConfig = {
        name: "nested-workflow",
        description: "A complex sub-workflow for testing",
        nodes: [
          {
            id: "s1",
            name: "step-1",
            dependencies: [],
            required: true,
            worker_type: "build",
            worker_config: { prompt: "Build the component", timeout: 60000 },
          },
          {
            id: "s2",
            name: "step-2",
            dependencies: ["s1"],
            required: false,
            worker_type: "verify",
            worker_config: { prompt: "Verify the build" },
          },
        ],
        max_concurrency: 3,
        timeout_ms: 600000,
      }

      const nodeConfigs = [
        makeNodeConfig("root", []),
        makeNodeConfig("sub", ["root"], {
          worker_type: "dag",
          worker_config: { subDagConfig, extra_metadata: "preserved" },
        }),
      ]
      const { workflowId: wid } = setupWorkflow(service, "x3-deep-subdag", nodeConfigs)

      Effect.runSync(service.updateWorkflowStatus(wid, "running"))
      Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::root`, status: "running" }))
      Effect.runSync(service.updateNodeStatus({
        sessionId: `${wid}::root`,
        status: "completed",
        outputData: "root-done",
      }))
      // Sub-DAG node was running when crash occurred
      Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::sub`, status: "running" }))

      // Recovery
      const result = Effect.runSync(recoverOrphanedWorkflows(service, mockPromptOps()))
      expect(result.resumed).toBe(1)

      // Verify deep config preservation
      const subNode = Effect.runSync(service.getNode(`${wid}::sub`))
      expect(subNode).toBeDefined()
      expect(subNode!.status).toBe("pending")

      const workerConfig = subNode!.config.worker_config
      expect(workerConfig.extra_metadata).toBe("preserved")

      const recoveredSubDag = workerConfig.subDagConfig as DAGConfig
      expect(recoveredSubDag.name).toBe("nested-workflow")
      expect(recoveredSubDag.description).toBe("A complex sub-workflow for testing")
      expect(recoveredSubDag.nodes).toHaveLength(2)
      expect(recoveredSubDag.nodes[0].id).toBe("s1")
      expect(recoveredSubDag.nodes[0].worker_type).toBe("build")
      expect(recoveredSubDag.nodes[1].id).toBe("s2")
      expect(recoveredSubDag.nodes[1].dependencies).toEqual(["s1"])
      expect(recoveredSubDag.max_concurrency).toBe(3)
      expect(recoveredSubDag.timeout_ms).toBe(600000)

      // Cleanup
      unregisterEngine(wid)
    })
  })
})
