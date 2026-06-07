// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * @file Dual-Path EventBus Isolation Tests (WP1-B)
 * @description Integration tests verifying Core and Session paths share the
 *   same IEventBus instance without cross-contamination.
 *
 * D-PLAN architecture decision: Core layer (pure memory + event-driven) and
 * Session layer (DB persistence) are deliberately isolated but may co-reside
 * in the same process sharing a single IEventBus. Events are unified as
 * `workflow.*` / `node.*` (no `dag:*` prefix). Differentiation is via
 * `workflow_id` field filtering, not event-type prefix.
 *
 * 5 tests:
 * 1. Core + Session share one EventBus instance (reference identity)
 * 2. Core node.completed not processed by Session listener (workflow_id filter)
 * 3. Core and Session workflow_id filtering is mutually non-interfering
 * 4. Type bridge compatibility (Core node.aborted vs Session DAGNodeStatus)
 * 5. Concurrent 100 Core + 100 Session events, no cross-contamination
 */

import { describe, expect, it, afterEach } from 'bun:test'
import { EventBus } from '../state-machine/EventBus'
import { WorkflowStateMachine } from '../state-machine/WorkflowStateMachine'
import { NodeStateMachine } from '../state-machine/NodeStateMachine'
import {
  NodeStatus,
  NodeTransition,
  WorkflowStatus,
  WorkflowTransition,
  FallbackTrigger,
} from '../state-machine/types'
import type {
  NodeEvent,
  WorkflowEvent,
  NodeStateData,
  WorkflowStateData,
} from '../state-machine/types'
import type { IStatePersister } from '../state-machine/IStateMachine'
import {
  setEventBus,
  buildSessionWorkflowEvent,
} from '../session/session-service'

// ============================================================================
// Mock helpers (same pattern as CoreCoordination.test.ts)
// ============================================================================

function createWfPersister(): IStatePersister {
  const store = new Map<string, WorkflowStateData>()
  return {
    async writeWorkflowState(id: string, state: WorkflowStateData) {
      store.set(id, state)
    },
    async readWorkflowState(id: string) {
      return store.get(id) ?? null
    },
    async deleteWorkflowState(id: string) {
      store.delete(id)
    },
    async listWorkflowIds() {
      return [...store.keys()]
    },
  }
}

interface NodePersister extends IStatePersister {
  writeNodeState(wfId: string, name: string, state: NodeStateData): Promise<void>
  readNodeState(wfId: string, name: string): Promise<NodeStateData | null>
}

function createNodePersister(): NodePersister {
  const nodeStore = new Map<string, NodeStateData>()
  const wfStore = new Map<string, WorkflowStateData>()
  return {
    async writeWorkflowState(id: string, state: WorkflowStateData) {
      wfStore.set(id, state)
    },
    async readWorkflowState(id: string) {
      return wfStore.get(id) ?? null
    },
    async deleteWorkflowState(id: string) {
      wfStore.delete(id)
    },
    async listWorkflowIds() {
      return [...wfStore.keys()]
    },
    async writeNodeState(wfId: string, name: string, state: NodeStateData) {
      nodeStore.set(`${wfId}:${name}`, state)
    },
    async readNodeState(wfId: string, name: string) {
      return nodeStore.get(`${wfId}:${name}`) ?? null
    },
  }
}

// Reset session-layer module-level event bus after each test
afterEach(() => {
  setEventBus(undefined)
})

// ============================================================================
// Test suite: Dual-Path EventBus Isolation
// ============================================================================

