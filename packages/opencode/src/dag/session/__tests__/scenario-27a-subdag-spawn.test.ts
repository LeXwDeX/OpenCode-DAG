// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * scenario-27a-subdag-spawn.test.ts — WP-D2 sub-DAG spawn DB integration tests.
 *
 * Tests verify DB schema correctness for "dag" nodes and depth-cap enforcement
 * via bootstrapWorkflowFromConfig (directly, NOT via spawnReadyNode forkDetach).
 *
 * Design constraint: spawnReadyNode dispatches "dag" nodes via Effect.forkDetach
 * (async fiber). Sub-workflow/node DB row creation cannot be observed synchronously
 * in Effect.runSync/runPromise. We therefore test:
 * - Parent workflow DB setup (synchronous, observable)
 * - bootstrapWorkflowFromConfig depth rejection / acceptance (synchronous failure path)
 * - validateWorkflowConfigLimits enforcement on createWorkflow
 *
 * Acceptance criteria (009-dag-capability-expansion.md §7 WP-D2):
 * - Parent workflow + "dag" node DB rows created correctly
 * - Sub-DAG config with > 20 nodes rejected by createWorkflow (node cap)
 * - bootstrapWorkflowFromConfig depth=4 rejected before any DB writes
 * - bootstrapWorkflowFromConfig depth=1 creates DB rows + persists chat_session_id
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Database from "@/storage/db"
import { DAGSessionService } from "../session-service"
import { WorkflowEngine, unregisterEngine } from "../workflow-engine"
import { bootstrapWorkflowFromConfig, type WorkerTypeAgentRegistry } from "../core-start"
import type { DAGNodeConfig, DAGConfig, DAGWorkflowSession } from "../types"
import type { Agent } from "@/agent/agent"
import type { PromptOps } from "@/session/prompt-ops"
import type { SessionPrompt } from "@/session/prompt"
import type { MessageV2 } from "@/session/message-v2"

// ============================================================================
// Test helpers
// ============================================================================

function createAgent(name: string): Agent.Info {
  return {
    name,
    mode: "subagent",
    permission: [],
    options: {},
  }
}

function makeAgentService(agents: string[]): WorkerTypeAgentRegistry {
  return {
    get: (agent) =>
      Effect.succeed(agents.includes(agent) ? createAgent(agent) : undefined),
    list: () => Effect.succeed(agents.map(createAgent)),
  }
}

