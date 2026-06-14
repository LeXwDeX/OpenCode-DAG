// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * Scenario 37: WP3 recoverable replan — remove+add replacement
 *
 * When a parent LLM agent replans a workflow to recover from a recoverable
 * node failure, it can remove the recoverable node (+ its downstream) and
 * add replacement nodes in a single atomic replan. After successful replan,
 * scheduleReadyNodes is immediately triggered (forked) to schedule the newly
 * added replacement nodes.
 *
 * Architecture constraints (archgate PASS):
 *   - recoverable nodes are 'removable' (not frozen) — can be removed via replan
 *   - update_nodes targeting recoverable is REJECTED (must use remove+add)
 *   - audit history records recoverable removals
 *   - scheduleReadyNodes fork triggers after replan commit (after replanInFlight cleanup)
 *   - backward compatibility: frozen node behavior zero change
 *
 * Coverage (7 cases minimum):
 *   (a) Regression: replan still rejects remove of all frozen statuses
 *   (b) replan remove recoverable + pending downstream + add replacements → DB correct
 *   (c) scheduleReadyNodes triggers after replan (forked) → spawnedNodes contains replacement
 *   (d) replan remove recoverable + update pending deps to new replacement
 *   (e) replan update_nodes rejects recoverable nodes
 *   (f) replan remove recoverable has audit history row
 *   (g) replan remove mix of pending + recoverable both accepted
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Database from "@/storage/db"
import { DAGSessionService } from "../session-service"
import { WorkflowEngine, __internal_spawnedNodes } from "../workflow-engine"
import { dagWorkflowHistory } from "../../persistence/schema"
import { eq, and } from "drizzle-orm"
import type { DAGConfig, DAGNodeConfig, DAGNodeSession, DAGNodeStatus, DAGWorkflowSession, ReplanPatch, ReplanResult } from "../types"
import {
  classifyReplanNodes,
  validateFrozenAndExistence,
} from "../execution-core"

// ============================================================================
// Helpers
// ============================================================================

