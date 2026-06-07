// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * @file TddCoverage Tests (WP2)
 * @description WP2 TDD 覆盖率提升 — 10 个新测试
 *
 * 覆盖场景：
 * 1. Shadow 节点完整生命周期（register → PENDING → RUNNING → COMPLETED）
 * 2. Shadow 节点 PENDING → RUNNING → FAILED 路径
 * 3. Shadow PENDING → COMPLETED 直接跳转 → Iron Law #1 违规
 * 4. resetNode() 后重新走 COMPLETED 路径（admin bypass 复用场景）
 * 5. resetNode() 从 FAILED 状态（admin bypass + 重新尝试）
 * 6. Persister readWorkflowState 失败 → 错误传播不静默（用例 A）
 * 7. Persister writeNodeState 特定节点失败 → StateNotPersistedError + rollback（用例 B）
 * 8. 多分支并发事件风暴（100 WSM in parallel）
 * 9. 1000 nodes register + query 性能 sanity
 * 10. 跨模块 IStatePersister 共享（两个 NSM 复用同一 persister）
 *
 * 总测试数：10
 */

import { describe, expect, it } from 'bun:test'
import {
  NodeStatus,
  NodeTransition,
  NodeType,
  FallbackTrigger,
  ShadowNodeStatus,
  WorkflowStatus,
  WorkflowTransition,
} from '../types'
import type {
  NodeStateData,
  NodeEvent,
  WorkflowStateData,
  WorkflowEvent,
} from '../types'
import type { IEventBus, IStatePersister } from '../IStateMachine'
import {
  InvalidNodeTransitionError,
  StateNotPersistedError,
} from '../errors'
import { NodeStateMachine } from '../NodeStateMachine'
import { WorkflowStateMachine } from '../WorkflowStateMachine'
import { EventBus } from '../EventBus'

// ============================================================================
// Constants
// ============================================================================

const WF_ID = 'wf-tdd-cov'

// ============================================================================
// Mock 工厂
// ============================================================================

interface TestNodePersister extends IStatePersister {
  reads: Map<string, NodeStateData>
  writes: Array<{ wfId: string; nodeName: string; state: NodeStateData }>
  writeNodeState(
    wfId: string,
    nodeName: string,
    state: NodeStateData,
  ): Promise<void>
  readNodeState(
    wfId: string,
    nodeName: string,
  ): Promise<NodeStateData | null>
}

function createMockEventBus(): { events: any[] } & IEventBus {
  const events: any[] = []
  return {
    events,
    subscribe: (_event: string, _listener: any) => () => {},
    emit: (e: any) => {
      events.push(e)
    },
    destroy: () => {},
  }
}

function createSharedNodePersister(): TestNodePersister {
  const store = new Map<string, NodeStateData>()
  const wfStore = new Map<string, WorkflowStateData>()
  const reads = new Map<string, NodeStateData>()
  const writes: Array<{ wfId: string; nodeName: string; state: NodeStateData }> = []
  return {
    reads,
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
    async writeNodeState(wfId: string, nodeName: string, state: NodeStateData) {
      writes.push({ wfId, nodeName, state })
      const key = `${wfId}:${nodeName}`
      store.set(key, state)
      reads.set(key, state)
    },
    async readNodeState(wfId: string, nodeName: string) {
      return store.get(`${wfId}:${nodeName}`) ?? null
    },
  }
}

