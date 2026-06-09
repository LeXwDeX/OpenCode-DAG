// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * scenario-27-subdag-lifecycle.test.ts — WP-D3 parent↔child lifecycle bridge.
 *
 * Tests the event-bridge + timeout fallback + cancel cascade + fiber lifecycle.
 * The bridge subscribes to sub-workflow terminal events (`workflow.completed` /
 * `workflow.failed` / `workflow.cancelled`) and translates them to parent-node
 * `handleNodeCompletion` / `handleNodeFailure` calls (reuses existing paths —
 * iron rules #3 #4).
 *
 * Design constraint (matching 009-dag-capability-expansion.md §7 WP-D3):
 * - Tests drive the bridge through the EventBus, NOT through `spawnReadyNode`
 *   fork-fiber (async fibers not synchronously observable).
 * - Parent node status is directly testable via `sessionService.getNode`.
 *
 * Acceptance:
 * - Test A: Sub succeeds → parent completed → parent workflow proceeds.
 * - Test B: Sub fails → parent failed + violation + cascade-skip.
 * - Test C: Parent cancel → sub cascade cancel.
 * - Test D: Sub never converges → timeout → parent node failed + violation
 *           "subdag_timeout" + sub-workflow cancelled.
 * - Test E: Fiber/subscriptions do NOT leak (4 cleanup paths).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Database from "@/storage/db"
import {
  DAGSessionService,
  setEventBus,
  type IDAGSessionService,
  type CreateViolationInput,
} from "../session-service"
import {
  WorkflowEngine,
  unregisterEngine,
  installSubdagLifecycleBridge,
  cleanupSubscriptions,
  __internal_subdagSubscriptions,
} from "../workflow-engine"
import { EventBus } from "../../state-machine/EventBus"
import type { DAGConfig, DAGNodeConfig, DAGViolation, DAGWorkflowSession } from "../types"
import { DEFAULT_SUB_DAG_TIMEOUT_MS } from "../limits"

// ============================================================================
// Helpers
// ============================================================================

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeNodeConfig(id: string): DAGNodeConfig {
  return {
    id,
    name: id,
    dependencies: [],
    required: false,
    worker_type: "general",
    worker_config: { prompt: `Task for ${id}` },
  }
}

function setupParentDagNode(
  dagSessionService: IDAGSessionService,
  parentChatSessionId: string,
  nodeId: string,
  nodeMetadata?: Record<string, unknown>,
) {
  const dagConfig: DAGConfig = {
    name: "parent-wf",
    nodes: [makeNodeConfig(nodeId)],
    max_concurrency: 1,
  }

  const parentWorkflow: DAGWorkflowSession = Effect.runSync(
    dagSessionService.createWorkflow({
      name: dagConfig.name,
      chatSessionId: parentChatSessionId,
      config: dagConfig,
    }),
  )
  Effect.runSync(dagSessionService.updateWorkflowStatus(parentWorkflow.id, "running"))

  const parentNodeId = `${parentWorkflow.id}::${nodeId}`
  Effect.runSync(
    dagSessionService.createNode({
      workflowId: parentWorkflow.id,
      nodeId: parentNodeId,
      name: nodeId,
      nodeName: nodeId,
      nodeType: "dag",
      config: {
        ...dagConfig.nodes[0],
        worker_type: "dag",
        worker_config: {
          subDagConfig: {
            name: "sub-wf",
            nodes: [makeNodeConfig("sub-1")],
            max_concurrency: 1,
          },
        } as unknown as Record<string, unknown>,
      } as DAGNodeConfig,
      dependencyNodes: [],
    }),
  )
  Effect.runSync(dagSessionService.updateNodeStatus({ sessionId: parentNodeId, status: "running" }))
  if (nodeMetadata && dagSessionService.updateNodeMetadata) {
    Effect.runSync(dagSessionService.updateNodeMetadata(parentNodeId, nodeMetadata))
  }
  return { parentWorkflow, parentNodeId }
}

function setupSubWorkflow(dagSessionService: IDAGSessionService, chatSessionId: string) {
  const subConfig: DAGConfig = {
    name: "sub-wf",
    nodes: [makeNodeConfig("sub-1")],
    max_concurrency: 1,
  }
  const subWorkflow: DAGWorkflowSession = Effect.runSync(
    dagSessionService.createWorkflow({
      name: subConfig.name,
      chatSessionId,
      config: subConfig,
    }),
  )
  Effect.runSync(dagSessionService.updateWorkflowStatus(subWorkflow.id, "running"))
  Effect.runSync(
    dagSessionService.createNode({
      workflowId: subWorkflow.id,
      nodeId: `${subWorkflow.id}::sub-1`,
      name: "sub-1",
      nodeName: "sub-1",
      nodeType: "general",
      config: makeNodeConfig("sub-1"),
      dependencyNodes: [],
    }),
  )
  return subWorkflow
}

// ============================================================================
// Tests
// ============================================================================

describe("WP-D3 scenario 27: sub-DAG lifecycle bridge", () => {
  const originalDb = Flag.OPENCODE_DB
  let dagSessionService: IDAGSessionService
  // Test-only: widen to `any` to avoid leaking the extended engine type into the test.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let engine: any
  let eventBus: EventBus

  beforeEach(() => {
    Flag.OPENCODE_DB = ":memory:"
    Database.Client.reset()
    dagSessionService = Effect.runSync(DAGSessionService.make)
    engine = Effect.runSync(WorkflowEngine.make)
    eventBus = new EventBus()
    setEventBus(eventBus)
  })

  afterEach(() => {
    try { Database.close() } catch { /* ignore */ }
    Flag.OPENCODE_DB = originalDb
    Database.Client.reset()
    setEventBus(undefined)
    for (const nodeId of Array.from(__internal_subdagSubscriptions().keys())) {
      cleanupSubscriptions(nodeId)
    }
  })

  it("Test A: sub-workflow completed → parent node completed → parent continues", async () => {
    const { parentWorkflow, parentNodeId } = setupParentDagNode(dagSessionService, "session-A", "D1")
    const subWorkflow = setupSubWorkflow(dagSessionService, "sub-child-session-A")

    installSubdagLifecycleBridge({
      parentWorkflowId: parentWorkflow.id,
      parentNodeId,
      childWorkflowId: subWorkflow.id,
      timeoutMs: DEFAULT_SUB_DAG_TIMEOUT_MS,
      eventBus,
      sessionService: dagSessionService,
      onChildCompleted: (workflowId, nodeId, output) => engine.handleNodeCompletion(workflowId, nodeId, output),
      onChildFailed: (workflowId, nodeId, error) => engine.handleNodeFailure(workflowId, nodeId, error),
      onCancelChild: (id) => engine.cancelWorkflow(id),
      onCreateViolation: (input: CreateViolationInput) => dagSessionService.createViolation(input),
    })

    expect(__internal_subdagSubscriptions().has(parentNodeId)).toBe(true)

    Effect.runSync(dagSessionService.updateWorkflowStatus(subWorkflow.id, "completed"))
    await waitMs(50)

    const parentNode = Effect.runSync(dagSessionService.getNode(parentNodeId))
    expect(parentNode).toBeDefined()
    expect(parentNode!.status).toBe("completed")

    expect(__internal_subdagSubscriptions().has(parentNodeId)).toBe(false)

    unregisterEngine(parentWorkflow.id)
  })

  it("Test B: sub-workflow failed → parent node failed + violation", async () => {
    
    const { parentWorkflow, parentNodeId } = setupParentDagNode(dagSessionService, "session-B", "D1")
    const subWorkflow = setupSubWorkflow(dagSessionService, "sub-child-session-B")

    installSubdagLifecycleBridge({
      parentWorkflowId: parentWorkflow.id,
      parentNodeId,
      childWorkflowId: subWorkflow.id,
      timeoutMs: DEFAULT_SUB_DAG_TIMEOUT_MS,
      eventBus,
      sessionService: dagSessionService,
      onChildCompleted: (workflowId, nodeId, output) => engine.handleNodeCompletion(workflowId, nodeId, output),
      onChildFailed: (workflowId, nodeId, error) => engine.handleNodeFailure(workflowId, nodeId, error),
      onCancelChild: (id) => engine.cancelWorkflow(id),
      onCreateViolation: (input: CreateViolationInput) => dagSessionService.createViolation(input),
    })

    Effect.runSync(dagSessionService.updateWorkflowStatus(subWorkflow.id, "failed"))
    await waitMs(50)

    const parentNode = Effect.runSync(dagSessionService.getNode(parentNodeId))
    expect(parentNode).toBeDefined()
    expect(parentNode!.status).toBe("failed")

    const violations: DAGViolation[] = Effect.runSync(dagSessionService.listViolations(parentWorkflow.id))
    expect(violations.length).toBeGreaterThan(0)
    const parentViolations = violations.filter((v) => v.nodeId === parentNodeId)
    expect(parentViolations.length).toBeGreaterThan(0)

    expect(__internal_subdagSubscriptions().has(parentNodeId)).toBe(false)

    unregisterEngine(parentWorkflow.id)
  })

  it("Test C: parent cancel → cascade cancel on sub-workflow + sub-event fires", async () => {
    
    const chatSession = "session-C"
    const { parentWorkflow, parentNodeId } = setupParentDagNode(dagSessionService, chatSession, "D1", {
      chat_session_id: "sub-child-session-C",
    })
    const subWorkflow = setupSubWorkflow(dagSessionService, "sub-child-session-C")

    installSubdagLifecycleBridge({
      parentWorkflowId: parentWorkflow.id,
      parentNodeId,
      childWorkflowId: subWorkflow.id,
      timeoutMs: DEFAULT_SUB_DAG_TIMEOUT_MS,
      eventBus,
      sessionService: dagSessionService,
      onChildCompleted: (workflowId, nodeId, output) => engine.handleNodeCompletion(workflowId, nodeId, output),
      onChildFailed: (workflowId, nodeId, error) => engine.handleNodeFailure(workflowId, nodeId, error),
      onCancelChild: (id) => engine.cancelWorkflow(id),
      onCreateViolation: (input: CreateViolationInput) => dagSessionService.createViolation(input),
    })

    expect(__internal_subdagSubscriptions().has(parentNodeId)).toBe(true)

    Effect.runSync(engine.cancelWorkflow(parentWorkflow.id))

    const updatedSub = Effect.runSync(dagSessionService.getWorkflow(subWorkflow.id))
    expect(updatedSub).toBeDefined()
    expect(updatedSub!.status).toBe("cancelled")

    await waitMs(50)

    const parentNode = Effect.runSync(dagSessionService.getNode(parentNodeId))
    expect(parentNode).toBeDefined()
    expect(parentNode!.status).toBe("failed")

    expect(__internal_subdagSubscriptions().has(parentNodeId)).toBe(false)
  })

  it("Test D: sub-workflow never converges → timeout → parent node failed + subdag_timeout violation", async () => {
    
    const { parentWorkflow, parentNodeId } = setupParentDagNode(dagSessionService, "session-D", "D1")
    const subWorkflow = setupSubWorkflow(dagSessionService, "sub-child-session-D")

    const shortTimeout = 80

    installSubdagLifecycleBridge({
      parentWorkflowId: parentWorkflow.id,
      parentNodeId,
      childWorkflowId: subWorkflow.id,
      timeoutMs: shortTimeout,
      eventBus,
      sessionService: dagSessionService,
      onChildCompleted: (workflowId, nodeId, output) => engine.handleNodeCompletion(workflowId, nodeId, output),
      onChildFailed: (workflowId, nodeId, error) => engine.handleNodeFailure(workflowId, nodeId, error),
      onCancelChild: (id) => engine.cancelWorkflow(id),
      onCreateViolation: (input: CreateViolationInput) => dagSessionService.createViolation(input),
    })

    expect(__internal_subdagSubscriptions().has(parentNodeId)).toBe(true)

    await waitMs(shortTimeout + 150)

    const parentNode = Effect.runSync(dagSessionService.getNode(parentNodeId))
    expect(parentNode).toBeDefined()
    expect(parentNode!.status).toBe("failed")

    const violations: DAGViolation[] = Effect.runSync(dagSessionService.listViolations(parentWorkflow.id))
    const timeoutViolation = violations.find((v) => v.type === "subdag_timeout")
    expect(timeoutViolation).toBeDefined()
    expect(timeoutViolation!.nodeId).toBe(parentNodeId)

    const updatedSub = Effect.runSync(dagSessionService.getWorkflow(subWorkflow.id))
    expect(updatedSub).toBeDefined()
    expect(updatedSub!.status).toBe("cancelled")

    expect(__internal_subdagSubscriptions().has(parentNodeId)).toBe(false)
  })

  it("Test E: fiber/subscriptions never leak (4 paths: completed / failed / cancelled / timeout)", async () => {
    
    expect(__internal_subdagSubscriptions().size).toBe(0)

    // Path 1: completed
    {
      const { parentWorkflow, parentNodeId } = setupParentDagNode(dagSessionService, "session-E1", "E1")
      const subWorkflow = setupSubWorkflow(dagSessionService, "sub-E1")
      installSubdagLifecycleBridge({
        parentWorkflowId: parentWorkflow.id,
        parentNodeId,
        childWorkflowId: subWorkflow.id,
        timeoutMs: DEFAULT_SUB_DAG_TIMEOUT_MS,
        eventBus,
        sessionService: dagSessionService,
        onChildCompleted: (w, n, o) => engine.handleNodeCompletion(w, n, o),
        onChildFailed: (w, n, e) => engine.handleNodeFailure(w, n, e),
        onCancelChild: (id) => engine.cancelWorkflow(id),
        onCreateViolation: (input: CreateViolationInput) => dagSessionService.createViolation(input),
      })
      expect(__internal_subdagSubscriptions().size).toBe(1)
      Effect.runSync(dagSessionService.updateWorkflowStatus(subWorkflow.id, "completed"))
      await waitMs(30)
      expect(__internal_subdagSubscriptions().size).toBe(0)
    }

    // Path 2: failed
    {
      const { parentWorkflow, parentNodeId } = setupParentDagNode(dagSessionService, "session-E2", "E2")
      const subWorkflow = setupSubWorkflow(dagSessionService, "sub-E2")
      installSubdagLifecycleBridge({
        parentWorkflowId: parentWorkflow.id,
        parentNodeId,
        childWorkflowId: subWorkflow.id,
        timeoutMs: DEFAULT_SUB_DAG_TIMEOUT_MS,
        eventBus,
        sessionService: dagSessionService,
        onChildCompleted: (w, n, o) => engine.handleNodeCompletion(w, n, o),
        onChildFailed: (w, n, e) => engine.handleNodeFailure(w, n, e),
        onCancelChild: (id) => engine.cancelWorkflow(id),
        onCreateViolation: (input: CreateViolationInput) => dagSessionService.createViolation(input),
      })
      expect(__internal_subdagSubscriptions().size).toBe(1)
      Effect.runSync(dagSessionService.updateWorkflowStatus(subWorkflow.id, "failed"))
      await waitMs(30)
      expect(__internal_subdagSubscriptions().size).toBe(0)
    }

    // Path 3: cancelled (via parent cancel)
    {
      const { parentWorkflow, parentNodeId } = setupParentDagNode(dagSessionService, "session-E3", "E3", {
        chat_session_id: "sub-E3-session",
      })
      const subWorkflow = setupSubWorkflow(dagSessionService, "sub-E3-session")
      installSubdagLifecycleBridge({
        parentWorkflowId: parentWorkflow.id,
        parentNodeId,
        childWorkflowId: subWorkflow.id,
        timeoutMs: DEFAULT_SUB_DAG_TIMEOUT_MS,
        eventBus,
        sessionService: dagSessionService,
        onChildCompleted: (w, n, o) => engine.handleNodeCompletion(w, n, o),
        onChildFailed: (w, n, e) => engine.handleNodeFailure(w, n, e),
        onCancelChild: (id) => engine.cancelWorkflow(id),
        onCreateViolation: (input: CreateViolationInput) => dagSessionService.createViolation(input),
      })
      expect(__internal_subdagSubscriptions().size).toBe(1)
      Effect.runSync(engine.cancelWorkflow(parentWorkflow.id))
      await waitMs(30)
      expect(__internal_subdagSubscriptions().size).toBe(0)
    }

    // Path 4: timeout
    {
      const { parentWorkflow, parentNodeId } = setupParentDagNode(dagSessionService, "session-E4", "E4")
      const subWorkflow = setupSubWorkflow(dagSessionService, "sub-E4")
      installSubdagLifecycleBridge({
        parentWorkflowId: parentWorkflow.id,
        parentNodeId,
        childWorkflowId: subWorkflow.id,
        timeoutMs: 60,
        eventBus,
        sessionService: dagSessionService,
        onChildCompleted: (w, n, o) => engine.handleNodeCompletion(w, n, o),
        onChildFailed: (w, n, e) => engine.handleNodeFailure(w, n, e),
        onCancelChild: (id) => engine.cancelWorkflow(id),
        onCreateViolation: (input: CreateViolationInput) => dagSessionService.createViolation(input),
      })
      expect(__internal_subdagSubscriptions().size).toBe(1)
      await waitMs(160)
      expect(__internal_subdagSubscriptions().size).toBe(0)
    }
  })
})