function makeNodeConfig(
  id: string,
  deps: string[],
  required: boolean,
  failurePolicy?: 'fail' | 'recoverable',
): DAGNodeConfig {
  const cfg: DAGNodeConfig = {
    id,
    name: id,
    dependencies: deps,
    required,
    worker_type: "general",
    worker_config: { prompt: "test task" },
  }
  if (failurePolicy !== undefined) cfg.failure_policy = failurePolicy
  return cfg
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setupWorkflow(service: any, name: string, nodes: { id: string; deps: string[]; required: boolean; failurePolicy?: 'fail' | 'recoverable' }[]): { workflowId: string; nodeConfigs: DAGNodeConfig[]; workflow: DAGWorkflowSession } {
  const nodeConfigs = nodes.map((n) => makeNodeConfig(n.id, n.deps, n.required, n.failurePolicy))
  const config: DAGConfig = { name, nodes: nodeConfigs, max_concurrency: 3 }
  const workflow = Effect.runSync(
    service.createWorkflow({
      name,
      chatSessionId: `s37-session-${name}-${Date.now()}`,
      config,
    }),
  ) as DAGWorkflowSession
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
  return { workflowId: workflow.id, nodeConfigs, workflow }
}

// ============================================================================
// Test suite
// ============================================================================

describe("Scenario 37: WP3 recoverable replan — remove+add replacement", () => {
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let service: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let engine: any

  beforeEach(() => {
    service = Effect.runSync(DAGSessionService.make)
    engine = Effect.runSync(WorkflowEngine.make)
  })

  // Clear module-level spawnedNodes between tests to avoid cross-contamination
  afterEach(() => {
    __internal_spawnedNodes().clear()
  })

  // --------------------------------------------------------------------------
  // (a) Regression: replan still rejects remove of all frozen statuses
  // --------------------------------------------------------------------------
  it("(a) regression: replan rejects remove of frozen nodes (completed/failed/skipped/running/queued)", () => {
    const frozenStatuses: DAGNodeStatus[] = ['completed', 'failed', 'skipped', 'running', 'queued']
    const nodes: DAGNodeSession[] = frozenStatuses.map((status, i) => ({
      node_id: `wf::n${i}`,
      status,
      config: { required: true },
    } as unknown as DAGNodeSession))

    const { frozenIds, removableIds } = classifyReplanNodes(nodes)
    const currentNodeIds = new Set(nodes.map(n => n.node_id))

    // Every frozen status should produce a reject on remove
    for (const status of frozenStatuses) {
      const idx = frozenStatuses.indexOf(status)
      const patch: ReplanPatch = {
        workflow_id: 'wf',
        remove_nodes: [`wf::n${idx}`],
      }
      const result = validateFrozenAndExistence(patch, frozenIds, currentNodeIds, removableIds)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toMatch(/frozen/i)
      }
    }

    // Also verify: none are in removable (they're frozen, not recoverable)
    expect(removableIds.size).toBe(0)
  })

  // --------------------------------------------------------------------------
  // (b) replan remove recoverable + pending downstream + add replacements
  // --------------------------------------------------------------------------
  it("(b) replan remove recoverable + pending downstream, add replacement nodes → DB correct", () => {
    // Setup: A completed, B recoverable (non-required), C pending (non-required, dep: B)
    const { workflowId } = setupWorkflow(service, "test-37b", [
      { id: "a", deps: [], required: true },
      { id: "b", deps: ["a"], required: false, failurePolicy: "recoverable" },
      { id: "c", deps: ["b"], required: false },
    ])
    const nodeIdA = `${workflowId}::a`
    const nodeIdB = `${workflowId}::b`
    const nodeIdC = `${workflowId}::c`

    // Drive A to completed
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "running" }))
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "completed" }))
    // Drive B to recoverable
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdB, status: "running" }))
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdB, status: "recoverable" }))
    // C stays pending (default, dep on recoverable B unblocks nothing)

    // Replan: remove B and C, add B2 (dep: A) and C2 (dep: B2)
    const result = Effect.runSync(engine.replanWorkflow(workflowId, {
      workflow_id: workflowId,
      remove_nodes: [nodeIdB, nodeIdC],
      add_nodes: [
        { id: "b2", name: "b2", dependencies: ["a"], required: true, worker_type: "general", worker_config: { prompt: "replacement b2" } },
        { id: "c2", name: "c2", dependencies: ["b2"], required: true, worker_type: "general", worker_config: { prompt: "replacement c2" } },
      ],
      changed_by: "scenario-37b",
    })) as ReplanResult

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.nodes_removed).toBe(2)
      expect(result.nodes_added).toBe(2)
      expect(result.final_total).toBe(3) // A + B2 + C2
    }

    // Verify B and C are removed from DB
    expect(Effect.runSync(service.getNode(nodeIdB))).toBeFalsy()
    expect(Effect.runSync(service.getNode(nodeIdC))).toBeFalsy()

    // Verify B2 and C2 exist in DB with correct status
    const nodeB2 = Effect.runSync(service.getNode(`${workflowId}::b2`)) as DAGNodeSession
    expect(nodeB2).toBeTruthy()
    expect(nodeB2.status).toBe("pending")
    expect(nodeB2.dependencies).toEqual([nodeIdA])

    const nodeC2 = Effect.runSync(service.getNode(`${workflowId}::c2`)) as DAGNodeSession
    expect(nodeC2.status).toBe("pending")
    expect(nodeC2.dependencies).toEqual([`${workflowId}::b2`])
  })

  // --------------------------------------------------------------------------
  // (c) scheduleReadyNodes triggers after replan (forked)
  // --------------------------------------------------------------------------
  it("(c) scheduleReadyNodes fork fires after replan — spawnedNodes contains replacement", async () => {
    // Setup: A completed, B recoverable (non-required) → replan removes B, adds B2
    const { workflowId } = setupWorkflow(service, "test-37c", [
      { id: "a", deps: [], required: true },
      { id: "b", deps: ["a"], required: false, failurePolicy: "recoverable" },
    ])
    const nodeIdA = `${workflowId}::a`
    const nodeIdB = `${workflowId}::b`

    // A completed, B recoverable
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "running" }))
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "completed" }))
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdB, status: "running" }))
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdB, status: "recoverable" }))

    // Use runPromise to allow the forked scheduleReadyNodes to execute
    const result = await Effect.runPromise(engine.replanWorkflow(workflowId, {
      workflow_id: workflowId,
      remove_nodes: [nodeIdB],
      add_nodes: [
        { id: "b2", name: "b2", dependencies: ["a"], required: true, worker_type: "general", worker_config: { prompt: "replacement" } },
      ],
      changed_by: "scenario-37c",
    })) as ReplanResult

    expect(result.ok).toBe(true)

    // Wait for the forked scheduleReadyNodes to add B2 to spawnedNodes
    await new Promise(r => setTimeout(r, 100))

    // B2 should be in spawnedNodes (proves scheduleReadyNodes ran and found it ready)
    const spawned = __internal_spawnedNodes()
    expect(spawned.has(`${workflowId}::b2`)).toBe(true)
  })

  // --------------------------------------------------------------------------
  // (d) replan remove recoverable + update pending downstream deps
  // --------------------------------------------------------------------------
  it("(d) replan remove recoverable, update pending deps to new replacement, add replacement", () => {
    // Setup: A completed, B recoverable (non-required), C pending (non-required, dep: B)
    const { workflowId } = setupWorkflow(service, "test-37d", [
      { id: "a", deps: [], required: true },
      { id: "b", deps: ["a"], required: false, failurePolicy: "recoverable" },
      { id: "c", deps: ["b"], required: false },
    ])
    const nodeIdA = `${workflowId}::a`
    const nodeIdB = `${workflowId}::b`
    const nodeIdC = `${workflowId}::c`

    // A completed, B recoverable, C pending
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "running" }))
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "completed" }))
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdB, status: "running" }))
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdB, status: "recoverable" }))

    // Replan: remove B, update C's deps to B2 (short cfg ID), add B2
    const result = Effect.runSync(engine.replanWorkflow(workflowId, {
      workflow_id: workflowId,
      remove_nodes: [nodeIdB],
      update_nodes: [{ node_id: nodeIdC, new_dependencies: ["b2"] }],
      add_nodes: [
        { id: "b2", name: "b2", dependencies: ["a"], required: false, worker_type: "general", worker_config: { prompt: "replacement" } },
      ],
      changed_by: "scenario-37d",
    })) as ReplanResult

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.nodes_removed).toBe(1)
      expect(result.nodes_updated).toBe(1)
      expect(result.nodes_added).toBe(1)
    }

    // B removed
    expect(Effect.runSync(service.getNode(nodeIdB))).toBeFalsy()

    // B2 exists as pending
    const nodeB2 = Effect.runSync(service.getNode(`${workflowId}::b2`)) as DAGNodeSession
    expect(nodeB2).toBeTruthy()
    expect(nodeB2.status).toBe("pending")

    // C's dependencies updated to point to B2
    const nodeC = Effect.runSync(service.getNode(nodeIdC)) as DAGNodeSession
    expect(nodeC.dependencies).toEqual([`${workflowId}::b2`])
  })

  // --------------------------------------------------------------------------
  // (e) replan update_nodes rejects recoverable nodes
  // --------------------------------------------------------------------------
  it("(e) update_nodes targeting recoverable node is rejected (must use remove+add)", () => {
    // Pure function test
    const nodes: DAGNodeSession[] = [
      { node_id: "wf::a", status: "completed", config: { required: true } } as unknown as DAGNodeSession,
      { node_id: "wf::b", status: "recoverable", config: { required: true } } as unknown as DAGNodeSession,
      { node_id: "wf::c", status: "pending", config: { required: true } } as unknown as DAGNodeSession,
    ]

    const { frozenIds, removableIds } = classifyReplanNodes(nodes)
    const currentNodeIds = new Set(nodes.map(n => n.node_id))

    // Try to update the recoverable node B
    const patch: ReplanPatch = {
      workflow_id: 'wf',
      update_nodes: [{ node_id: "wf::b", new_dependencies: ["wf::a"] }],
    }
    const result = validateFrozenAndExistence(patch, frozenIds, currentNodeIds, removableIds)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/removable/i)
    }
  })

  // --------------------------------------------------------------------------
  // (f) replan remove recoverable has audit history row
  // --------------------------------------------------------------------------
  it("(f) replan remove recoverable node produces correct audit history row", () => {
    const { workflowId } = setupWorkflow(service, "test-37f", [
      { id: "a", deps: [], required: true },
      { id: "b", deps: ["a"], required: false, failurePolicy: "recoverable" },
    ])
    const nodeIdA = `${workflowId}::a`
    const nodeIdB = `${workflowId}::b`

    // Drive to A completed + B recoverable
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "running" }))
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "completed" }))
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdB, status: "running" }))
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdB, status: "recoverable" }))

    // Replan: remove recoverable B
    const result = Effect.runSync(engine.replanWorkflow(workflowId, {
      workflow_id: workflowId,
      remove_nodes: [nodeIdB],
      changed_by: "scenario-37f",
    })) as ReplanResult

    expect(result.ok).toBe(true)

    // Verify audit history
    const historyRows = Database.use((db) =>
      db.select()
        .from(dagWorkflowHistory)
        .where(and(
          eq(dagWorkflowHistory.workflow_id, workflowId),
          eq(dagWorkflowHistory.action, "replan"),
        ))
        .all()
    )

    expect(historyRows.length).toBeGreaterThanOrEqual(1)
    const row = historyRows[0]
    expect(row.action).toBe("replan")

    const changeDetails = row.change_details as Record<string, unknown>
    expect(changeDetails).toBeTruthy()
    expect(changeDetails.removed).toContain(nodeIdB)

    // The removed count reflects the recoverable node
    if (result.ok) {
      expect(result.nodes_removed).toBe(1)
    }
  })

  // --------------------------------------------------------------------------
  // (g) replan remove mix of pending + recoverable both accepted
  // --------------------------------------------------------------------------
  it("(g) replan remove_nodes with both pending and recoverable nodes accepted", () => {
    const { workflowId } = setupWorkflow(service, "test-37g", [
      { id: "a", deps: [], required: true },
      { id: "b", deps: ["a"], required: false, failurePolicy: "recoverable" },
      { id: "c", deps: ["a"], required: false },
    ])
    const nodeIdA = `${workflowId}::a`
    const nodeIdB = `${workflowId}::b`
    const nodeIdC = `${workflowId}::c`

    // A completed, B recoverable, C pending
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "running" }))
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdA, status: "completed" }))
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdB, status: "running" }))
    Effect.runSync(service.updateNodeStatus({ sessionId: nodeIdB, status: "recoverable" }))

    // Replan: remove both recoverable B and pending C
    const result = Effect.runSync(engine.replanWorkflow(workflowId, {
      workflow_id: workflowId,
      remove_nodes: [nodeIdB, nodeIdC],
      changed_by: "scenario-37g",
    })) as ReplanResult

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.nodes_removed).toBe(2)
      expect(result.final_total).toBe(1) // only A remains
    }

    // B and C are gone
    expect(Effect.runSync(service.getNode(nodeIdB))).toBeFalsy()
    expect(Effect.runSync(service.getNode(nodeIdC))).toBeFalsy()
  })
})