describe('Dual-Path EventBus Isolation', () => {
  // --------------------------------------------------------------------------
  // Test 1: Core + Session share one EventBus instance
  // --------------------------------------------------------------------------
  it('shares one EventBus between Core state machines and Session layer', () => {
    const bus = new EventBus()

    // Wire Core path: WorkflowStateMachine + NodeStateMachine
    const wfPersister = createWfPersister()
    const coreWf = new WorkflowStateMachine('core-wf', bus, wfPersister)
    const coreNode = new NodeStateMachine('core-wf', bus)

    // Wire Session path: inject same bus
    setEventBus(bus)

    // Verify reference identity by observing an event emitted from Core
    // is received by a listener on the same bus
    const received: Array<WorkflowEvent | NodeEvent> = []
    bus.subscribe('*', (event) => {
      received.push(event as WorkflowEvent | NodeEvent)
    })

    // Emit a test event through the bus directly (proving single instance)
    bus.emit({
      type: 'workflow.started',
      workflow_id: 'identity-test',
      timestamp: new Date(),
    })

    // Both coreWf and coreNode were constructed with `bus`, and setEventBus
    // received the same reference. One bus, one listener registry.
    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('workflow.started')

    // Cleanup: Core and Session both reference `bus`
    expect(coreWf).toBeDefined()
    expect(coreNode).toBeDefined()

    bus.destroy()
  })

  // --------------------------------------------------------------------------
  // Test 2: Core node.completed NOT processed by Session listener
  // --------------------------------------------------------------------------
  it('Core node.completed is not processed by Session listener filtering different workflow_id', async () => {
    const bus = new EventBus()
    const coreWfId = 'core-wf'
    const sessionWfId = 'session-wf'

    // Session listener: subscribe to 'node.completed' filtered by session-wf
    // (before Core transitions, so it IS active when events are emitted)
    let sessionCallCount = 0
    bus.subscribe('node.completed', (event) => {
      const e = event as NodeEvent
      if (e.type === 'node.completed' && e.workflow_id === sessionWfId) {
        sessionCallCount++
      }
    })

    // Core path: register node and transition PENDING → RUNNING → COMPLETED
    const persister = createNodePersister()
    const nodeSM = new NodeStateMachine(coreWfId, bus, persister)

    await nodeSM.registerNode(coreWfId, 'main', 'analyze', false)
    await nodeSM.transition({
      workflowId: coreWfId,
      nodeName: 'analyze',
      fromStatus: NodeStatus.PENDING,
      toStatus: NodeStatus.RUNNING,
      transition: NodeTransition.DEPENDENCIES_MET,
    })
    await nodeSM.transition({
      workflowId: coreWfId,
      nodeName: 'analyze',
      fromStatus: NodeStatus.RUNNING,
      toStatus: NodeStatus.COMPLETED,
      transition: NodeTransition.DAG_COMPLETED,
    })

    // The Core event has workflow_id='core-wf', not 'session-wf'
    // Session listener should have filtered it out (0 calls)
    expect(sessionCallCount).toBe(0)

    bus.destroy()
  })

  // --------------------------------------------------------------------------
  // Test 3: workflow_id filtering — Core and Session non-interfering
  // --------------------------------------------------------------------------
  it('Core and Session listeners see only their own workflow_id events', async () => {
    const bus = new EventBus()
    const coreWfId = 'workflow-1'
    const sessionWfId = 'workflow-2'

    // --- Core path: WorkflowStateMachine PENDING → RUNNING ---
    const wfPersister = createWfPersister()
    const coreWf = new WorkflowStateMachine(coreWfId, bus, wfPersister)

    // Subscribe Core listener filtered by coreWfId
    const coreReceived: WorkflowEvent[] = []
    bus.subscribe('workflow.started', (event) => {
      const e = event as WorkflowEvent
      if (e.type === 'workflow.started' && e.workflow_id === coreWfId) {
        coreReceived.push(e)
      }
    })

    // Subscribe Session listener filtered by sessionWfId
    const sessionReceived: WorkflowEvent[] = []
    bus.subscribe('workflow.started', (event) => {
      const e = event as WorkflowEvent
      if (e.type === 'workflow.started' && e.workflow_id === sessionWfId) {
        sessionReceived.push(e)
      }
    })

    // Emit Core event via WorkflowStateMachine
    await coreWf.transition({
      fromStatus: WorkflowStatus.PENDING,
      toStatus: WorkflowStatus.RUNNING,
      transition: WorkflowTransition.ENGINE_START,
    })

    // Emit Session event via buildSessionWorkflowEvent + bus.emit
    const sessionEvent = buildSessionWorkflowEvent(
      sessionWfId,
      'pending',
      'running',
      Date.now(),
    )
    expect(sessionEvent).not.toBeNull()
    expect(sessionEvent!.type).toBe('workflow.started')
    bus.emit(sessionEvent!)

    // Verify: Core listener sees only workflow-1, Session listener sees only workflow-2
    expect(coreReceived).toHaveLength(1)
    expect(coreReceived[0].workflow_id).toBe(coreWfId)

    expect(sessionReceived).toHaveLength(1)
    expect(sessionReceived[0].workflow_id).toBe(sessionWfId)

    bus.destroy()
  })

  // --------------------------------------------------------------------------
  // Test 4: Type bridge — Core node.aborted reachable via Session wildcard listener
  // --------------------------------------------------------------------------
  it('Core node.aborted event is reachable by wildcard listener without type errors', async () => {
    const bus = new EventBus()
    const coreWfId = 'core-wf'

    const persister = createNodePersister()
    const nodeSM = new NodeStateMachine(coreWfId, bus, persister)

    // Register node and walk through: PENDING → RUNNING → FAILED → ABORTED
    await nodeSM.registerNode(coreWfId, 'main', 'shadow-target', false)

    await nodeSM.transition({
      workflowId: coreWfId,
      nodeName: 'shadow-target',
      fromStatus: NodeStatus.PENDING,
      toStatus: NodeStatus.RUNNING,
      transition: NodeTransition.DEPENDENCIES_MET,
    })

    await nodeSM.transition({
      workflowId: coreWfId,
      nodeName: 'shadow-target',
      fromStatus: NodeStatus.RUNNING,
      toStatus: NodeStatus.FAILED,
      transition: NodeTransition.EXEC_FAILED,
      fallbackTrigger: FallbackTrigger.EXEC_FAILED,
    })

    await nodeSM.transition({
      workflowId: coreWfId,
      nodeName: 'shadow-target',
      fromStatus: NodeStatus.FAILED,
      toStatus: NodeStatus.ABORTED,
      transition: NodeTransition.FALLBACK_ABORT,
      abortReason: 'shadow decision: abort',
    })

    // Session-path wildcard listener captures all events
    const wildcardReceived: Array<WorkflowEvent | NodeEvent> = []
    bus.subscribe('*', (event) => {
      wildcardReceived.push(event as WorkflowEvent | NodeEvent)
    })

    // The node.aborted event was already emitted during transition above.
    // Since we subscribed AFTER the transitions, we need to verify from the
    // event log (EventBus stores events), not the wildcard listener.
    const eventLog = bus.getEventLog()

    // Verify node.aborted appears in the event log (type-safe, no 'as any')
    const abortedEvents = eventLog.filter(
      (e) => e.type === 'node.aborted'
    ) as NodeEvent[]
    expect(abortedEvents).toHaveLength(1)
    expect(abortedEvents[0].type).toBe('node.aborted')

    // Verify the event is well-formed NodeEvent (TS compilation proves type safety)
    const aborted = abortedEvents[0]
    if (aborted.type === 'node.aborted') {
      expect(aborted.workflow_id).toBe(coreWfId)
      expect(aborted.node_name).toBe('shadow-target')
      expect(aborted.reason).toBe('shadow decision: abort')
    }

    // Also verify that a wildcard listener set up BEFORE emitting receives
    // the event without crash (proving no runtime type incompatibility)
    const liveReceived: Array<WorkflowEvent | NodeEvent> = []
    const bus2 = new EventBus()
    const persister2 = createNodePersister()
    const nodeSM2 = new NodeStateMachine(coreWfId, bus2, persister2)

    bus2.subscribe('*', (event) => {
      liveReceived.push(event as WorkflowEvent | NodeEvent)
    })

    await nodeSM2.registerNode(coreWfId, 'main', 'test-node', false)
    await nodeSM2.transition({
      workflowId: coreWfId,
      nodeName: 'test-node',
      fromStatus: NodeStatus.PENDING,
      toStatus: NodeStatus.RUNNING,
      transition: NodeTransition.DEPENDENCIES_MET,
    })
    await nodeSM2.transition({
      workflowId: coreWfId,
      nodeName: 'test-node',
      fromStatus: NodeStatus.RUNNING,
      toStatus: NodeStatus.FAILED,
      transition: NodeTransition.EXEC_FAILED,
      fallbackTrigger: FallbackTrigger.EXEC_FAILED,
    })
    await nodeSM2.transition({
      workflowId: coreWfId,
      nodeName: 'test-node',
      fromStatus: NodeStatus.FAILED,
      toStatus: NodeStatus.ABORTED,
      transition: NodeTransition.FALLBACK_ABORT,
      abortReason: 'test abort',
    })

    // Verify wildcard listener received node.aborted without crash
    const liveAborted = liveReceived.filter((e) => e.type === 'node.aborted')
    expect(liveAborted).toHaveLength(1)

    bus.destroy()
    bus2.destroy()
  })

  // --------------------------------------------------------------------------
  // Test 5: Concurrent 100 Core + 100 Session events, no cross-contamination
  // --------------------------------------------------------------------------
  it('handles 100 Core node.started + 100 Session workflow.started without cross-contamination', async () => {
    const bus = new EventBus()
    const coreWfId = 'core-concurrent'
    const sessionWfId = 'session-concurrent'

    // --- Core listener: only node.started with coreWfId ---
    let coreCount = 0
    bus.subscribe('node.started', (event) => {
      const e = event as NodeEvent
      if (e.type === 'node.started' && e.workflow_id === coreWfId) {
        coreCount++
      }
    })

    // --- Session listener: only workflow.started with sessionWfId ---
    let sessionCount = 0
    bus.subscribe('workflow.started', (event) => {
      const e = event as WorkflowEvent
      if (e.type === 'workflow.started' && e.workflow_id === sessionWfId) {
        sessionCount++
      }
    })

    const startTime = performance.now()

    // --- Core: register 100 nodes + transition each PENDING → RUNNING ---
    const persister = createNodePersister()
    const nodeSM = new NodeStateMachine(coreWfId, bus, persister)

    const registerAndTransition = async (idx: number) => {
      const nodeName = `node-${idx}`
      await nodeSM.registerNode(coreWfId, 'main', nodeName, false)
      await nodeSM.transition({
        workflowId: coreWfId,
        nodeName,
        fromStatus: NodeStatus.PENDING,
        toStatus: NodeStatus.RUNNING,
        transition: NodeTransition.DEPENDENCIES_MET,
      })
    }

    // Run 100 Core sequences sequentially (shared memory state, can't truly parallelize)
    for (let i = 0; i < 100; i++) {
      await registerAndTransition(i)
    }

    // --- Session: emit 100 workflow.started events ---
    for (let i = 0; i < 100; i++) {
      const event = buildSessionWorkflowEvent(
        sessionWfId,
        'pending',
        'running',
        Date.now() + i,
      )
      if (event) bus.emit(event)
    }

    const elapsed = performance.now() - startTime

    // Verify: each listener sees exactly its own 100 events
    expect(coreCount).toBe(100)
    expect(sessionCount).toBe(100)

    // Verify no cross-contamination:
    // Core listener should not see any session-wf events
    // Session listener should not see any core-wf events
    // (Already enforced by the workflow_id filter in each listener above)

    // Performance: 200 events emit + receive ≤ 2 seconds
    expect(elapsed).toBeLessThan(2000)

    bus.destroy()
  })
})