function createSharedWfPersister(): IStatePersister {
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
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

function transitionFor(
  from: NodeStatus,
  to: NodeStatus,
): NodeTransition {
  if (from === NodeStatus.PENDING && to === NodeStatus.RUNNING)
    return NodeTransition.DEPENDENCIES_MET
  if (from === NodeStatus.RUNNING && to === NodeStatus.COMPLETED)
    return NodeTransition.DAG_COMPLETED
  if (from === NodeStatus.RUNNING && to === NodeStatus.FAILED)
    return NodeTransition.EXEC_FAILED
  return NodeTransition.DEPENDENCIES_MET
}

async function advanceNode(
  sm: NodeStateMachine,
  workflowId: string,
  branch: string,
  nodeName: string,
  isShadow: boolean,
  targetStatus: NodeStatus,
): Promise<void> {
  await sm.registerNode(workflowId, branch, nodeName, isShadow)
  let current = NodeStatus.PENDING
  const path = getPathToTarget(targetStatus)
  for (const next of path) {
    await sm.transition({
      workflowId,
      nodeName,
      fromStatus: current,
      toStatus: next,
      transition: transitionFor(current, next),
    })
    current = next
  }
}

function getPathToTarget(target: NodeStatus): NodeStatus[] {
  switch (target) {
    case NodeStatus.RUNNING:
      return [NodeStatus.RUNNING]
    case NodeStatus.COMPLETED:
      return [NodeStatus.RUNNING, NodeStatus.COMPLETED]
    case NodeStatus.FAILED:
      return [NodeStatus.RUNNING, NodeStatus.FAILED]
    default:
      return []
  }
}

// ============================================================================
// TDD Coverage Expansion 测试套件
// ============================================================================

describe('TDD Coverage Expansion', () => {
  // ==========================================================================
  // Test 1: Shadow 节点完整生命周期
  //   register → PENDING → RUNNING → COMPLETED
  // ==========================================================================
  it('should complete full shadow lifecycle: register → PENDING → RUNNING → COMPLETED', async () => {
    const eventBus = createMockEventBus()
    const persister = createSharedNodePersister()
    const sm = new NodeStateMachine(WF_ID, eventBus, persister)

    // Register shadow node
    await sm.registerNode(WF_ID, 'shadow-x', 'shadow-1', true)

    // Verify initial state
    const registered = await sm.getNodeState('shadow-1')
    expect(registered?.node_type).toBe(NodeType.SHADOW)
    expect(registered?.status).toBe(NodeStatus.PENDING)
    expect(eventBus.events.some((e: any) => e.type === 'node.registered')).toBe(true)

    // PENDING → RUNNING (legal: getValidNextNodeStatuses(SHADOW, PENDING) = [RUNNING])
    await sm.transition({
      workflowId: WF_ID,
      nodeName: 'shadow-1',
      fromStatus: NodeStatus.PENDING,
      toStatus: NodeStatus.RUNNING,
      transition: NodeTransition.DEPENDENCIES_MET,
    })
    expect(eventBus.events.some((e: any) => e.type === 'node.started')).toBe(true)

    // RUNNING → COMPLETED (legal: getValidNextNodeStatuses(SHADOW, RUNNING) = [COMPLETED, FAILED])
    await sm.transition({
      workflowId: WF_ID,
      nodeName: 'shadow-1',
      fromStatus: NodeStatus.RUNNING,
      toStatus: NodeStatus.COMPLETED,
      transition: NodeTransition.DAG_COMPLETED,
      output: { decision: 'approve' },
    })
    expect(eventBus.events.some((e: any) => e.type === 'node.completed')).toBe(true)

    // Final state verification
    const finalState = await sm.getNodeState('shadow-1')
    expect(finalState?.status).toBe(NodeStatus.COMPLETED)
    expect(finalState?.output_summary).toEqual({ decision: 'approve' })

    // Event chain: node.registered → node.started → node.completed
    const types = eventBus.events.map((e: any) => e.type)
    expect(types).toEqual(['node.registered', 'node.started', 'node.completed'])

    // getBranchState confirms completed
    const branch = await sm.getBranchState('shadow-x')
    expect(branch).not.toBeNull()
    expect(branch?.status).toBe(NodeStatus.COMPLETED)
  })

  // ==========================================================================
  // Test 2: Shadow 节点 PENDING → RUNNING → FAILED 路径
  // ==========================================================================
  it('should complete shadow node PENDING → RUNNING → FAILED path with correct events', async () => {
    const eventBus = createMockEventBus()
    const persister = createSharedNodePersister()
    const sm = new NodeStateMachine(WF_ID, eventBus, persister)

    await sm.registerNode(WF_ID, 'shadow-x', 'shadow-1', true)

    // PENDING → RUNNING
    await sm.transition({
      workflowId: WF_ID,
      nodeName: 'shadow-1',
      fromStatus: NodeStatus.PENDING,
      toStatus: NodeStatus.RUNNING,
      transition: NodeTransition.DEPENDENCIES_MET,
    })

    // RUNNING → FAILED
    await sm.transition({
      workflowId: WF_ID,
      nodeName: 'shadow-1',
      fromStatus: NodeStatus.RUNNING,
      toStatus: NodeStatus.FAILED,
      transition: NodeTransition.EXEC_FAILED,
    })

    const finalState = await sm.getNodeState('shadow-1')
    expect(finalState?.status).toBe(NodeStatus.FAILED)
    expect(finalState?.node_type).toBe(NodeType.SHADOW)

    // Event chain: node.registered → node.started → node.failed
    const types = eventBus.events.map((e: any) => e.type)
    expect(types).toEqual(['node.registered', 'node.started', 'node.failed'])
  })

  // ==========================================================================
  // Test 3: Shadow PENDING → COMPLETED 直接跳转 → Iron Law #1 违规
  //   getValidNextNodeStatuses(SHADOW, PENDING) = [RUNNING]；COMPLETED ∉ valid
  // ==========================================================================
  it('should throw InvalidNodeTransitionError on shadow PENDING → COMPLETED (Iron Law #1)', async () => {
    const eventBus = createMockEventBus()
    const persister = createSharedNodePersister()
    const sm = new NodeStateMachine(WF_ID, eventBus, persister)

    await sm.registerNode(WF_ID, 'shadow-x', 'shadow-1', true)

    // getValidNextNodeStatuses(SHADOW, PENDING) = [RUNNING]; COMPLETED ∉ valid
    await expect(
      sm.transition({
        workflowId: WF_ID,
        nodeName: 'shadow-1',
        fromStatus: NodeStatus.PENDING,
        toStatus: NodeStatus.COMPLETED,
        transition: NodeTransition.DAG_COMPLETED,
      }),
    ).rejects.toBeInstanceOf(InvalidNodeTransitionError)
  })

  // ==========================================================================
  // Test 4: resetNode() 后重新走 COMPLETED 路径（admin bypass 复用）
  //   COMPLETED → resetNode → PENDING → RUNNING → COMPLETED（再次完成）
  // ==========================================================================
  it('should allow full re-lifecycle after resetNode from COMPLETED (admin bypass)', async () => {
    const eventBus = createMockEventBus()
    const persister = createSharedNodePersister()
    const sm = new NodeStateMachine(WF_ID, eventBus, persister)

    // First lifecycle: register → RUNNING → COMPLETED
    await advanceNode(sm, WF_ID, 'main', 'n1', false, NodeStatus.COMPLETED)

    // Verify first lifecycle completed
    const firstState = await sm.getNodeState('n1')
    expect(firstState?.status).toBe(NodeStatus.COMPLETED)

    // resetNode (admin bypass) → PENDING
    await sm.resetNode('n1')

    // Clear events to verify only second-lifecycle events
    eventBus.events.length = 0

    // Verify pushed_count/fallback_count reset
    const resetState = await sm.getNodeState('n1')
    expect(resetState?.status).toBe(NodeStatus.PENDING)
    expect(resetState?.pushed_count).toBe(0)
    expect(resetState?.fallback_count).toBe(0)
    expect(resetState?.started_at).toBeNull()
    expect(resetState?.completed_at).toBeNull()
    expect(resetState?.output_summary).toBeNull()

    // Second lifecycle: PENDING → RUNNING → COMPLETED
    await sm.transition({
      workflowId: WF_ID,
      nodeName: 'n1',
      fromStatus: NodeStatus.PENDING,
      toStatus: NodeStatus.RUNNING,
      transition: NodeTransition.DEPENDENCIES_MET,
    })
    await sm.transition({
      workflowId: WF_ID,
      nodeName: 'n1',
      fromStatus: NodeStatus.RUNNING,
      toStatus: NodeStatus.COMPLETED,
      transition: NodeTransition.DAG_COMPLETED,
      output: { decision: 'done' },
    })

    // Verify second completion
    const secondState = await sm.getNodeState('n1')
    expect(secondState?.status).toBe(NodeStatus.COMPLETED)
    expect(secondState?.output_summary).toEqual({ decision: 'done' })

    // Second-lifecycle event chain (after clear): node.started → node.completed
    const types = eventBus.events.map((e: any) => e.type)
    expect(types).toEqual(['node.started', 'node.completed'])
  })

  // ==========================================================================
  // Test 5: resetNode() 从 FAILED 状态（admin bypass + 重新尝试）
  //   FAILED → resetNode → PENDING → RUNNING → COMPLETED
  // ==========================================================================
  it('should recover from FAILED via resetNode and eventually reach COMPLETED', async () => {
    const eventBus = createMockEventBus()
    const persister = createSharedNodePersister()
    const sm = new NodeStateMachine(WF_ID, eventBus, persister)

    // First lifecycle: register → RUNNING → FAILED
    await advanceNode(sm, WF_ID, 'failed-branch', 'n1', false, NodeStatus.FAILED)

    // Verify failed state
    const failedState = await sm.getNodeState('n1')
    expect(failedState?.status).toBe(NodeStatus.FAILED)

    // Clear events to isolate post-reset events
    eventBus.events.length = 0

    // resetNode (admin bypass)
    await sm.resetNode('n1')

    // Verify reset state
    const resetState = await sm.getNodeState('n1')
    expect(resetState?.status).toBe(NodeStatus.PENDING)
    expect(resetState?.pushed_count).toBe(0)
    expect(resetState?.fallback_count).toBe(0)

    // Second attempt: PENDING → RUNNING → COMPLETED
    await sm.transition({
      workflowId: WF_ID,
      nodeName: 'n1',
      fromStatus: NodeStatus.PENDING,
      toStatus: NodeStatus.RUNNING,
      transition: NodeTransition.DEPENDENCIES_MET,
    })
    await sm.transition({
      workflowId: WF_ID,
      nodeName: 'n1',
      fromStatus: NodeStatus.RUNNING,
      toStatus: NodeStatus.COMPLETED,
      transition: NodeTransition.DAG_COMPLETED,
      output: { summary: 'recovered' },
    })

    // Final status = COMPLETED
    const finalState = await sm.getNodeState('n1')
    expect(finalState?.status).toBe(NodeStatus.COMPLETED)
    expect(finalState?.output_summary).toEqual({ summary: 'recovered' })

    // Post-reset event chain: node.reset → node.started → node.completed
    const types = eventBus.events.map((e: any) => e.type)
    expect(types).toEqual(['node.reset', 'node.started', 'node.completed'])
  })

  // ==========================================================================
  // Test 6: Persister readWorkflowState 失败 → 错误传播不静默（用例 A）
  //   Mock persister.readWorkflowState throws on read
  //   WorkflowStateMachine.transition → readWorkflowState called → error propagates
  //
  //   注：NodeStateMachine.getNodeState() 从内存读取，不调用 persister.readWorkflowState。
  //   故使用 WorkflowStateMachine.transition() 验证 read 错误传播（此乃唯一调用
  //   readWorkflowState 的路径），确保 Iron Law "不静默降级" 行为。
  // ==========================================================================
  it('should propagate readWorkflowState error without silencing (rollback correctness A)', async () => {
    function createReadFailingPersister(): IStatePersister {
      return {
        async writeWorkflowState() {},
        async readWorkflowState() {
          throw new Error('readWorkflowState exploded')
        },
        async deleteWorkflowState() {},
        async listWorkflowIds() {
          return []
        },
      }
    }

    const eventBus = createMockEventBus()
    const persister = createReadFailingPersister()

    // WorkflowStateMachine calls persister.readWorkflowState inside transition()
    const wsm = new WorkflowStateMachine('wf-6', eventBus, persister)

    // readWorkflowState throws → error propagates (not silenced)
    await expect(
      wsm.transition({
        fromStatus: WorkflowStatus.PENDING,
        toStatus: WorkflowStatus.RUNNING,
        transition: WorkflowTransition.DAG_EXECUTE,
      }),
    ).rejects.toThrow(/readWorkflowState exploded/)

    // Memory state unchanged — still PENDING
    const status = await wsm.getStatus()
    expect(status).toBe(WorkflowStatus.PENDING)

    // No transition event emitted
    const transitionEvents = eventBus.events.filter(
      (e: any) => e.type !== 'node.registered',
    )
    expect(transitionEvents.length).toBe(0)
  })

  // ==========================================================================
  // Test 7: Persister writeNodeState 特定节点失败 → StateNotPersistedError + rollback（用例 B）
  //   Mock writeNodeState throws for specific nodeName during transition
  //   → StateNotPersistedError, memory node status unchanged (rollback success)
  // ==========================================================================
  it('should rollback memory state when writeNodeState fails for specific node (rollback B)', async () => {
    function createSelectiveFailPersister(
      failForNodeName: string,
    ): TestNodePersister {
      const store = new Map<string, NodeStateData>()
      const wfStore = new Map<string, WorkflowStateData>()
      const reads = new Map<string, NodeStateData>()
      const writes: Array<{ wfId: string; nodeName: string; state: NodeStateData }> = []
      return {
        reads,
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
          writes.push({ wfId, nodeName, state })
          // Throw only when this specific node transitions (not register)
          if (nodeName === failForNodeName && state.status === NodeStatus.RUNNING) {
            throw new Error(`writeNodeState failed for ${failForNodeName}`)
          }
          const key = `${wfId}:${nodeName}`
          store.set(key, state)
          reads.set(key, state)
        },
        async readNodeState(wfId: string, nodeName: string) {
          return store.get(`${wfId}:${nodeName}`) ?? null
        },
      }
    }

    const eventBus = createMockEventBus()
    const persister = createSelectiveFailPersister('bad-node')
    const sm = new NodeStateMachine(WF_ID, eventBus, persister)

    // registerNode succeeds (writeNodeState doesn't fail for PENDING)
    await sm.registerNode(WF_ID, 'main', 'bad-node', false)

    // Verify registration succeeded
    const stateBefore = await sm.getNodeState('bad-node')
    expect(stateBefore?.status).toBe(NodeStatus.PENDING)

    // Transition to RUNNING: writeNodeState throws
    // → StateNotPersistedError thrown, memory state rolled back
    await expect(
      sm.transition({
        workflowId: WF_ID,
        nodeName: 'bad-node',
        fromStatus: NodeStatus.PENDING,
        toStatus: NodeStatus.RUNNING,
        transition: NodeTransition.DEPENDENCIES_MET,
      }),
    ).rejects.toBeInstanceOf(StateNotPersistedError)

    // Memory state unchanged (rollback verified)
    const stateAfter = await sm.getNodeState('bad-node')
    expect(stateAfter?.status).toBe(NodeStatus.PENDING)

    // No node.started event emitted (event fires only after successful persist + memory update)
    const startedEvents = eventBus.events.filter(
      (e: any) => e.type === 'node.started',
    )
    expect(startedEvents.length).toBe(0)
  })

  // ==========================================================================
  // Test 8: 多分支并发事件风暴（100 WSM in parallel, ≤ 2s）
  //   100 independent WorkflowStateMachine instances sharing one EventBus
  //   → 100 workflow.started events with unique workflow_ids
  // ==========================================================================
  it('should handle 100 concurrent WorkflowStateMachine transitions and emit correct events', async () => {
    // Real EventBus used here: required to support wildcard '*' subscriptions for event collection
    // (mock's subscribe is a no-op; real EventBus routes to wildcardListeners on every emit)
    const eventBus = new EventBus()
    const sharedPersister = createSharedWfPersister()

    // Subscribe a wildcard listener to collect events
    const collected: any[] = []
    eventBus.subscribe('*', (e: any) => {
      collected.push(e)
    })

    const start = performance.now()

    // Create 100 independent WSMs with unique IDs, sharing eventBus + persister
    const machines = Array.from(
      { length: 100 },
      (_, i) =>
        new WorkflowStateMachine(`wf-storm-${i}`, eventBus, sharedPersister),
    )

    // Fire all 100 transitions in parallel
    await Promise.all(
      machines.map((wsm) =>
        wsm.transition({
          fromStatus: WorkflowStatus.PENDING,
          toStatus: WorkflowStatus.RUNNING,
          transition: WorkflowTransition.DAG_EXECUTE,
        }),
      ),
    )

    const elapsed = performance.now() - start

    // Verify EventBus received 100 workflow.started events
    const startedEvents = collected.filter(
      (e: any) => e.type === 'workflow.started',
    )
    expect(startedEvents.length).toBe(100)

    // All workflow_ids are unique
    const ids = new Set(startedEvents.map((e: any) => e.workflow_id))
    expect(ids.size).toBe(100)

    // Performance constraint: ≤ 2000ms
    expect(elapsed).toBeLessThan(2000)
  })

  // ==========================================================================
  // Test 9: 1000 nodes register + query 性能 sanity（≤ 5s）
  //   Serialize registration (avoid state race)
  //   Measure getAllNodeStates + getBranchState query latency
  // ==========================================================================
  it('should register 1000 nodes and query all states within 5 seconds', async () => {
    const eventBus = createMockEventBus()
    const persister = createSharedNodePersister()
    const sm = new NodeStateMachine(WF_ID, eventBus, persister)

    const BRANCH = 'perf-main'
    const NODE_COUNT = 1000
    const registerStart = performance.now()

    // Serial registration (avoids state race per spec)
    for (let i = 0; i < NODE_COUNT; i++) {
      await sm.registerNode(WF_ID, BRANCH, `perf-node-${i}`, false)
    }

    // Transition all through RUNNING → COMPLETED (serial)
    for (let i = 0; i < NODE_COUNT; i++) {
      await sm.transition({
        workflowId: WF_ID,
        nodeName: `perf-node-${i}`,
        fromStatus: NodeStatus.PENDING,
        toStatus: NodeStatus.RUNNING,
        transition: NodeTransition.DEPENDENCIES_MET,
      })
      await sm.transition({
        workflowId: WF_ID,
        nodeName: `perf-node-${i}`,
        fromStatus: NodeStatus.RUNNING,
        toStatus: NodeStatus.COMPLETED,
        transition: NodeTransition.DAG_COMPLETED,
      })
    }

    const registerElapsed = performance.now() - registerStart

    // Measure query latency
    const queryStart = performance.now()
    const allStates = await sm.getAllNodeStates()
    const branchState = await sm.getBranchState(BRANCH)
    const queryElapsed = performance.now() - queryStart

    // Correctness: all 1000 nodes returned in getAllNodeStates
    expect(Object.keys(allStates).length).toBeGreaterThanOrEqual(1)
    expect(allStates[BRANCH]).toBeDefined()
    expect(Object.keys(allStates[BRANCH].nodes).length).toBe(NODE_COUNT)

    // Correctness: branch state has all 1000 nodes, all COMPLETED
    expect(branchState).not.toBeNull()
    expect(Object.keys(branchState!.nodes).length).toBe(NODE_COUNT)
    expect(branchState!.status).toBe(NodeStatus.COMPLETED)

    // All nodes verified as COMPLETED with correct node_type
    for (let i = 0; i < NODE_COUNT; i++) {
      const name = `perf-node-${i}`
      expect(branchState!.nodes[name]?.status).toBe(NodeStatus.COMPLETED)
      expect(branchState!.nodes[name]?.node_type).toBe(NodeType.NORMAL)
    }

    // Performance constraint: query latency ≤ 5000ms
    expect(queryElapsed).toBeLessThan(5000)

    // Sanity: registration + transitions also shouldn't exceed 10s
    expect(registerElapsed).toBeLessThan(10000)
  })

  // ==========================================================================
  // Test 10: 跨模块 IStatePersister 共享
  //   Two NodeStateMachine instances share same mock persister
  //   → A writes 'a-1', B writes 'b-1', no cross-pollution
  //   → persister stores both correctly
  //   → each NSM's memoryState is isolated
  // ==========================================================================
  it('should isolate memory states between two NSMs sharing same persister', async () => {
    const eventBusA = createMockEventBus()
    const eventBusB = createMockEventBus()
    const sharedPersister = createSharedNodePersister()

    const smA = new NodeStateMachine('wf-a', eventBusA, sharedPersister)
    const smB = new NodeStateMachine('wf-b', eventBusB, sharedPersister)

    // A registers 'a-1', B registers 'b-1'
    await smA.registerNode('wf-a', 'branch-a', 'a-1', false)
    await smB.registerNode('wf-b', 'branch-b', 'b-1', false)

    // Verify: persister.readNodeState returns correct state for each
    const aState = await sharedPersister.readNodeState('wf-a', 'a-1')
    expect(aState).not.toBeNull()
    expect(aState?.node_name).toBe('a-1')
    expect(aState?.status).toBe(NodeStatus.PENDING)

    const bState = await sharedPersister.readNodeState('wf-b', 'b-1')
    expect(bState).not.toBeNull()
    expect(bState?.node_name).toBe('b-1')
    expect(bState?.status).toBe(NodeStatus.PENDING)

    // Verify: cross reads return null (no cross-pollution)
    const aReadsB = await sharedPersister.readNodeState('wf-a', 'b-1')
    expect(aReadsB).toBeNull()

    const bReadsA = await sharedPersister.readNodeState('wf-b', 'a-1')
    expect(bReadsA).toBeNull()

    // Verify: each NSM's memoryState is isolated
    const aMemState = await smA.getNodeState('a-1')
    expect(aMemState).not.toBeNull()
    expect(aMemState?.node_name).toBe('a-1')

    const bMemState = await smB.getNodeState('b-1')
    expect(bMemState).not.toBeNull()
    expect(bMemState?.node_name).toBe('b-1')

    // A cannot see B's node in memory
    const aSeesB = await smA.getNodeState('b-1')
    expect(aSeesB).toBeNull()

    // B cannot see A's node in memory
    const bSeesA = await smB.getNodeState('a-1')
    expect(bSeesA).toBeNull()

    // Both registered correctly in persister writes log
    const aWrites = sharedPersister.writes.filter((w) => w.nodeName === 'a-1')
    const bWrites = sharedPersister.writes.filter((w) => w.nodeName === 'b-1')
    expect(aWrites.length).toBeGreaterThanOrEqual(1)
    expect(bWrites.length).toBeGreaterThanOrEqual(1)
  })
})
