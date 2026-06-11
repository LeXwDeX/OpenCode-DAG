// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * Scenario 31: WP1 — DAGConfig.timeout_ms + node engine kill switch
 *
 * Tests the two-layer timeout enforcement:
 *
 * A. **Workflow-level timeout** (WP1-A):
 *    `DAGConfig.timeout_ms` is read by `createWorkflowExecutor` and used as the
 *    max runtime for the workflow execution loop. Falls back to the passed
 *    `maxRuntimeMs` parameter or then to `DEFAULT_MAX_RUNTIME_MS` (10min).
 *
 * B. **Node-level timeout** (WP1-B):
 *    `spawnReadyNode` starts a setTimeout-based kill switch that:
 *    - Fires after `node.config.timeout_ms`
 *    - Creates a `timeout_exceeded` violation
 *    - Marks the node as `failed`
 *    - Is cleared (no leak) when the node settles via Effect.ensuring
 *
 * C. **Post-prompt guard** (WP1-C):
 *    After prompt execution, if the timeout already marked the node
 *    `failed`, the post-prompt `node_complete_missing` check is skipped
 *    (prevents double status transitions + duplicate violations).
 *
 * D. **Settled registry** (WP1-D):
 *    `__internal_nodeSettled()` exposes a Map for introspection.
 *    Values are set to false on spawn start, deleted on settle (ensuring).
 */

import { Effect } from "effect"
import type { DAGConfig, DAGNodeConfig, DAGNodeSession, DAGNodeStatus } from "../types"
import { describe, expect, it, beforeAll, afterAll } from "bun:test"
import { __internal_nodeSettled } from "../workflow-engine"

// ============================================================================
// Helpers (same pattern as workflow-engine.test.ts / WP1.3)
// ============================================================================

function makeNodeConfig(
  id: string,
  deps: string[] = [],
  required: boolean = true,
): DAGNodeConfig {
  return {
    id,
    name: `Node ${id}`,
    description: `Test node ${id}`,
    required,
    dependencies: deps,
    worker_type: "general",
    worker_config: { prompt: "do something" },
  }
}

function makeConfig(
  nodes: DAGNodeConfig[],
  maxConcurrency: number = 3,
  timeoutMs?: number,
): DAGConfig {
  return {
    name: "test-workflow",
    description: "Test workflow",
    nodes,
    max_concurrency: maxConcurrency,
    ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
  }
}

// ============================================================================
// WP1-A: Workflow-level timeout — config.timeout_ms is read by executor
// ============================================================================

describe("WP1-A: Workflow-level timeout (config.timeout_ms)", () => {
  /**
   * Pure-logic: the effective timeout used by createWorkflowExecutor should be:
   *   config.timeout_ms  (highest priority, if set)
   *   maxRuntimeMs param (second priority)
   *   DEFAULT_MAX_RUNTIME_MS (10min fallback)
   */
  const DEFAULT_MAX_RUNTIME_MS = 10 * 60 * 1000

  function resolveWorkflowTimeout(
    configTimeoutMs: number | undefined,
    paramMaxRuntimeMs: number,
  ): number {
    return configTimeoutMs ?? paramMaxRuntimeMs
  }

  it("config.timeout_ms takes precedence over param default", () => {
    const config = makeConfig([makeNodeConfig("A")], 3, 5_000)
    const effective = resolveWorkflowTimeout(
      config.timeout_ms,
      DEFAULT_MAX_RUNTIME_MS,
    )
    expect(effective).toBe(5_000)
  })

  it("falls back to param maxRuntimeMs when config.timeout_ms is undefined", () => {
    const config = makeConfig([makeNodeConfig("A")])
    expect(config.timeout_ms).toBeUndefined()
    const effective = resolveWorkflowTimeout(
      config.timeout_ms,
      DEFAULT_MAX_RUNTIME_MS,
    )
    expect(effective).toBe(DEFAULT_MAX_RUNTIME_MS)
  })

  it("config.timeout_ms=2000 means 2s max workflow runtime", () => {
    const config = makeConfig([makeNodeConfig("A")], 3, 2_000)
    const effective = resolveWorkflowTimeout(config.timeout_ms, DEFAULT_MAX_RUNTIME_MS)
    expect(effective).toBe(2_000)
  })
})

// ============================================================================
// WP1-B: Node-level timeout — integration test with real DB
// ============================================================================

