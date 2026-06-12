// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * subdag-dispatch.test.ts — WP-D2 sub-DAG dispatch unit tests.
 *
 * Validates validateWorkerTypes (core-start.ts) behaviour for "dag" nodes
 * and bootstrapWorkflowFromConfig depth cap enforcement.
 *
 * These tests exercise the validation chain that the dispatch block in
 * workflow-engine.ts relies on (indirectly). Direct dispatch observation
 * is impossible here because spawnReadyNode runs via Effect.forkDetach —
 * scenario-27a-subdag-spawn.test.ts covers the DB integration path.
 *
 * Acceptance criteria (009-dag-capability-expansion.md §7 WP-D2):
 * - "dag" worker_type with valid subDagConfig bypasses agent registry lookup
 * - "dag" in agent registry causes reserved-word conflict rejection
 * - "dag" worker_type without valid subDagConfig is rejected
 * - bootstrapWorkflowFromConfig rejects depth > MAX_SUB_DAG_DEPTH (3)
 * - bootstrapWorkflowFromConfig accepts depth = MAX_SUB_DAG_DEPTH (3), fails later
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Database from "@/storage/db"
import { DAGSessionService } from "../session-service"
import {
  validateWorkerTypes,
  bootstrapWorkflowFromConfig,
  type WorkerTypeAgentRegistry,
} from "../core-start"
import type { DAGNodeConfig, DAGConfig } from "../types"
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
      ? { subDagConfig: makeSubDagConfig() }
      : { prompt: `Task for ${id}` },
  }
}

function makeSubDagConfig(): DAGConfig {
  return {
    name: "sub-dag",
    nodes: [
      {
        id: "sub-A",
        name: "sub-A",
        dependencies: [],
        required: false,
        worker_type: "general",
        worker_config: { prompt: "Sub A" },
      },
    ],
    max_concurrency: 1,
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
// Tests: validateWorkerTypes for "dag" nodes
// ============================================================================

describe("WP-D2: sub-DAG dispatch — validateWorkerTypes", () => {
  it("Test 1: worker_type='dag' + valid subDagConfig → passes without agent registry lookup", async () => {
    const nodes = [makeNodeConfig("dag-node", "dag")]
    // Empty agent registry — "dag" nodes must NOT require any registered agent
    const agentService = makeAgentService([])

    const result = await Effect.runPromiseExit(
      validateWorkerTypes(agentService, nodes),
    )
    expect(result._tag).toBe("Success")
  })

  it("Test 2: worker_type='dag' + registry has 'dag' agent → rejected (reserved-word conflict)", async () => {
    const nodes = [makeNodeConfig("dag-node", "dag")]
    const agentService = makeAgentService(["dag"])

    const result = await Effect.runPromiseExit(
      validateWorkerTypes(agentService, nodes),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(String(result.cause)).toContain("Reserved worker_type conflict")
    }
  })

  it("Test 3: worker_type='dag' + no subDagConfig → rejected", async () => {
    const nodes: DAGNodeConfig[] = [
      {
        id: "dag-node",
        name: "dag-node",
        dependencies: [],
        required: false,
        worker_type: "dag",
        worker_config: {},
      },
    ]
    const agentService = makeAgentService([])

    const result = await Effect.runPromiseExit(
      validateWorkerTypes(agentService, nodes),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(String(result.cause)).toContain("subDagConfig")
    }
  })

  it("Test 3b: worker_type='dag' + invalid subDagConfig (not object) → rejected", async () => {
    const nodes: DAGNodeConfig[] = [
      {
        id: "dag-node",
        name: "dag-node",
        dependencies: [],
        required: false,
        worker_type: "dag",
        worker_config: { subDagConfig: "not-an-object" },
      },
    ]
    const agentService = makeAgentService([])

    const result = await Effect.runPromiseExit(
      validateWorkerTypes(agentService, nodes),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(String(result.cause)).toContain("subDagConfig")
    }
  })

  it("Test 4: worker_type='agent' + registered agent → accepted (regression)", async () => {
    const nodes = [
      makeNodeConfig("node-A", "general"),
      { ...makeNodeConfig("node-B"), worker_type: "implement" },
    ]
    const agentService = makeAgentService(["general", "implement"])

    const result = await Effect.runPromiseExit(
      validateWorkerTypes(agentService, nodes),
    )
    expect(result._tag).toBe("Success")
  })

  it("Test 5: worker_type with unregistered agent → rejected", async () => {
    const nodes = [makeNodeConfig("node-A", "general")]
    const agentService = makeAgentService([])

    const result = await Effect.runPromiseExit(
      validateWorkerTypes(agentService, nodes),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(String(result.cause)).toContain("Unknown DAG worker_type: general")
    }
  })
})

// ============================================================================
// Tests: bootstrapWorkflowFromConfig depth cap
// ============================================================================

describe("WP-D2: bootstrapWorkflowFromConfig depth cap", () => {
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

  it("Test 6: depth=4 (exceeds MAX_SUB_DAG_DEPTH=3) → rejected with 'recursion depth'", async () => {
    const dagSessionService = Effect.runSync(DAGSessionService.make)
    const agentService = makeAgentService(["general"])

    const dagConfig: DAGConfig = {
      name: "test-depth4",
      nodes: [makeNodeConfig("A", "general")],
      max_concurrency: 1,
    }

    const result = await Effect.runPromiseExit(
      bootstrapWorkflowFromConfig({
        dagConfig,
        chatSessionId: "test-session",
        promptOps: mockPromptOps(),
        dagSessionService,
        agentService,
        depth: 4,
      }),
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(String(result.cause)).toContain("recursion depth")
    }
  })

  it("Test 7: depth=3 (= MAX_SUB_DAG_DEPTH=3) → depth check passes, fails later on validateWorkerTypes", async () => {
    const dagSessionService = Effect.runSync(DAGSessionService.make)
    // Empty registry: "general" not found → validateWorkerTypes will reject
    const agentService = makeAgentService([])

    const dagConfig: DAGConfig = {
      name: "test-depth3",
      nodes: [makeNodeConfig("A", "general")],
      max_concurrency: 1,
    }

    const result = await Effect.runPromiseExit(
      bootstrapWorkflowFromConfig({
        dagConfig,
        chatSessionId: "test-session",
        promptOps: mockPromptOps(),
        dagSessionService,
        agentService,
        depth: 3,
      }),
    )

    // depth=3 passes depth check (3 ≤ 3); failure must come from a later step
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      const errMsg = String(result.cause)
      expect(errMsg).not.toContain("recursion depth")
      expect(errMsg).toContain("Unknown DAG worker_type")
    }
  })
})
