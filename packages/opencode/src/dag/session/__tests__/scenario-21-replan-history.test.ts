/**
 * Scenario 21: replanWorkflow — dag_workflow_history DB state verification
 *
 * Integration test that exercises the full replan pipeline against a real
 * in-memory SQLite database. Verifies that after a successful replan, the
 * `dag_workflow_history` table contains exactly one row with action='replan'
 * and correct old_state / new_state / change_details JSON.
 *
 * Infrastructure:
 * - Flag.OPENCODE_DB = ":memory:" enables in-memory SQLite (db.ts:39-41)
 * - Database.Client.reset() forces re-initialization with the in-memory DB
 * - Migrations auto-apply from packages/opencode/migration/ (including DAG tables)
 * - DAGSessionService.make and WorkflowEngine.make run via Effect.runSync
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Database from "@/storage/db"
import { DAGSessionService } from "../session-service"
import { WorkflowEngine } from "../workflow-engine"
import { dagWorkflowHistory } from "../../persistence/schema"
import { eq, and } from "drizzle-orm"
import type { DAGConfig, DAGNodeConfig } from "../types"

// ============================================================================
// Test helpers
// ============================================================================

function makeNodeConfig(id: string, deps: string[] = []): DAGNodeConfig {
  return {
    id,
    name: id,
    dependencies: deps,
    required: false,
    worker_type: "mock",
    worker_config: {},
  }
}

// ============================================================================
// Scenario 21
// ============================================================================

describe("Scenario 21: replanWorkflow — dag_workflow_history verification", () => {
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

  it("writes exactly one replan row with correct old/new state JSON after removing n3 from a 3-node chain", async () => {
    // ── 1. Initialize services via Effect ──
    const sessionService = Effect.runSync(DAGSessionService.make)
    const engine = Effect.runSync(WorkflowEngine.make)

    const CHAT_SESSION = "test-chat-session-s21"

    // ── 2. Create a workflow with 3 nodes: n1 → n2 → n3 ──
    const n1Cfg = makeNodeConfig("n1")
    const n2Cfg = makeNodeConfig("n2", ["n1"])
    const n3Cfg = makeNodeConfig("n3", ["n2"])

    const config: DAGConfig = {
      name: "scenario-21-workflow",
      nodes: [n1Cfg, n2Cfg, n3Cfg],
      max_concurrency: 3,
    }

    const workflow = Effect.runSync(sessionService.createWorkflow({
      name: "scenario-21-workflow",
      chatSessionId: CHAT_SESSION,
      config,
    }))
    const workflowId = workflow.id

    // ── 3. Create the 3 nodes with namespaced IDs ──
    Effect.runSync(sessionService.createNode({
      workflowId,
      nodeId: `${workflowId}::n1`,
      name: "n1",
      nodeName: "n1",
      nodeType: "mock",
      config: n1Cfg,
    }))
    Effect.runSync(sessionService.createNode({
      workflowId,
      nodeId: `${workflowId}::n2`,
      name: "n2",
      nodeName: "n2",
      nodeType: "mock",
      config: n2Cfg,
      dependencyNodes: [`${workflowId}::n1`],
    }))
    Effect.runSync(sessionService.createNode({
      workflowId,
      nodeId: `${workflowId}::n3`,
      name: "n3",
      nodeName: "n3",
      nodeType: "mock",
      config: n3Cfg,
      dependencyNodes: [`${workflowId}::n2`],
    }))

    // Verify all 3 nodes exist before replan
    const nodesBefore = Effect.runSync(sessionService.listNodes(workflowId))
    expect(nodesBefore).toHaveLength(3)

    // ── 4. Run replan: remove n3 ──
    const result = Effect.runSync(engine.replanWorkflow(workflowId, {
      workflow_id: workflowId,
      remove_nodes: [`${workflowId}::n3`],
    }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.nodes_removed).toBe(1)
      expect(result.final_total).toBe(2)
    }

    // ── 5. Direct DB query: dag_workflow_history ──
    const historyRows = Database.use((db) =>
      db.select()
        .from(dagWorkflowHistory)
        .where(and(
          eq(dagWorkflowHistory.workflow_id, workflowId),
          eq(dagWorkflowHistory.action, "replan"),
        ))
        .all()
    )

    // ── 6. Assert: exactly 1 row ──
    expect(historyRows).toHaveLength(1)

    const row = historyRows[0]

    // action === 'replan'
    expect(row.action).toBe("replan")

    // workflow_id matches
    expect(row.workflow_id).toBe(workflowId)

    // change_details contains removed: ['workflowId::n3']
    const changeDetails = row.change_details as Record<string, unknown>
    expect(changeDetails).toBeTruthy()
    expect(changeDetails.removed).toEqual([`${workflowId}::n3`])

    // old_state has config field (valid JSON object)
    const oldState = row.old_state as Record<string, unknown>
    expect(oldState).toBeTruthy()
    expect(oldState.config).toBeTruthy()
    expect((oldState.config as DAGConfig).nodes).toHaveLength(3)
    expect((oldState.config as DAGConfig).nodes.map((n) => n.id)).toEqual(["n1", "n2", "n3"])

    // new_state has config field (valid JSON object, nodes reduced to 2)
    const newState = row.new_state as Record<string, unknown>
    expect(newState).toBeTruthy()
    expect(newState.config).toBeTruthy()
    expect((newState.config as DAGConfig).nodes).toHaveLength(2)
    expect((newState.config as DAGConfig).nodes.map((n) => n.id)).toEqual(["n1", "n2"])

    // created_at is a valid recent timestamp (within last 60 seconds)
    expect(row.created_at).toBeGreaterThan(Date.now() - 60_000)
    expect(row.created_at).toBeLessThanOrEqual(Date.now())
  })
})