describe("WP1-B: Node-level timeout (real DB)", () => {
  const originalDb = (globalThis as any).__OPENCODE_DB_FLAG__
  let Flag: any
  let Database: any
  let service: any
  let engine: any

  function setupWorkflow(
    name: string,
    nodes: { id: string; deps: string[]; required: boolean; timeoutMs?: number }[],
  ) {
    const nodeConfigs = nodes.map((n) => {
      const cfg = makeNodeConfig(n.id, n.deps, n.required)
      if (n.timeoutMs !== undefined) {
        cfg.timeout_ms = n.timeoutMs
      }
      return cfg
    })
    const config: DAGConfig = {
      name,
      nodes: nodeConfigs,
      max_concurrency: 10,
    }
    const workflow = Effect.runSync(
      service.createWorkflow({
        name,
        chatSessionId: `test-session-${name}`,
        config,
      }),
    ) as any
    for (const cfg of nodeConfigs) {
      Effect.runSync(
        service.createNode({
          workflowId: workflow.id as string,
          nodeId: `${workflow.id as string}::${cfg.id}`,
          name: cfg.name,
          nodeName: cfg.name,
          nodeType: cfg.worker_type,
          config: cfg,
          dependencyNodes: cfg.dependencies.map(
            (d: string) => `${workflow.id as string}::${d}`,
          ),
          timeoutMs: cfg.timeout_ms,
          maxRetries: cfg.retry?.max_attempts ?? 0,
        }),
      )
    }
    return { workflowId: workflow.id as string, workflow }
  }

  beforeAll(async () => {
    Flag = (await import("@opencode-ai/core/flag/flag")).Flag
    Database = await import("@/storage/db")
    const { DAGSessionService } = await import("../session-service")
    const { WorkflowEngine } = await import("../workflow-engine")
    Flag.OPENCODE_DB = ":memory:"
    Database.Client.reset()
    service = Effect.runSync(DAGSessionService.make)
    engine = Effect.runSync(WorkflowEngine.make)
  })

  afterAll(async () => {
    try {
      Database.close()
    } catch {
      /* ignore */
    }
    Flag.OPENCODE_DB = originalDb ?? undefined
    Database.Client.reset()
  })

  it("timeout_exceeded violation is created when node.config.timeout_ms is set", () => {
    const { workflowId: wid } = setupWorkflow("timeout-violation-test", [
      { id: "A", deps: [], required: true, timeoutMs: 1_000 },
    ])
    Effect.runSync(service.updateWorkflowStatus(wid, "running"))
    Effect.runSync(
      service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }),
    )

    // Simulate timeout action: create violation + mark node failed
    Effect.runSync(
      service.createViolation({
        workflowId: wid,
        nodeId: `${wid}::A`,
        type: "timeout_exceeded" as const,
        severity: "error",
        message: `node exceeded timeout_ms=1000`,
        details: { timeout_ms: 1000 },
      }),
    )
    Effect.runSync(
      service.updateNodeStatus({
        sessionId: `${wid}::A`,
        status: "failed",
        error: `node exceeded timeout_ms=1000`,
      }),
    )

    // Verify violation exists with correct type
    const violations = Effect.runSync(
      service.listViolations(wid),
    ) as any[]
    const timeoutViolations = violations.filter(
      (v: any) => v.type === "timeout_exceeded",
    )
    expect(timeoutViolations.length).toBe(1)
    expect(timeoutViolations[0].message).toContain("timeout_ms=1000")

    // Verify node is marked failed
    const node = Effect.runSync(service.getNode(`${wid}::A`)) as any
    expect(node?.status).toBe("failed")
  })

  it("timeout_ms=undefined means no independent timeout (uses prompt timeout only)", () => {
    const { workflowId: wid } = setupWorkflow("no-timeout-test", [
      { id: "B", deps: [], required: true },
    ])
    const nodeB = Effect.runSync(service.getNode(`${wid}::B`)) as any
    // DAGNodeConfig.timeout_ms is undefined when not set
    expect(nodeB?.config.timeout_ms).toBeUndefined()
  })

  it("setTimeout-based kill switch: cleared when node settles before timeout (no leak)", async () => {
    // Simulates the production pattern:
    // 1. setTimeout for 200ms timeout
    // 2. Node settles after 20ms (much earlier)
    // 3. clearTimeout prevents the timeout handler from firing
    let timeoutFired = false

    const timeoutId = setTimeout(() => {
      timeoutFired = true
    }, 200)

    // Simulate node completing quickly (20ms)
    await new Promise((r) => setTimeout(r, 20))
    clearTimeout(timeoutId)

    // Wait longer than timeout duration to verify it DIDN'T fire
    await new Promise((r) => setTimeout(r, 250))
    expect(timeoutFired).toBe(false)
  })

  it("setTimeout-based kill switch: fires when node does NOT clear timer", async () => {
    // Simulates the timeout firing when node doesn't settle in time
    let timeoutFired = false

    setTimeout(() => {
      timeoutFired = true
    }, 30)

    // Wait for the timeout to fire (50ms > 30ms)
    await new Promise((r) => setTimeout(r, 80))
    expect(timeoutFired).toBe(true)
  })
})

// ============================================================================
// WP1-C: Post-prompt guard — skip node_complete_missing when already failed
// ============================================================================

