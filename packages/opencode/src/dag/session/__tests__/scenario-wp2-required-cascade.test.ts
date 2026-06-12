// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * Scenario WP2: required-node cascade-skip violation.
 *
 * Validates:
 * - When a condition-false skip cascades into a `required: true` node,
 *   a `required_node_skipped` violation (severity: error) is recorded.
 * - The cascade-skipped required node ends in status='skipped'.
 * - Workflow still converges to 'completed' (iron law #2: terminal-irreversibility;
 *   computeFinalWorkflowStatus checks for required FAILED, not required SKIPPED).
 * - This is an AUDIT-ONLY contract — see required-nodes-monitor.ts:172-173.
 *
 * Topology:
 *   ROOT → optional-check (required:false, no condition)
 *        → condition-gate (required:false, condition ref_node=optional-check, op=eq, value="block")
 *        → final-report (required:true, dependencies=[condition-gate])
 *
 * flow:
 *   1. ROOT completes → optional-check no condition → runs
 *   2. optional-check completes with output "other-value"
 *   3. condition-gate's condition (eq "block") evaluates false → skipped
 *   4. cascade: final-report (required:true, depends on condition-gate) is skipped
 *   5. violation: `required_node_skipped` severity=error recorded for final-report
 *   6. workflow converges to completed (no required node FAILED)
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Database from "@/storage/db"
import { DAGSessionService } from "../session-service"
import { WorkflowEngine } from "../workflow-engine"
import type {
  DAGConfig,
  DAGNodeConfig,
  DAGNodeSession,
  DAGWorkflowSession,
  DAGNodeCondition,
} from "../types"

function makeNodeConfig(
  id: string,
  deps: string[],
  required: boolean,
  condition?: DAGNodeCondition,
): DAGNodeConfig {
  return {
    id,
    name: id,
    dependencies: deps,
    required,
    worker_type: "general",
    worker_config: {},
    condition,
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

describe("WP2: required-node cascade-skip records required_node_skipped violation", () => {
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

  it("cascade-skipped required node produces required_node_skipped violation (severity error) and workflow still completes", () => {
    const service = Effect.runSync(DAGSessionService.make)
    const engine = Effect.runSync(WorkflowEngine.make)

    // Topology:
    //   ROOT → optional-check (required:false)
    //        → condition-gate (required:false, condition ref optional-check op=eq value="block")
    //        → final-report (required:true, deps=[condition-gate])
    const nodeConfigs = [
      makeNodeConfig("ROOT", [], false),
      makeNodeConfig("optional-check", ["ROOT"], false),
      makeNodeConfig("condition-gate", ["optional-check"], false, {
        ref_node: "optional-check",
        op: "eq",
        value: "block",
      }),
      makeNodeConfig("final-report", ["condition-gate"], true),
    ]
    const { workflowId: wid } = setupWorkflow(service, "wp2-required-cascade", nodeConfigs)

    Effect.runSync(service.updateWorkflowStatus(wid, "running"))

    // ROOT completes with arbitrary output
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::ROOT`, status: "running" }))
    Effect.runSync(engine.handleNodeCompletion(wid, `${wid}::ROOT`, "go"))

    // After handleNodeCompletion(ROOT), scheduleReadyNodes runs:
    //   - optional-check no condition → executeList (fork-spawn triggered)
    // ROOT is complete; optional-check now pending-but-ready.
    // Manually complete optional-check with output that makes condition-gate FALSE.
    Effect.runSync(service.updateNodeStatus({ sessionId: `${wid}::optional-check`, status: "running" }))
    Effect.runSync(engine.handleNodeCompletion(wid, `${wid}::optional-check`, "other-value"))

    // Now condition-gate evaluates: ref optional-check="other-value", op eq "block" → false → skipped
    // cascade: final-report (required:true, depends on condition-gate) is skipped
    const nodes = Effect.runSync(service.listNodes(wid))
    const nodeMap = new Map(nodes.map((n) => [n.node_id, n] as const))

    expect(nodeMap.get(`${wid}::optional-check`)!.status).toBe("completed")
    expect(nodeMap.get(`${wid}::condition-gate`)!.status).toBe("skipped")
    expect(nodeMap.get(`${wid}::final-report`)!.status).toBe("skipped")

    // Violation: required_node_skipped with severity=error for final-report
    const violations = Effect.runSync(service.listViolations(wid))
    const requiredSkipViolation = violations.find(
      (v) => v.nodeId === `${wid}::final-report` && v.type === "required_node_skipped",
    )
    expect(requiredSkipViolation).toBeDefined()
    expect(requiredSkipViolation!.severity).toBe("error")
    expect(requiredSkipViolation!.message).toContain("final-report")

    // Workflow converges to 'completed' (iron law #2: computeFinalWorkflowStatus
    // only marks workflow 'failed' if a required node FAILED, not SKIPPED)
    const wfAfter = Effect.runSync(service.getWorkflow(wid))
    expect(wfAfter?.status).toBe("completed")
  })
})
