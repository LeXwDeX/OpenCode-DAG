// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * @file DAG Query Tests — listWorkflowsByChatSession
 * @description 验证 DAGQuery.listWorkflowsByChatSession 正确委托 sessionService 并按 chat_session_id 过滤
 *
 * Acceptance:
 * - [x] listWorkflowsByChatSession("chat-1") → 返回匹配 workflows
 * - [x] listWorkflowsByChatSession("nonexistent") → 返回 []
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { Effect } from "effect"
import { DAGQuery } from "../dag-query"
import type { IDAGSessionService } from "../../session/session-service"
import type { DAGWorkflowSession } from "../../session/types"
import type { DAGConfig } from "../../session/types"

// ============================================================================
// Test Helpers
// ============================================================================

function makeMockWorkflowSession(overrides: Partial<DAGWorkflowSession> = {}): DAGWorkflowSession {
  return {
    id: "wf-1",
    chat_session_id: "chat-1",
    config: { name: "Test Workflow", nodes: [], max_concurrency: 3 } as DAGConfig,
    status: "running",
    node_sessions: {},
    violations: [],
    metadata: {},
    start_time: 1700000000000,
    end_time: null,
    current_node: null,
    created_at: 1700000000000,
    updated_at: 1700000000000,
    completed_at: null,
    duration_ms: null,
    ...overrides,
  }
}

function makeMockService(workflows: DAGWorkflowSession[]): IDAGSessionService {
  return {
    createWorkflow: () => Effect.die("not implemented"),
    getWorkflow: () => Effect.succeed(undefined),
    listWorkflowsByChatSession: (chatSessionId: string) =>
      Effect.succeed(workflows.filter((w) => w.chat_session_id === chatSessionId)),
    listAllWorkflows: () => Effect.succeed([]),
    updateWorkflowStatus: () => Effect.succeed(undefined),
    createNode: () => Effect.die("not implemented"),
    getNode: () => Effect.succeed(undefined),
    listNodes: () => Effect.succeed([]),
    updateNodeStatus: () => Effect.succeed(undefined),
    createViolation: () => Effect.die("not implemented"),
    listViolations: (workflowId: string) =>
      Effect.succeed(workflowId === "wf-with-violations"
        ? [{
            id: "v-1",
            workflowId,
            type: "required_node_failed",
            severity: "error",
            message: "boom",
            timestamp: "2026-01-01T00:00:00.000Z",
          }]
        : []),
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe("DAGQuery.listWorkflowsByChatSession", () => {
  const wfChat1 = makeMockWorkflowSession({ id: "wf-1", chat_session_id: "chat-1" })
  const wfChat2 = makeMockWorkflowSession({ id: "wf-2", chat_session_id: "chat-2" })
  const wfChat1Again = makeMockWorkflowSession({ id: "wf-3", chat_session_id: "chat-1" })
  let query: DAGQuery

  beforeEach(() => {
    const service = makeMockService([wfChat1, wfChat2, wfChat1Again])
    query = new DAGQuery(service)
  })

  test("returns workflows matching chat_session_id", async () => {
    const result = await query.listWorkflowsByChatSession("chat-1")
    expect(result).toHaveLength(2)
    expect(result.map((w) => w.id).sort()).toEqual(["wf-1", "wf-3"])
    result.forEach((w) => expect(w.chat_session_id).toBe("chat-1"))
  })

  test("returns [] when no workflows match chat_session_id", async () => {
    const result = await query.listWorkflowsByChatSession("nonexistent")
    expect(result).toHaveLength(0)
    expect(result).toEqual([])
  })
})

describe("DAGQuery.listViolations", () => {
  test("delegates to sessionService.listViolations and returns workflow's violations", async () => {
    const query = new DAGQuery(makeMockService([]))
    const result = await query.listViolations("wf-with-violations")
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe("v-1")
    expect(result[0]!.type).toBe("required_node_failed")
  })

  test("returns [] when workflow has no violations", async () => {
    const query = new DAGQuery(makeMockService([]))
    const result = await query.listViolations("other-wf")
    expect(result).toEqual([])
  })
})
