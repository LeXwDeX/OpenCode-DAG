// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * Scenario 26: WP-C3 — Data flow: upstream output collection + prompt injection
 * integration tests (DB-backed composition).
 *
 * Validates the end-to-end data flow path that spawnReadyNode would execute:
 * - Upstream node completes → outputMap built → collectInputMapping resolves
 *   upstream data → injectCollectedDataToPrompt produces final prompt.
 *
 * Tests use real DB session data (in-memory SQLite) to validate the compose
 * chain: buildOutputMap → collectInputMapping → injectCollectedDataToPrompt.
 *
 * NOT tested directly: forked fiber execution (prompt injection log is
 * written inside spawnReadyNode's detached fiber, which is not synchronously
 * observable in sync tests). The injectCollectedDataToPrompt unit tests
 * (prompt-inject.test.ts) cover the pure logic exhaustively.
 *
 * Acceptance criteria (009-dag-capability-expansion.md §7 WP-C3):
 * - Node with input_mapping → prompt contains upstream data (serialized)
 * - Upstream output null → downstream prompt has no injected entry for that key
 * - No input_mapping → prompt unchanged (backward compatible)
 * - Audit trail records injection status per entry
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Database from "@/storage/db"
import { DAGSessionService } from "../session-service"
import { WorkflowEngine } from "../workflow-engine"
import { buildOutputMap } from "../condition-eval"
import { collectInputMapping } from "../input-mapping-collector"
import { injectCollectedDataToPrompt } from "../prompt-inject"
import type { DAGConfig, DAGNodeConfig, DAGNodeSession, DAGWorkflowSession } from "../types"

// ============================================================================
// Helpers
// ============================================================================

function makeNodeConfig(
  id: string,
  deps: string[],
  inputMapping?: DAGNodeConfig["input_mapping"],
): DAGNodeConfig {
  return {
    id,
    name: id,
    dependencies: deps,
    required: false,
    worker_type: "general",
    worker_config: { prompt: `Do task ${id}` },
    input_mapping: inputMapping,
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
): { workflowId: string } {
  const config: DAGConfig = {
    name,
    nodes: nodeConfigs,
    max_concurrency: 5,
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

/**
 * Simulate the data-flow chain that spawnReadyNode would perform:
 * 1. List nodes from DB
 * 2. Build outputMap
 * 3. Collect inputMapping for target node
 * 4. Inject into original prompt
 */
function simulateDataFlow(
  service: {
    readonly listNodes: (workflowId: string) => Effect.Effect<DAGNodeSession[]>
  },
  workflowId: string,
  targetNode: DAGNodeSession,
): ReturnType<typeof injectCollectedDataToPrompt> {
  const allNodes = Effect.runSync(service.listNodes(workflowId))
  const outputMap = buildOutputMap(allNodes)
  const collected = collectInputMapping(
    targetNode.config.input_mapping,
    outputMap,
    targetNode.config.dependencies,
  )
  return injectCollectedDataToPrompt(collected)
}

// ============================================================================
// Tests
// ============================================================================

describe("WP-C3: Data flow — upstream output → prompt injection (DB integration)", () => {
  const originalDb = Flag.OPENCODE_DB

  beforeAll(() => {
    Flag.OPENCODE_DB = ":memory:"
    Database.Client.reset()
  })

  afterAll(() => {
    try { Database.close() } catch { /* ignore */ }
    Flag.OPENCODE_DB = originalDb
    Database.Client.reset()
  })

  it("Test A: Upstream completed → downstream prompt contains injected upstream data", () => {
    const service = Effect.runSync(DAGSessionService.make)
    const engine = Effect.runSync(WorkflowEngine.make)

    const nodeConfigs = [
      makeNodeConfig("A", []),
      makeNodeConfig("B", ["A"], {
        upstreamResult: { ref_node: "A" },
      }),
    ]
    const { workflowId: wid } = setupWorkflow(service, "dataflow-normal", nodeConfigs)

    // Start workflow and complete upstream A
    Effect.runSync(service.updateWorkflowStatus(wid, "running"))
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
    Effect.runSync(engine.handleNodeCompletion(wid, `${wid}::A`, { result: "data-from-A", score: 99 }))

    // B is now "ready" in the engine schedule.
    // Simulate the data-flow chain that spawnReadyNode would execute for B.
    const bNode = Effect.runSync(service.getNode(`${wid}::B`))
    expect(bNode).toBeDefined()
    expect(bNode!.config.input_mapping).toBeDefined()

    const result = simulateDataFlow(service, wid, bNode!)

    // Prompt block should contain the injected upstream data
    expect(result.injected).toBe(true)
    const block = result.injectionBlock.join("\n")
    expect(block).toContain("=== Collected Input Data ===")
    expect(block).toContain("=== End Collected Data ===")
    expect(block).toContain("[upstreamResult]:")
    // The serialized value should contain the upstream data
    expect(block).toContain("data-from-A")
    expect(block).toContain("99")

    // Audit: upstreamResult should be injected
    expect(result.audit).toHaveLength(1)
    expect(result.audit[0].inputKey).toBe("upstreamResult")
    expect(result.audit[0].status).toBe("injected")
  })

  it("Test B: Upstream output null → downstream prompt skips injection for that key", () => {
    const service = Effect.runSync(DAGSessionService.make)
    const engine = Effect.runSync(WorkflowEngine.make)

    const nodeConfigs = [
      makeNodeConfig("X", []),
      makeNodeConfig("Y", ["X"], {
        fromX: { ref_node: "X" },
      }),
    ]
    const { workflowId: wid } = setupWorkflow(service, "dataflow-null", nodeConfigs)

    Effect.runSync(service.updateWorkflowStatus(wid, "running"))
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::X`, status: "running" }))
    // X completes with null output
    Effect.runSync(engine.handleNodeCompletion(wid, `${wid}::X`, null))

    const yNode = Effect.runSync(service.getNode(`${wid}::Y`))
    expect(yNode).toBeDefined()

    const result = simulateDataFlow(service, wid, yNode!)

    // No data was collected successfully → no injection
    expect(result.injected).toBe(false)
    expect(result.injectionBlock).toHaveLength(0)

    // Audit: fromX should be skipped with reason null_output
    expect(result.audit).toHaveLength(1)
    expect(result.audit[0].inputKey).toBe("fromX")
    expect(result.audit[0].status).toBe("skipped")
    expect(result.audit[0].reason).toBe("null_output")
  })

  it("Test C: No input_mapping → prompt unchanged (backward compatibility)", () => {
    const service = Effect.runSync(DAGSessionService.make)
    const engine = Effect.runSync(WorkflowEngine.make)

    // B has no input_mapping → should get empty collectedInputData
    const nodeConfigs = [
      makeNodeConfig("P", []),
      makeNodeConfig("Q", ["P"]), // no input_mapping
    ]
    const { workflowId: wid } = setupWorkflow(service, "dataflow-no-mapping", nodeConfigs)

    Effect.runSync(service.updateWorkflowStatus(wid, "running"))
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::P`, status: "running" }))
    Effect.runSync(engine.handleNodeCompletion(wid, `${wid}::P`, "done"))

    const qNode = Effect.runSync(service.getNode(`${wid}::Q`))
    expect(qNode).toBeDefined()
    expect(qNode!.config.input_mapping).toBeUndefined()

    const result = simulateDataFlow(service, wid, qNode!)

    // No injection — block is empty (backward compatible)
    expect(result.injected).toBe(false)
    expect(result.injectionBlock).toHaveLength(0)
    expect(result.audit).toHaveLength(0)
  })
})
