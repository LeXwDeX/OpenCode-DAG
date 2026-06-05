/**
 * @file CoreCoordination Tests (WP1-A)
 * @description Core 层内部协调集成测试
 *
 * 验证 WorkflowStateMachine + NodeStateMachine 共享同一 IEventBus 时的协调行为。
 * D-PLAN 架构决策：Core 层纯内存 + 事件驱动，与 Session 层刻意隔离。
 *
 * 5 测试：
 * 1. 共享 IEventBus 事件按序到达
 * 2. registerNode + transition 后 getBranchState() 聚合一致
 * 3. 多节点并发完成时 areAllRequiredNodesCompleted() 正确判定
 * 4. 跨 state-machine 事件隔离（admin bypass 不污染）
 * 5. skip 链：上游 FAILED → 下游 SKIPPED（纯 NodeStateMachine）
 */

import { describe, expect, it } from 'bun:test'
import { EventBus } from '../EventBus'
import { WorkflowStateMachine } from '../WorkflowStateMachine'
import { NodeStateMachine } from '../NodeStateMachine'
import {
  NodeStatus,
  NodeTransition,
  WorkflowStatus,
  WorkflowTransition,
  FallbackTrigger,
} from '../types'
import type {
  NodeStateData,
  NodeEvent,
  WorkflowEvent,
  WorkflowStateData,
} from '../types'
import type { IStatePersister } from '../IStateMachine'

// ============================================================================
// Constants
// ============================================================================

const WORKFLOW_ID = 'wf-core-coord'

// ============================================================================
// Mock helpers
// ============================================================================

interface TestNodePersister extends IStatePersister {
  writes: Array<{ nodeName: string; state: NodeStateData }>
  writeNodeState(
    workflowId: string,
    nodeName: string,
    state: NodeStateData,
  ): Promise<void>
  readNodeState(
    workflowId: string,
    nodeName: string,
  ): Promise<NodeStateData | null>
}