function makeNodeConfig(
  id: string,
  workerType: string = "general",
  deps: string[] = [],
): DAGNodeConfig {
  return {
    id,
    name: id,
    dependencies: deps,
    required: false,
    worker_type: workerType,
    worker_config: workerType === "dag"
      ? {
          subDagConfig: {
            name: `sub-${id}`,
            nodes: [
              {
                id: "sub-A",
                name: "sub-A",
                dependencies: [],
                required: false,
                worker_type: "general",
                worker_config: { prompt: `Sub task A under ${id}` },
              },
            ],
            max_concurrency: 1,
          },
        }
      : { prompt: `Task for ${id}` },
  }
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

describe("WP-D2 scenario 27a: sub-DAG spawn DB integration", () => {
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

  it("Test A: createWorkflow + 'dag' node with valid subDagConfig → DB rows created", () => {
    const dagSessionService = Effect.runSync(DAGSessionService.make)

    const dagConfig: DAGConfig = {
      name: "parent-with-dag-node",
      nodes: [makeNodeConfig("D1", "dag")],
      max_concurrency: 1,
    }

    const chatSessionId = "parent-session-A"
    const workflow: DAGWorkflowSession = Effect.runSync(
      dagSessionService.createWorkflow({
        name: dagConfig.name,
        chatSessionId,
        config: dagConfig,
      }),
    )
    expect(workflow.id).toBeTruthy()
    expect(workflow.chat_session_id).toBe(chatSessionId)
    expect(workflow.status).toBe("pending")

    // Create the "dag" node DB row
    Effect.runSync(
      dagSessionService.createNode({
        workflowId: workflow.id,
        nodeId: `${workflow.id}::D1`,
        name: "D1",
        nodeName: "D1",
        nodeType: "dag",
        config: dagConfig.nodes[0],
        dependencyNodes: [],
      }),
    )

    // Mark node as running (simulating dispatch-block pre-bootstrap state)
    Effect.runSync(
      dagSessionService.updateNodeStatus({
        sessionId: `${workflow.id}::D1`,
        status: "running",
      }),
    )

    const nodes = Effect.runSync(dagSessionService.listNodes(workflow.id))
    expect(nodes).toHaveLength(1)
    expect(nodes[0].node_id).toBe(`${workflow.id}::D1`)
    expect(nodes[0].config.worker_type).toBe("dag")
    expect(nodes[0].status).toBe("running")
    expect(nodes[0].config.worker_config.subDagConfig).toBeTruthy()
  })

  it("Test B: createWorkflow with 21 nodes → validateWorkflowConfigLimits rejects", async () => {
    const dagSessionService = Effect.runSync(DAGSessionService.make)

    const overCapNodes: DAGNodeConfig[] = Array.from({ length: 21 }, (_, i) => ({
      id: `node-${i}`,
      name: `node-${i}`,
      dependencies: [],
      required: false,
      worker_type: "general",
      worker_config: { prompt: `Task ${i}` },
    }))

    const dagConfig: DAGConfig = {
      name: "over-cap",
      nodes: overCapNodes,
      max_concurrency: 1,
    }

    const result = await Effect.runPromiseExit(
      bootstrapWorkflowFromConfig({
        dagConfig,
        chatSessionId: "test-B",
        promptOps: mockPromptOps(),
        abortSignal: new AbortController().signal,
        dagSessionService,
        agentService: makeAgentService(["general"]),
      }),
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(String(result.cause)).toContain("node cap exceeded")
    }
  })

  it("Test C: bootstrapWorkflowFromConfig depth=4 → rejected with 'recursion depth' before DB writes", async () => {
    const dagSessionService = Effect.runSync(DAGSessionService.make)
    const agentService = makeAgentService(["general"])

    const dagConfig: DAGConfig = {
      name: "test-depth4-C",
      nodes: [makeNodeConfig("C1", "general")],
      max_concurrency: 1,
    }

    const result = await Effect.runPromiseExit(
      bootstrapWorkflowFromConfig({
        dagConfig,
        chatSessionId: "test-C",
        promptOps: mockPromptOps(),
        abortSignal: new AbortController().signal,
        dagSessionService,
        agentService,
        depth: 4,
      }),
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(String(result.cause)).toContain("recursion depth")
    }

    // Depth=4 rejects BEFORE createWorkflow — no workflow rows should exist
    const allWorkflows = Effect.runSync(dagSessionService.listAllWorkflows())
    expect(allWorkflows).toHaveLength(0)
  })

  it("Test D: bootstrapWorkflowFromConfig depth=1 + valid 'dag' node → DB rows created, chat_session_id persisted", async () => {
    const dagSessionService = Effect.runSync(DAGSessionService.make)
    // "general" must be registered because the sub-DAG's sub-A node uses it
    const agentService = makeAgentService(["general"])

    const dagConfig: DAGConfig = {
      name: "parent-depth1-D",
      nodes: [makeNodeConfig("D-dag", "dag")],
      max_concurrency: 1,
    }
    const chatSessionId = "test-D-session"

    const result = await Effect.runPromise(
      bootstrapWorkflowFromConfig({
        dagConfig,
        chatSessionId,
        promptOps: mockPromptOps(),
        abortSignal: new AbortController().signal,
        dagSessionService,
        agentService,
        depth: 1,
      }),
    )

    expect(result.workflowId).toBeTruthy()
    expect(result.nodeCount).toBe(1)

    // Parent workflow DB row exists
    const workflow = Effect.runSync(dagSessionService.getWorkflow(result.workflowId))
    expect(workflow).toBeDefined()
    expect(workflow!.chat_session_id).toBe(chatSessionId)
    expect(workflow!.status).toBe("running")
    expect(workflow!.config.name).toBe("parent-depth1-D")

    // Parent node DB row exists
    const nodes = Effect.runSync(dagSessionService.listNodes(result.workflowId))
    expect(nodes).toHaveLength(1)
    expect(nodes[0].node_id).toBe(`${result.workflowId}::D-dag`)
    expect(nodes[0].config.worker_type).toBe("dag")

    // Clean up registered engine
    unregisterEngine(result.workflowId)
  })

  it("Test E: parent workflow metadata.depth propagated to sub-workflow via bootstrapWorkflowFromConfig", async () => {
    // Tests the full depth propagation chain (§3.3):
    //   1. Parent workflow has metadata.depth = 2 (already 2 levels deep)
    //   2. spawnReadyNode computes childDepth = parentDepth + 1 = 3
    //   3. spawnReadyNode calls bootstrapWorkflowFromConfig({ depth: 3 })
    //   4. core-start.ts Step 3 createWorkflow persists metadata: { depth: 3 }
    //   5. Sub-workflow DB row metadata.depth = 3
    //
    // We bypass spawnReadyNode (async fiber, not synchronously observable)
    // and call bootstrapWorkflowFromConfig directly with depth=3 — verifying
    // the createWorkflow → metadata.depth → DB persistence path end-to-end.

    const dagSessionService = Effect.runSync(DAGSessionService.make)
    const agentService = makeAgentService(["general"])

    const dagConfig: DAGConfig = {
      name: "depth-propagation-E",
      nodes: [makeNodeConfig("E1", "general")],
      max_concurrency: 1,
    }
    const chatSessionId = "test-E-session"
    const childDepth = 3 // exactly at MAX_SUB_DAG_DEPTH limit

    const result = await Effect.runPromise(
      bootstrapWorkflowFromConfig({
        dagConfig,
        chatSessionId,
        promptOps: mockPromptOps(),
        abortSignal: new AbortController().signal,
        dagSessionService,
        agentService,
        parentWorkflowId: "parent-wf-E",
        parentNodeId: "parent-node-E1",
        depth: childDepth,
      }),
    )

    expect(result.workflowId).toBeTruthy()

    // Verify sub-workflow DB row has metadata.depth = 3 (end-to-end persistence).
    const subWorkflow = Effect.runSync(dagSessionService.getWorkflow(result.workflowId))
    expect(subWorkflow).toBeDefined()
    expect(subWorkflow!.metadata).toBeDefined()
    expect(subWorkflow!.metadata.depth).toBe(childDepth)

    // Clean up registered engine.
    unregisterEngine(result.workflowId)
  })
})