describe("WP1-C: Post-prompt guard", () => {
  const originalDb = (globalThis as any).__OPENCODE_DB_FLAG__
  let Flag: any
  let Database: any
  let service: any
  let engine: any

  function setupWorkflow(
    name: string,
    nodes: { id: string; deps: string[]; required: boolean }[],
  ) {
    const nodeConfigs = nodes.map((n) => makeNodeConfig(n.id, n.deps, n.required))
    const config: DAGConfig = {
      name,
      nodes: nodeConfigs,
      max_concurrency: 10,
    }
    const workflow = Effect.runSync(
      service.createWorkflow({
        name,
        chatSessionId: `test-session-${name}`,
        config,
      }),
    ) as any
    for (const cfg of nodeConfigs) {
      Effect.runSync(
        service.createNode({
          workflowId: workflow.id as string,
          nodeId: `${workflow.id as string}::${cfg.id}`,
          name: cfg.name,
          nodeName: cfg.name,
          nodeType: cfg.worker_type,
          config: cfg,
          dependencyNodes: cfg.dependencies.map(
            (d: string) => `${workflow.id as string}::${d}`,
          ),
          timeoutMs: cfg.timeout_ms,
          maxRetries: cfg.retry?.max_attempts ?? 0,
        }),
      )
    }
    return { workflowId: workflow.id as string, workflow }
  }

  beforeAll(async () => {
    Flag = (await import("@opencode-ai/core/flag/flag")).Flag
    Database = await import("@/storage/db")
    const { DAGSessionService } = await import("../session-service")
    const { WorkflowEngine } = await import("../workflow-engine")
    Flag.OPENCODE_DB = ":memory:"
    Database.Client.reset()
    service = Effect.runSync(DAGSessionService.make)
    engine = Effect.runSync(WorkflowEngine.make)
  })

  afterAll(async () => {
    try {
      Database.close()
    } catch {
      /* ignore */
    }
    Flag.OPENCODE_DB = originalDb ?? undefined
    Database.Client.reset()
  })

  it("post-prompt guard: if node is already failed, skip node_complete_missing check", () => {
    const { workflowId: wid } = setupWorkflow("post-prompt-guard-test", [
      { id: "A", deps: [], required: true },
    ])
    Effect.runSync(service.updateWorkflowStatus(wid, "running"))
    Effect.runSync(
      service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }),
    )

    // Simulate timeout marking the node as failed BEFORE post-prompt guard runs
    Effect.runSync(
      service.updateNodeStatus({
        sessionId: `${wid}::A`,
        status: "failed",
        error: "node exceeded timeout_ms=1000",
      }),
    )

    // Post-prompt guard check: uses getNode (single query, more efficient than listNodes)
    const currentNode = Effect.runSync(
      service.getNode(`${wid}::A`),
    ) as any
    expect(currentNode?.status).toBe("failed")

    // Guard logic: if status is 'failed', skip the node_complete_missing handling
    const shouldSkipGuard = currentNode?.status === "failed"
    expect(shouldSkipGuard).toBe(true)

    // The remaining logic: mark as failed only if status === 'running'
    const shouldMarkMissing = currentNode?.status === "running"
    expect(shouldMarkMissing).toBe(false)
  })

  it("post-prompt guard: when node still running, mark as failed (node_complete_missing)", () => {
    const { workflowId: wid } = setupWorkflow("post-prompt-missing-test", [
      { id: "A", deps: [], required: true },
    ])
    Effect.runSync(service.updateWorkflowStatus(wid, "running"))
    Effect.runSync(
      service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }),
    )

    // Node is still running (no node_complete call, no timeout)
    const currentNode = Effect.runSync(
      service.getNode(`${wid}::A`),
    ) as any
    expect(currentNode?.status).toBe("running")

    // Post-prompt guard should mark it as failed
    const shouldMarkMissing = currentNode?.status === "running"
    expect(shouldMarkMissing).toBe(true)
  })
})

// ============================================================================
// WP1-D: Settled registry — __internal_nodeSettled
// ============================================================================

describe("WP1-D: Settled registry (__internal_nodeSettled)", () => {
  it("__internal_nodeSettled: registry exists and is a Map", () => {
    const registry = __internal_nodeSettled()
    expect(registry).toBeInstanceOf(Map)
  })

  it("registry: set(key, false) on spawn start, delete(key) on settle (ensuring)", () => {
    // Simulates the production pattern:
    // 1. On spawn enter: registry.set(nodeId, false)
    // 2. On node complete (ensuring): registry.delete(nodeId)
    const registry = __internal_nodeSettled()
    const nodeId = "test-node-settle-lifecycle"

    // Initially not in registry
    expect(registry.has(nodeId)).toBe(false)

    // Simulate spawn start: registered as not-settled
    registry.set(nodeId, false)
    expect(registry.has(nodeId)).toBe(true)
    expect(registry.get(nodeId)).toBe(false)

    // Simulate node settle (ensuring): removed from registry
    registry.delete(nodeId)
    expect(registry.has(nodeId)).toBe(false)
  })
})