function createInMemoryPersister(): IStatePersister {
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

function createFailingPersister(): IStatePersister {
  return {
    async writeWorkflowState() {
      throw new Error('persister failure')
    },
    async readWorkflowState() {
      return null
    },
    async deleteWorkflowState() {},
    async listWorkflowIds() {
      return []
    },
  }
}

function createTestNodePersister(): TestNodePersister {
  const nodeStore = new Map<string, NodeStateData>()
  const wfStore = new Map<string, WorkflowStateData>()
  const writes: Array<{ nodeName: string; state: NodeStateData }> = []
  return {
    writes,
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
    async writeNodeState(
      wfId: string,
      nodeName: string,
      state: NodeStateData,
    ) {
      writes.push({ nodeName, state })
      nodeStore.set(`${wfId}:${nodeName}`, state)
    },
    async readNodeState(wfId: string, nodeName: string) {
      return nodeStore.get(`${wfId}:${nodeName}`) ?? null
    },
  }
}

/**
 * Subscribe wildcard listener on a real EventBus, return mutable events array.
 */
function collectEvents(bus: EventBus): Array<WorkflowEvent | NodeEvent> {
  const events: Array<WorkflowEvent | NodeEvent> = []
  bus.subscribe('*', (event) => {
    events.push(event as WorkflowEvent | NodeEvent)
  })
  return events
}

// ============================================================================
// Test suite
// ============================================================================

describe('Core-Internal Coordination', () => {
  // --------------------------------------------------------------------------
  // Test 1: 共享 IEventBus 事件按序到达
  // --------------------------------------------------------------------------
  it('should deliver shared IEventBus events in time order (workflow.started → node.started)', async () => {
    const eventBus = new EventBus()
    const wfPersister = createInMemoryPersister()
    const nodePersister = createTestNodePersister()

    const wsm = new WorkflowStateMachine(WORKFLOW_ID, eventBus, wfPersister)
    const nsm = new NodeStateMachine(WORKFLOW_ID, eventBus, nodePersister)

    // Register node BEFORE subscribing — node.registered won't be captured
    await nsm.registerNode(WORKFLOW_ID, 'main', 'step-1', false)

    // Subscribe wildcard listener
    const events = collectEvents(eventBus)

    // WorkflowStateMachine PENDING → RUNNING → workflow.started
    await wsm.transition({
      fromStatus: WorkflowStatus.PENDING,
      toStatus: WorkflowStatus.RUNNING,
      transition: WorkflowTransition.DAG_EXECUTE,
    })

    // NodeStateMachine PENDING → RUNNING → node.started
    await nsm.transition({
      workflowId: WORKFLOW_ID,
      nodeName: 'step-1',
      fromStatus: NodeStatus.PENDING,
      toStatus: NodeStatus.RUNNING,
      transition: NodeTransition.DEPENDENCIES_MET,
    })

    // Verify: listener received both events sequentially, not in parallel
    expect(events).toHaveLength(2)
    expect(events[0].type).toBe('workflow.started')
    expect(events[1].type).toBe('node.started')
  })

  // --------------------------------------------------------------------------
  // Test 2: registerNode + transition → getBranchState() 聚合一致
  // --------------------------------------------------------------------------
  it('should aggregate getBranchState() correctly after registerNode + full transition', async () => {
    const eventBus = new EventBus()
    const persister = createTestNodePersister()
    const nsm = new NodeStateMachine(WORKFLOW_ID, eventBus, persister)

    await nsm.registerNode(WORKFLOW_ID, 'main', 'step-1', false)

    // PENDING → RUNNING
    await nsm.transition({
      workflowId: WORKFLOW_ID,
      nodeName: 'step-1',
      fromStatus: NodeStatus.PENDING,
      toStatus: NodeStatus.RUNNING,
      transition: NodeTransition.DEPENDENCIES_MET,
    })

    // RUNNING → COMPLETED
    await nsm.transition({
      workflowId: WORKFLOW_ID,
      nodeName: 'step-1',
      fromStatus: NodeStatus.RUNNING,
      toStatus: NodeStatus.COMPLETED,
      transition: NodeTransition.DAG_COMPLETED,
      output: { files: ['a.ts'] },
    })

    const branch = await nsm.getBranchState('main')

    expect(branch).not.toBeNull()
    expect(branch!.branch_name).toBe('main')
    expect(branch!.nodes['step-1']).toBeDefined()
    expect(branch!.nodes['step-1'].status).toBe(NodeStatus.COMPLETED)
    expect(branch!.nodes['step-1'].completed_at).not.toBeNull()
  })

  // --------------------------------------------------------------------------
  // Test 3: 多节点并发完成 → areAllRequiredNodesCompleted() 判定
  // --------------------------------------------------------------------------
  it('should correctly judge areAllRequiredNodesCompleted() with concurrent completions', async () => {
    const eventBus = new EventBus()
    const persister = createTestNodePersister()
    const nsm = new NodeStateMachine(WORKFLOW_ID, eventBus, persister)

    const nodes = ['step-1', 'step-2', 'step-3']

    for (const name of nodes) {
      await nsm.registerNode(WORKFLOW_ID, 'main', name, false)
    }

    // Concurrently transition all to RUNNING
    await Promise.all(
      nodes.map((name) =>
        nsm.transition({
          workflowId: WORKFLOW_ID,
          nodeName: name,
          fromStatus: NodeStatus.PENDING,
          toStatus: NodeStatus.RUNNING,
          transition: NodeTransition.DEPENDENCIES_MET,
        }),
      ),
    )

    // Concurrently transition all to COMPLETED
    await Promise.all(
      nodes.map((name) =>
        nsm.transition({
          workflowId: WORKFLOW_ID,
          nodeName: name,
          fromStatus: NodeStatus.RUNNING,
          toStatus: NodeStatus.COMPLETED,
          transition: NodeTransition.DAG_COMPLETED,
        }),
      ),
    )

    // All 3 completed → true
    expect(await nsm.areAllRequiredNodesCompleted(nodes)).toBe(true)

    // Add incomplete 4th node → still true for original 3, but false for all 4
    await nsm.registerNode(WORKFLOW_ID, 'main', 'step-4', false)
    expect(
      await nsm.areAllRequiredNodesCompleted([
        'step-1',
        'step-2',
        'step-3',
        'step-4',
      ]),
    ).toBe(false)
  })

  // --------------------------------------------------------------------------
  // Test 4: 跨 state-machine 事件隔离（admin bypass 不污染 listener）
  // --------------------------------------------------------------------------
  it('should isolate cross state-machine events — resetNode works despite failing WSM persister', async () => {
    const eventBus = new EventBus()
    // WSM has broken persister — proves persister isolation
    const wfPersister = createFailingPersister()
    const nodePersister = createTestNodePersister()

    const wsm = new WorkflowStateMachine(WORKFLOW_ID, eventBus, wfPersister)
    const nsm = new NodeStateMachine(WORKFLOW_ID, eventBus, nodePersister)

    // Register + advance node to RUNNING (before listener subscription)
    await nsm.registerNode(WORKFLOW_ID, 'main', 'fix-me', false)
    await nsm.transition({
      workflowId: WORKFLOW_ID,
      nodeName: 'fix-me',
      fromStatus: NodeStatus.PENDING,
      toStatus: NodeStatus.RUNNING,
      transition: NodeTransition.DEPENDENCIES_MET,
    })

    // Subscribe wildcard listener AFTER setup
    const events = collectEvents(eventBus)

    // Admin bypass: resetNode should succeed despite WSM persister being broken
    await nsm.resetNode('fix-me')

    // Verify: listener received exactly node.reset
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('node.reset')
    if (events[0].type === 'node.reset') {
      expect(events[0].workflow_id).toBe(WORKFLOW_ID)
      expect(events[0].node_name).toBe('fix-me')
    }

    // Verify: WSM status unchanged — no side effects from node.reset
    expect(await wsm.getStatus()).toBe(WorkflowStatus.PENDING)

    // Verify: node actually reset to PENDING
    const nodeState = await nsm.getNodeState('fix-me')
    expect(nodeState).not.toBeNull()
    expect(nodeState!.status).toBe(NodeStatus.PENDING)
    expect(nodeState!.pushed_count).toBe(0)
    expect(nodeState!.fallback_count).toBe(0)
  })

  // --------------------------------------------------------------------------
  // Test 5: skip 链 — 上游 FAILED → 下游 SKIPPED（纯 Core 层）
  // --------------------------------------------------------------------------
  it('should skip downstream after upstream fails — correct status and event order', async () => {
    const eventBus = new EventBus()
    const persister = createTestNodePersister()
    const nsm = new NodeStateMachine(WORKFLOW_ID, eventBus, persister)

    // Register upstream + downstream (pure NodeStateMachine, no WSM)
    await nsm.registerNode(WORKFLOW_ID, 'main', 'upstream', false)
    await nsm.registerNode(WORKFLOW_ID, 'main', 'downstream', false)

    // Subscribe wildcard listener AFTER registration
    const events = collectEvents(eventBus)

    // Upstream: PENDING → RUNNING → FAILED
    await nsm.transition({
      workflowId: WORKFLOW_ID,
      nodeName: 'upstream',
      fromStatus: NodeStatus.PENDING,
      toStatus: NodeStatus.RUNNING,
      transition: NodeTransition.DEPENDENCIES_MET,
    })
    await nsm.transition({
      workflowId: WORKFLOW_ID,
      nodeName: 'upstream',
      fromStatus: NodeStatus.RUNNING,
      toStatus: NodeStatus.FAILED,
      transition: NodeTransition.EXEC_FAILED,
      fallbackTrigger: FallbackTrigger.EXEC_FAILED,
    })

    // Downstream: skipNode(reason='上游失败')
    await nsm.skipNode('downstream', '上游失败')

    // Verify: downstream status = SKIPPED, skipped_by = '上游失败'
    const dsState = await nsm.getNodeState('downstream')
    expect(dsState).not.toBeNull()
    expect(dsState!.status).toBe(NodeStatus.SKIPPED)
    expect(dsState!.skipped_by).toBe('上游失败')

    // Verify: event order — node.started, node.failed, node.skipped
    expect(events).toHaveLength(3)
    expect(events[0].type).toBe('node.started')
    expect(events[1].type).toBe('node.failed')
    expect(events[2].type).toBe('node.skipped')

    // Verify node.skipped event payload
    const skippedEvent = events[2]
    expect(skippedEvent.type).toBe('node.skipped')
    if (skippedEvent.type === 'node.skipped') {
      expect(skippedEvent.upstream_failed_node).toBe('上游失败')
      expect(skippedEvent.node_name).toBe('downstream')
      expect(skippedEvent.workflow_id).toBe(WORKFLOW_ID)
    }
  })
})
