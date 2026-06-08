// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * B3 Crash Recovery Integration Tests
 *
 * Exercises `recoverOrphanedWorkflows` across 4 scenarios:
 * 1. no-orphans: empty DB → {scanned: 0, marked: 0}
 * 2. one-orphan: running workflow with no engine → marked failed + violations + node transitions
 * 3. live-not-orphan: running workflow WITH engine registered → untouched
 * 4. partial-progress: some nodes completed before crash → completed preserved, others recovered
 *
 * Infrastructure: Flag.OPENCODE_DB = ":memory:" + Database.Client.reset() for
 * isolated in-memory SQLite per test run.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Database from "@/storage/db"
import { DAGSessionService } from "../session-service"
import { registerEngine, unregisterEngine } from "../workflow-engine"
import type { WorkflowEngine } from "../workflow-engine"
import { recoverOrphanedWorkflows } from "../recovery"
import type { DAGConfig, DAGNodeConfig, DAGNodeSession, DAGWorkflowSession } from "../types"

// ============================================================================
// Helpers
// ============================================================================

function makeNodeConfig(id: string, deps: string[], required: boolean): DAGNodeConfig {
  return {
    id,
    name: id,
    dependencies: deps,
    required,
    worker_type: "general",
    worker_config: {},
  }
}

function setupWorkflow(
  service: {
    readonly createWorkflow: (input: { name: string; chatSessionId: string; config: DAGConfig; metadata?: Record<string, unknown> }) => Effect.Effect<DAGWorkflowSession, unknown>
    readonly createNode: (input: { workflowId: string; nodeId?: string; name: string; nodeName: string; nodeType: string; config: DAGNodeConfig; dependencyNodes?: string[]; timeoutMs?: number; maxRetries?: number }) => Effect.Effect<DAGNodeSession>
  },
  name: string,
  nodes: { id: string; deps: string[]; required: boolean }[],
): { workflowId: string; nodeConfigs: DAGNodeConfig[] } {
  const nodeConfigs = nodes.map((n) => makeNodeConfig(n.id, n.deps, n.required))
  const config: DAGConfig = {
    name,
    nodes: nodeConfigs,
    max_concurrency: 3,
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
  return { workflowId: workflow.id, nodeConfigs }
}

// ============================================================================
// Tests
// ============================================================================

describe("recoverOrphanedWorkflows", () => {
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

  it("no-orphans: empty DB → scanned=0, marked=0", () => {
    const service = Effect.runSync(DAGSessionService.make)
    const result = Effect.runSync(recoverOrphanedWorkflows(service))
    expect(result.scanned).toBe(0)
    expect(result.marked).toBe(0)
  })

  it("one-orphan: running workflow with no engine → marked failed with violations and node transitions", () => {
    const service = Effect.runSync(DAGSessionService.make)

    // Setup: 1 workflow with 3 nodes (A running, B queued, C pending)
    const { workflowId } = setupWorkflow(service, "orphan-test", [
      { id: "A", deps: [], required: true },
      { id: "B", deps: ["A"], required: true },
      { id: "C", deps: ["B"], required: false },
    ])
    const wid = workflowId

    // Push workflow to running
    Effect.runSync(service.updateWorkflowStatus(wid, "running"))
    // A → running
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::A`, status: "running" }))
    // B → queued
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::B`, status: "queued" }))
    // C stays pending (default)

    // NO engine registered → orphan

    // Run recovery
    const result = Effect.runSync(recoverOrphanedWorkflows(service))

    // Assertions
    expect(result.scanned).toBe(1)
    expect(result.marked).toBe(1)

    // Workflow is now failed
    const wfAfter = Effect.runSync(service.getWorkflow(wid))
    expect(wfAfter?.status).toBe("failed")

    // Violation created
    const violations = Effect.runSync(service.listViolations(wid))
    const orphanViolations = violations.filter(v => v.type === 'process_orphan')
    expect(orphanViolations.length).toBe(1)
    expect(orphanViolations[0].severity).toBe('critical')

    // Node transitions
    const nodes = Effect.runSync(service.listNodes(wid))
    const nodeMap = new Map(nodes.map((n) => [n.node_id, n.status] as const))
    expect(nodeMap.get(`${wid}::A`)).toBe("failed")   // running → failed
    expect(nodeMap.get(`${wid}::B`)).toBe("skipped")  // queued → skipped
    expect(nodeMap.get(`${wid}::C`)).toBe("skipped")  // pending → skipped
  })

  it("live-not-orphan: running workflow WITH engine → left untouched", () => {
    const service = Effect.runSync(DAGSessionService.make)

    const { workflowId } = setupWorkflow(service, "live-test", [
      { id: "X", deps: [], required: true },
    ])
    const wid = workflowId

    // Push workflow to running
    Effect.runSync(service.updateWorkflowStatus(wid, "running"))
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::X`, status: "running" }))

    // Register a fake engine (marks workflow as live)
    const fakeEngine = {
      startWorkflow: () => Effect.succeed({}),
      scheduleReadyNodes: () => Effect.succeed({}),
      handleNodeCompletion: () => Effect.succeed({}),
      handleNodeFailure: () => Effect.succeed({}),
      cancelWorkflow: () => Effect.succeed({}),
      getWorkflowStatus: () => Effect.succeed({} as any),
      replanWorkflow: () => Effect.succeed({} as any),
      pauseWorkflow: () => Effect.succeed('paused' as any),
      resumeWorkflow: () => Effect.succeed('running' as any),
    } as WorkflowEngine
    registerEngine(wid, fakeEngine)

    // Run recovery
    const result = Effect.runSync(recoverOrphanedWorkflows(service))

    // Assertions — workflow NOT touched
    expect(result.marked).toBe(0)

    const wfAfter = Effect.runSync(service.getWorkflow(wid))
    expect(wfAfter?.status).toBe("running")

    // No violations created
    const violations = Effect.runSync(service.listViolations(wid))
    expect(violations.filter(v => v.type === 'process_orphan').length).toBe(0)

    // Cleanup: transition to terminal state before unregistering so the
    // workflow doesn't leak as an orphan into subsequent tests.
    Effect.runSync(service.updateWorkflowStatus(wid, "completed"))
    unregisterEngine(wid)
  })

  it("partial-progress: completed nodes preserved, running→failed, pending→skipped", () => {
    const service = Effect.runSync(DAGSessionService.make)

    const { workflowId } = setupWorkflow(service, "partial-test", [
      { id: "P", deps: [], required: true },
      { id: "Q", deps: ["P"], required: true },
      { id: "R", deps: ["Q"], required: false },
    ])
    const wid = workflowId

    // P completed, Q running, R pending (simulates partial progress before crash)
    Effect.runSync(service.updateWorkflowStatus(wid, "running"))
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::P`, status: "running" }))
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::P`, status: "completed" }))
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::Q`, status: "running" }))
    // R stays pending

    // Run recovery
    const result = Effect.runSync(recoverOrphanedWorkflows(service))
    expect(result.marked).toBe(1)

    // Check node states
    const nodes = Effect.runSync(service.listNodes(wid))
    const nodeMap = new Map(nodes.map((n) => [n.node_id, n.status] as const))
    expect(nodeMap.get(`${wid}::P`)).toBe("completed") // preserved
    expect(nodeMap.get(`${wid}::Q`)).toBe("failed")    // running → failed
    expect(nodeMap.get(`${wid}::R`)).toBe("skipped")   // pending → skipped
  })
})
