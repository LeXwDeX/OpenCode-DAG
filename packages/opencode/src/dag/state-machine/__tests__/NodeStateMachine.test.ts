// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * @file NodeStateMachine Tests
 * @description DAG 节点状态机单元测试
 *
 * 测试组织：
 * - 铁律 #1: 状态机不可绕过（5 测试）
 * - 铁律 #2: 终态不可逆（4 测试）
 * - 铁律 #3: 事件必须广播（5 测试）
 * - 铁律 #4: 持久化优先（3 测试）
 * - 核心功能（19 测试）
 * - constructor（1 测试）
 * - Shadow node integration — WP2 新增（5 测试）
 *
 * 总计：45 测试
 *
 * 参考：
 * - spec v2: .task_state/spec/nodesm.md
 * - types.ts（ground truth for 字段名 / 事件类型名）
 * - errors.ts::getValidNextNodeStatuses()（ground truth for 转移规则）
 *
 * 设计决策：
 * - FAILED 是"语义终态"（isNodeTerminalStatus=true）但有合法重试转移（RUNNING, ABORTED）
 *   → FAILED → invalid_target 抛 NodeTerminalViolationError
 *   → FAILED → RUNNING / ABORTED 是合法 fallback rerun
 * - Shadow 节点路径复用 NodeStatus 枚举（字符串同值），经 unknown 桥接后复用 pathTo()
 */

import { describe, expect, it } from 'bun:test'
import {
  NodeStatus,
  NodeTransition,
  NodeType,
  FallbackTrigger,
  ShadowNodeStatus,
} from '../types'
import type { NodeStateData, NodeEvent } from '../types'
import type { IEventBus, IStatePersister } from '../IStateMachine'
import {
  InvalidNodeTransitionError,
  NodeTerminalViolationError,
  StateNotPersistedError,
} from '../errors'
import { NodeStateMachine } from '../NodeStateMachine'

// ============================================================================
// Mock 工厂与常量
// ============================================================================

const WORKFLOW_ID = 'wf-nsm-test'

/**
 * 本地扩展的 mock persister（WP1 不修改 IStateMachine.ts，仅测试内部使用）
 */
interface TestPersister extends IStatePersister {
  writes: Array<{ workflowId: string; nodeName: string; state: NodeStateData }>
  writeNodeState(
    workflowId: string,
    nodeName: string,
    state: NodeStateData
  ): Promise<void>
  readNodeState(
    workflowId: string,
    nodeName: string
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

function createMockPersister(opts?: {
  failOnWrite?: boolean
  /** 成功写入 N 次后开始失败（用于测试 rollback：register 成功但 transition 失败） */
  failAfterWrites?: number
}): TestPersister {
  const writes: Array<{ workflowId: string; nodeName: string; state: NodeStateData }> = []
  const state = new Map<string, NodeStateData>()
  let writeCount = 0
  return {
    writes,
    writeWorkflowState: async () => {},
    readWorkflowState: async () => null,
    deleteWorkflowState: async () => {},
    listWorkflowIds: async () => [],
    writeNodeState: async (wfId, nodeName, nodeState) => {
      writes.push({ workflowId: wfId, nodeName, state: nodeState })
      writeCount++
      if (opts?.failOnWrite) throw new Error('persist fail')
      if (
        opts?.failAfterWrites !== undefined &&
        writeCount > opts.failAfterWrites
      ) {
        throw new Error('persist fail')
      }
      state.set(`${wfId}:${nodeName}`, nodeState)
    },
    readNodeState: async (wfId, nodeName) =>
      state.get(`${wfId}:${nodeName}`) || null,
  }
}

// ============================================================================
// 测试辅助
// ============================================================================

/**
 * 根据 from→to 返回对应的 NodeTransition 触发器
 */
function transitionFor(
  from: NodeStatus,
  to: NodeStatus
): NodeTransition {
  if (from === NodeStatus.PENDING && to === NodeStatus.QUEUED)
    return NodeTransition.DEPENDENCIES_MET
  if (from === NodeStatus.PENDING && to === NodeStatus.RUNNING)
    return NodeTransition.DEPENDENCIES_MET
  if (from === NodeStatus.PENDING && to === NodeStatus.SKIPPED)
    return NodeTransition.SKIP_ON_FAILURE
  if (from === NodeStatus.QUEUED && to === NodeStatus.RUNNING)
    return NodeTransition.DEPENDENCIES_MET
  if (from === NodeStatus.QUEUED && to === NodeStatus.SKIPPED)
    return NodeTransition.SKIP_ON_FAILURE
  if (from === NodeStatus.RUNNING && to === NodeStatus.COMPLETED)
    return NodeTransition.DAG_COMPLETED
  if (from === NodeStatus.RUNNING && to === NodeStatus.FAILED)
    return NodeTransition.EXEC_FAILED
  if (from === NodeStatus.RUNNING && to === NodeStatus.PAUSED)
    return NodeTransition.WORKFLOW_PAUSED
  if (from === NodeStatus.PAUSED && to === NodeStatus.RUNNING)
    return NodeTransition.WORKFLOW_RESUMED
  if (from === NodeStatus.FAILED && to === NodeStatus.RUNNING)
    return NodeTransition.FALLBACK_RERUN
  if (from === NodeStatus.FAILED && to === NodeStatus.ABORTED)
    return NodeTransition.FALLBACK_ABORT
  return NodeTransition.DEPENDENCIES_MET
}

/**
 * 返回从 PENDING 到达 target 所需的转移序列（不含 PENDING 自身）
 */
function pathTo(target: NodeStatus): NodeStatus[] {
  switch (target) {
    case NodeStatus.PENDING:
      return []
    case NodeStatus.QUEUED:
      return [NodeStatus.QUEUED]
    case NodeStatus.RUNNING:
      return [NodeStatus.RUNNING]
    case NodeStatus.PAUSED:
      return [NodeStatus.RUNNING, NodeStatus.PAUSED]
    case NodeStatus.COMPLETED:
      return [NodeStatus.RUNNING, NodeStatus.COMPLETED]
    case NodeStatus.FAILED:
      return [NodeStatus.RUNNING, NodeStatus.FAILED]
    case NodeStatus.ABORTED:
      return [NodeStatus.RUNNING, NodeStatus.FAILED, NodeStatus.ABORTED]
    case NodeStatus.SKIPPED:
      return [NodeStatus.SKIPPED]
    default:
      return []
  }
}

/**
 * 在给定 NodeStateMachine 中注册一个节点并将其推进到 targetStatus。
 * 每一步都走 transition()，依赖已实现的 registerNode + transition。
 */
async function setupNode(
  sm: NodeStateMachine,
  branch: string,
  nodeName: string,
  targetStatus: NodeStatus
): Promise<void> {
  await sm.registerNode(WORKFLOW_ID, branch, nodeName, false)
  let current = NodeStatus.PENDING
  for (const next of pathTo(targetStatus)) {
    await sm.transition({
      workflowId: WORKFLOW_ID,
      nodeName,
      fromStatus: current,
      toStatus: next,
      transition: transitionFor(current, next),
    })
    current = next
  }
}

// ============================================================================
// 被测主体工厂
// ============================================================================

function buildSm(opts?: { failOnWrite?: boolean }) {
  const eventBus = createMockEventBus()
  const persister = createMockPersister(opts)
  const sm = new NodeStateMachine(WORKFLOW_ID, eventBus, persister)
  return { sm, eventBus, persister }
}

// ============================================================================
// 测试套件
// ============================================================================

describe('NodeStateMachine', () => {
  // ==========================================================================
  // 铁律 #1: 状态机不可绕过（5 测试）
  // ==========================================================================
  describe('铁律 #1: 状态机不可绕过', () => {
    it('should throw InvalidNodeTransitionError on PENDING → COMPLETED', async () => {
      const { sm } = buildSm()
      await sm.registerNode(WORKFLOW_ID, 'main', 'n1', false)
      expect(
        sm.transition({
          workflowId: WORKFLOW_ID,
          nodeName: 'n1',
          fromStatus: NodeStatus.PENDING,
          toStatus: NodeStatus.COMPLETED,
          transition: NodeTransition.DAG_COMPLETED,
        })
      ).rejects.toBeInstanceOf(InvalidNodeTransitionError)
    })

    it('should throw InvalidNodeTransitionError on RUNNING → SKIPPED', async () => {
      const { sm } = buildSm()
      await setupNode(sm, 'main', 'n1', NodeStatus.RUNNING)
      expect(
        sm.transition({
          workflowId: WORKFLOW_ID,
          nodeName: 'n1',
          fromStatus: NodeStatus.RUNNING,
          toStatus: NodeStatus.SKIPPED,
          transition: NodeTransition.SKIP_ON_FAILURE,
        })
      ).rejects.toBeInstanceOf(InvalidNodeTransitionError)
    })

    it('should throw InvalidNodeTransitionError on PAUSED → COMPLETED', async () => {
      const { sm } = buildSm()
      await setupNode(sm, 'main', 'n1', NodeStatus.PAUSED)
      expect(
        sm.transition({
          workflowId: WORKFLOW_ID,
          nodeName: 'n1',
          fromStatus: NodeStatus.PAUSED,
          toStatus: NodeStatus.COMPLETED,
          transition: NodeTransition.DAG_COMPLETED,
        })
      ).rejects.toBeInstanceOf(InvalidNodeTransitionError)
    })

    // ground code: QUEUED valid→[RUNNING, SKIPPED]; FAILED ∉ valid; QUEUED 非终态
    // → InvalidNodeTransitionError（非 NodeTerminalViolationError）
    it('should throw InvalidNodeTransitionError on QUEUED → FAILED', async () => {
      const { sm } = buildSm()
      await setupNode(sm, 'main', 'n1', NodeStatus.QUEUED)
      expect(
        sm.transition({
          workflowId: WORKFLOW_ID,
          nodeName: 'n1',
          fromStatus: NodeStatus.QUEUED,
          toStatus: NodeStatus.FAILED,
          transition: NodeTransition.EXEC_FAILED,
        })
      ).rejects.toBeInstanceOf(InvalidNodeTransitionError)
    })

    // 所有 getValidNextNodeStatuses() 定义的合法转移（ground truth：errors.ts:486-509）
    it('should allow all valid transitions defined in getValidNextNodeStatuses()', async () => {
      const validPairs: Array<{ from: NodeStatus; to: NodeStatus }> = [
        { from: NodeStatus.PENDING, to: NodeStatus.QUEUED },
        { from: NodeStatus.PENDING, to: NodeStatus.RUNNING },
        { from: NodeStatus.PENDING, to: NodeStatus.SKIPPED },
        { from: NodeStatus.QUEUED, to: NodeStatus.RUNNING },
        { from: NodeStatus.QUEUED, to: NodeStatus.SKIPPED },
        { from: NodeStatus.RUNNING, to: NodeStatus.COMPLETED },
        { from: NodeStatus.RUNNING, to: NodeStatus.FAILED },
        { from: NodeStatus.RUNNING, to: NodeStatus.PAUSED },
        { from: NodeStatus.PAUSED, to: NodeStatus.RUNNING },
        { from: NodeStatus.FAILED, to: NodeStatus.RUNNING },
        { from: NodeStatus.FAILED, to: NodeStatus.ABORTED },
      ]
      for (const { from, to } of validPairs) {
        const { sm } = buildSm()
        await setupNode(sm, 'main', `n-${from}-${to}`, from)
        await expect(
          sm.transition({
            workflowId: WORKFLOW_ID,
            nodeName: `n-${from}-${to}`,
            fromStatus: from,
            toStatus: to,
            transition: transitionFor(from, to),
          })
        ).resolves.toBeUndefined()
      }
    })
  })

  // ==========================================================================
  // 铁律 #2: 终态不可逆（4 测试）
  //
  // 算法 B：isNodeTerminalStatus(fromStatus) && toStatus ∉ valid
  //   → NodeTerminalViolationError
  // FAILED 是"语义终态"但 valid=[RUNNING, ABORTED]：
  //   FAILED→COMPLETED 不在 valid → NodeTerminalViolationError
  //   FAILED→RUNNING 在 valid → 合法（fallback rerun）
  // ==========================================================================
  describe('铁律 #2: 终态不可逆', () => {
    it('should throw NodeTerminalViolationError on COMPLETED → any', async () => {
      const { sm } = buildSm()
      await setupNode(sm, 'main', 'n1', NodeStatus.COMPLETED)
      expect(
        sm.transition({
          workflowId: WORKFLOW_ID,
          nodeName: 'n1',
          fromStatus: NodeStatus.COMPLETED,
          toStatus: NodeStatus.RUNNING,
          transition: NodeTransition.DEPENDENCIES_MET,
        })
      ).rejects.toBeInstanceOf(NodeTerminalViolationError)
    })

    // FAILED 是语义终态；FAILED→COMPLETED 不在 valid=[RUNNING, ABORTED]
    // → NodeTerminalViolationError（区别于 FAILED→RUNNING 的合法 fallback）
    it('should throw NodeTerminalViolationError on FAILED → COMPLETED', async () => {
      const { sm } = buildSm()
      await setupNode(sm, 'main', 'n1', NodeStatus.FAILED)
      expect(
        sm.transition({
          workflowId: WORKFLOW_ID,
          nodeName: 'n1',
          fromStatus: NodeStatus.FAILED,
          toStatus: NodeStatus.COMPLETED,
          transition: NodeTransition.DAG_COMPLETED,
        })
      ).rejects.toBeInstanceOf(NodeTerminalViolationError)
    })

    it('should throw NodeTerminalViolationError on ABORTED → any', async () => {
      const { sm } = buildSm()
      await setupNode(sm, 'main', 'n1', NodeStatus.ABORTED)
      expect(
        sm.transition({
          workflowId: WORKFLOW_ID,
          nodeName: 'n1',
          fromStatus: NodeStatus.ABORTED,
          toStatus: NodeStatus.RUNNING,
          transition: NodeTransition.DEPENDENCIES_MET,
        })
      ).rejects.toBeInstanceOf(NodeTerminalViolationError)
    })

    it('should throw NodeTerminalViolationError on SKIPPED → any', async () => {
      const { sm } = buildSm()
      await setupNode(sm, 'main', 'n1', NodeStatus.SKIPPED)
      expect(
        sm.transition({
          workflowId: WORKFLOW_ID,
          nodeName: 'n1',
          fromStatus: NodeStatus.SKIPPED,
          toStatus: NodeStatus.RUNNING,
          transition: NodeTransition.DEPENDENCIES_MET,
        })
      ).rejects.toBeInstanceOf(NodeTerminalViolationError)
    })
  })

  // ==========================================================================
  // 铁律 #3: 事件必须广播（5 测试）
  //
  // 事件类型名严格按 types.ts（ground truth）：
  //   spec 的 "node.start"   → types.ts 的 "node.started"
  //   spec 的 "node.complete" → types.ts 的 "node.completed"
  //   spec 的 "node.push"    → types.ts 的 "node.pushed"
  //   spec 的 "node.reset"   → types.ts 无对应；通过 as unknown 桥接
  // ==========================================================================
  describe('铁律 #3: 事件必须广播', () => {
    it('should emit node.started on PENDING → RUNNING', async () => {
      const { sm, eventBus } = buildSm()
      await sm.registerNode(WORKFLOW_ID, 'main', 'n1', false)
      eventBus.events.length = 0
      await sm.transition({
        workflowId: WORKFLOW_ID,
        nodeName: 'n1',
        fromStatus: NodeStatus.PENDING,
        toStatus: NodeStatus.RUNNING,
        transition: NodeTransition.DEPENDENCIES_MET,
      })
      expect(eventBus.events.some((e: any) => e.type === 'node.started')).toBe(
        true
      )
    })

    it('should emit node.completed on RUNNING → COMPLETED', async () => {
      const { sm, eventBus } = buildSm()
      await setupNode(sm, 'main', 'n1', NodeStatus.RUNNING)
      eventBus.events.length = 0
      await sm.transition({
        workflowId: WORKFLOW_ID,
        nodeName: 'n1',
        fromStatus: NodeStatus.RUNNING,
        toStatus: NodeStatus.COMPLETED,
        transition: NodeTransition.DAG_COMPLETED,
        output: { summary: 'done' },
      })
      expect(
        eventBus.events.some((e: any) => e.type === 'node.completed')
      ).toBe(true)
    })

    it('should emit node.registered on registerNode()', async () => {
      const { sm, eventBus } = buildSm()
      await sm.registerNode(WORKFLOW_ID, 'main', 'n1', false)
      expect(
        eventBus.events.some((e: any) => e.type === 'node.registered')
      ).toBe(true)
    })

    // resetNode 发出的事件类型 'node.reset' 不在 ground types.ts NodeEvent union；
    // 实现通过 as unknown as NodeEvent 桥接，测试断言 type 字符串
    it('should emit node.reset on resetNode()', async () => {
      const { sm, eventBus } = buildSm()
      await setupNode(sm, 'main', 'n1', NodeStatus.FAILED)
      eventBus.events.length = 0
      await sm.resetNode('n1')
      expect(eventBus.events.some((e: any) => e.type === 'node.reset')).toBe(
        true
      )
    })

    it('should emit node.pushed on incrementPushCount()', async () => {
      const { sm, eventBus } = buildSm()
      await setupNode(sm, 'main', 'n1', NodeStatus.RUNNING)
      eventBus.events.length = 0
      await sm.incrementPushCount('n1', 'review feedback')
      expect(
        eventBus.events.some((e: any) => e.type === 'node.pushed')
      ).toBe(true)
    })
  })

  // ==========================================================================
  // 铁律 #4: 持久化优先（3 测试）
  // ==========================================================================
  describe('铁律 #4: 持久化优先', () => {
    it('should persist state before updating memory', async () => {
      const { sm, persister } = buildSm()
      await sm.registerNode(WORKFLOW_ID, 'main', 'n1', false)
      persister.writes.length = 0
      await sm.transition({
        workflowId: WORKFLOW_ID,
        nodeName: 'n1',
        fromStatus: NodeStatus.PENDING,
        toStatus: NodeStatus.RUNNING,
        transition: NodeTransition.DEPENDENCIES_MET,
      })
      // 持久化已调用
      expect(persister.writes.length).toBeGreaterThanOrEqual(1)
      const writtenState = persister.writes[persister.writes.length - 1].state
      // 内存状态与持久化一致
      const memoryState = await sm.getNodeState('n1')
      expect(memoryState?.status).toBe(writtenState.status)
      expect(memoryState?.status).toBe(NodeStatus.RUNNING)
    })

    it('should emit event after successful persist', async () => {
      const { sm, eventBus, persister } = buildSm()
      await sm.registerNode(WORKFLOW_ID, 'main', 'n1', false)
      persister.writes.length = 0
      eventBus.events.length = 0
      await sm.transition({
        workflowId: WORKFLOW_ID,
        nodeName: 'n1',
        fromStatus: NodeStatus.PENDING,
        toStatus: NodeStatus.RUNNING,
        transition: NodeTransition.DEPENDENCIES_MET,
      })
      // 持久化先发生，事件后发出
      expect(persister.writes.length).toBe(1)
      expect(eventBus.events.length).toBe(1)
    })

    it('should not update memory if persist fails (rollback)', async () => {
      // failAfterWrites: 1 → registerNode (write #1) 成功，transition (write #2) 失败
      const failBus = createMockEventBus()
      const failPersister = createMockPersister({ failAfterWrites: 1 })
      const smFail = new NodeStateMachine(WORKFLOW_ID, failBus, failPersister)
      await smFail.registerNode(WORKFLOW_ID, 'main', 'n1', false)
      const stateBefore = await smFail.getNodeState('n1')
      expect(stateBefore?.status).toBe(NodeStatus.PENDING)
      // transition 持久化失败 → 内存不变，抛 StateNotPersistedError，事件不发出
      await expect(
        smFail.transition({
          workflowId: WORKFLOW_ID,
          nodeName: 'n1',
          fromStatus: NodeStatus.PENDING,
          toStatus: NodeStatus.RUNNING,
          transition: NodeTransition.DEPENDENCIES_MET,
        })
      ).rejects.toBeInstanceOf(StateNotPersistedError)
      const stateAfter = await smFail.getNodeState('n1')
      expect(stateAfter?.status).toBe(NodeStatus.PENDING)
      // transition 事件未发出（registerNode 的 node.registered 不计入）
      const transitionEvents = failBus.events.filter(
        (e: any) => e.type !== 'node.registered'
      )
      expect(transitionEvents.length).toBe(0)
    })
  })

  // ==========================================================================
  // 核心功能（19 测试）
  // ==========================================================================
  describe('transition()', () => {
    it('should update status on valid PENDING → RUNNING', async () => {
      const { sm } = buildSm()
      await sm.registerNode(WORKFLOW_ID, 'main', 'n1', false)
      await sm.transition({
        workflowId: WORKFLOW_ID,
        nodeName: 'n1',
        fromStatus: NodeStatus.PENDING,
        toStatus: NodeStatus.RUNNING,
        transition: NodeTransition.DEPENDENCIES_MET,
      })
      const state = await sm.getNodeState('n1')
      expect(state?.status).toBe(NodeStatus.RUNNING)
      expect(state?.started_at).not.toBeNull()
    })

    it('should update output_summary on RUNNING → COMPLETED', async () => {
      const { sm } = buildSm()
      await setupNode(sm, 'main', 'n1', NodeStatus.RUNNING)
      await sm.transition({
        workflowId: WORKFLOW_ID,
        nodeName: 'n1',
        fromStatus: NodeStatus.RUNNING,
        toStatus: NodeStatus.COMPLETED,
        transition: NodeTransition.DAG_COMPLETED,
        output: { files_changed: ['src/foo.ts'] },
      })
      const state = await sm.getNodeState('n1')
      expect(state?.status).toBe(NodeStatus.COMPLETED)
      expect(state?.output_summary).toEqual({ files_changed: ['src/foo.ts'] })
      expect(state?.completed_at).not.toBeNull()
    })
  })

  describe('getNodeState()', () => {
    it('should return state for existing node', async () => {
      const { sm } = buildSm()
      await sm.registerNode(WORKFLOW_ID, 'main', 'n1', false)
      const state = await sm.getNodeState('n1')
      expect(state).not.toBeNull()
      expect(state?.node_name).toBe('n1')
      expect(state?.status).toBe(NodeStatus.PENDING)
    })

    it('should return null for non-existing node', async () => {
      const { sm } = buildSm()
      const state = await sm.getNodeState('non-existent')
      expect(state).toBeNull()
    })
  })

  describe('getBranchState()', () => {
    it('should aggregate single branch state', async () => {
      const { sm } = buildSm()
      await sm.registerNode(WORKFLOW_ID, 'dev', 'n1', false)
      await sm.registerNode(WORKFLOW_ID, 'dev', 'n2', false)
      const branch = await sm.getBranchState('dev')
      expect(branch).not.toBeNull()
      expect(branch?.branch_name).toBe('dev')
      expect(Object.keys(branch?.nodes ?? {})).toEqual(
        expect.arrayContaining(['n1', 'n2'])
      )
    })

    it('should aggregate multiple branches independently', async () => {
      const { sm } = buildSm()
      await sm.registerNode(WORKFLOW_ID, 'dev', 'n1', false)
      await sm.registerNode(WORKFLOW_ID, 'qa', 'n2', false)
      const dev = await sm.getBranchState('dev')
      const qa = await sm.getBranchState('qa')
      expect(dev?.nodes['n1']).toBeDefined()
      expect(dev?.nodes['n2']).toBeUndefined()
      expect(qa?.nodes['n2']).toBeDefined()
      expect(qa?.nodes['n1']).toBeUndefined()
    })

    it('should return null for empty (non-existing) branch', async () => {
      const { sm } = buildSm()
      const branch = await sm.getBranchState('non-existent')
      expect(branch).toBeNull()
    })
  })

  describe('registerNode()', () => {
    it('should register node with PENDING status', async () => {
      const { sm } = buildSm()
      await sm.registerNode(WORKFLOW_ID, 'main', 'n1', false)
      const state = await sm.getNodeState('n1')
      expect(state?.status).toBe(NodeStatus.PENDING)
      expect(state?.node_type).toBe(NodeType.NORMAL)
      expect(state?.pushed_count).toBe(0)
      expect(state?.fallback_count).toBe(0)
    })

    it('should throw if node already registered', async () => {
      const { sm } = buildSm()
      await sm.registerNode(WORKFLOW_ID, 'main', 'n1', false)
      expect(
        sm.registerNode(WORKFLOW_ID, 'main', 'n1', false)
      ).rejects.toThrow(/already registered/i)
    })

    it('should throw if workflowId mismatches', async () => {
      const { sm } = buildSm()
      expect(
        sm.registerNode('wrong-workflow', 'main', 'n1', false)
      ).rejects.toThrow(/workflow/i)
    })
  })

  describe('resetNode()', () => {
    // admin bypass：跳过铁律 #1/#2，但保留 #3（事件）/#4（持久化）
    it('should reset FAILED node to PENDING (admin bypass)', async () => {
      const { sm } = buildSm()
      await setupNode(sm, 'main', 'n1', NodeStatus.FAILED)
      await sm.resetNode('n1')
      const state = await sm.getNodeState('n1')
      expect(state?.status).toBe(NodeStatus.PENDING)
      expect(state?.pushed_count).toBe(0)
      expect(state?.fallback_count).toBe(0)
      expect(state?.started_at).toBeNull()
      expect(state?.completed_at).toBeNull()
    })

    // admin bypass 允许从终态 COMPLETED 重置（绕过铁律 #2）
    it('should reset COMPLETED node to PENDING (admin bypass, bypasses iron law #2)', async () => {
      const { sm } = buildSm()
      await setupNode(sm, 'main', 'n1', NodeStatus.COMPLETED)
      await sm.resetNode('n1')
      const state = await sm.getNodeState('n1')
      expect(state?.status).toBe(NodeStatus.PENDING)
    })

    it('should throw if node does not exist', async () => {
      const { sm } = buildSm()
      expect(sm.resetNode('non-existent')).rejects.toThrow(/not found/i)
    })
  })

  describe('skipNode()', () => {
    it('should mark node as SKIPPED with reason', async () => {
      const { sm } = buildSm()
      await sm.registerNode(WORKFLOW_ID, 'main', 'n1', false)
      await sm.skipNode('n1', 'upstream-failed')
      const state = await sm.getNodeState('n1')
      expect(state?.status).toBe(NodeStatus.SKIPPED)
      expect(state?.skipped_by).toBe('upstream-failed')
    })

    // Iron Law #1: skipNode 不得绕过状态机转移规则
    // getValidNextNodeStatuses(NORMAL, RUNNING) = [COMPLETED, FAILED, PAUSED]
    // SKIPPED ∉ valid → InvalidNodeTransitionError
    it('should throw InvalidNodeTransitionError from RUNNING', async () => {
      const { sm } = buildSm()
      await setupNode(sm, 'main', 'n1', NodeStatus.RUNNING)
      await expect(
        sm.skipNode('n1', 'upstream-failed')
      ).rejects.toBeInstanceOf(InvalidNodeTransitionError)
    })

    // getValidNextNodeStatuses(NORMAL, COMPLETED) = []
    // SKIPPED ∉ valid → InvalidNodeTransitionError
    it('should throw InvalidNodeTransitionError from COMPLETED', async () => {
      const { sm } = buildSm()
      await setupNode(sm, 'main', 'n1', NodeStatus.COMPLETED)
      await expect(
        sm.skipNode('n1', 'upstream-failed')
      ).rejects.toBeInstanceOf(InvalidNodeTransitionError)
    })

    // getValidNextNodeStatuses(NORMAL, FAILED) = [RUNNING, ABORTED]
    // SKIPPED ∉ valid → InvalidNodeTransitionError
    it('should throw InvalidNodeTransitionError from FAILED', async () => {
      const { sm } = buildSm()
      await setupNode(sm, 'main', 'n1', NodeStatus.FAILED)
      await expect(
        sm.skipNode('n1', 'upstream-failed')
      ).rejects.toBeInstanceOf(InvalidNodeTransitionError)
    })
  })

  describe('incrementPushCount()', () => {
    it('should increment pushed_count + 1', async () => {
      const { sm } = buildSm()
      await setupNode(sm, 'main', 'n1', NodeStatus.RUNNING)
      await sm.incrementPushCount('n1', 'review feedback')
      const state = await sm.getNodeState('n1')
      expect(state?.pushed_count).toBe(1)
      await sm.incrementPushCount('n1', 'review feedback 2')
      const state2 = await sm.getNodeState('n1')
      expect(state2?.pushed_count).toBe(2)
    })
  })

  describe('incrementFallbackCount()', () => {
    it('should increment fallback_count + 1', async () => {
      const { sm } = buildSm()
      await setupNode(sm, 'main', 'n1', NodeStatus.FAILED)
      await sm.incrementFallbackCount('n1')
      const state = await sm.getNodeState('n1')
      expect(state?.fallback_count).toBe(1)
      await sm.incrementFallbackCount('n1')
      const state2 = await sm.getNodeState('n1')
      expect(state2?.fallback_count).toBe(2)
    })
  })

  describe('areAllRequiredNodesCompleted()', () => {
    it('should return true when all required nodes completed', async () => {
      const { sm } = buildSm()
      await setupNode(sm, 'main', 'n1', NodeStatus.COMPLETED)
      await setupNode(sm, 'main', 'n2', NodeStatus.COMPLETED)
      const result = await sm.areAllRequiredNodesCompleted(['n1', 'n2'])
      expect(result).toBe(true)
    })

    it('should return false when some required nodes incomplete', async () => {
      const { sm } = buildSm()
      await setupNode(sm, 'main', 'n1', NodeStatus.COMPLETED)
      await setupNode(sm, 'main', 'n2', NodeStatus.RUNNING)
      const result = await sm.areAllRequiredNodesCompleted(['n1', 'n2'])
      expect(result).toBe(false)
    })

    it('should return false when node does not exist', async () => {
      const { sm } = buildSm()
      await setupNode(sm, 'main', 'n1', NodeStatus.COMPLETED)
      const result = await sm.areAllRequiredNodesCompleted([
        'n1',
        'non-existent',
      ])
      expect(result).toBe(false)
    })
  })

  // ==========================================================================
  // 构造与基本约束
  // ==========================================================================
  describe('constructor', () => {
    it('should throw if workflowId is empty', () => {
      expect(() => new NodeStateMachine('')).toThrow(/workflowId/i)
    })
  })

  // ==========================================================================
  // Shadow 节点集成（P2-5）
  //
  // 铁律仍然适用：
  //   - #1: getValidNextNodeStatuses(NodeType.SHADOW, ...) 决定合法转移
  //   - #2: ShadowNodeStatus.COMPLETED / FAILED 是终态
  //   - #3: 事件名仍按 types.ts NodeEvent union
  //   - #4: persistAndApply() 同样服务于 Shadow 节点
  // ==========================================================================
  describe('Shadow node integration', () => {
    /**
     * 注册一个 shadow 节点并将其推进至 targetStatus。
     * pathTo() 的 NodeStatus 字符串与 ShadowNodeStatus 在 PENDING/RUNNING/COMPLETED/FAILED 上同值，
     * 故可复用 setupNode 辅助函数。
     */
    async function setupShadowNode(
      sm: NodeStateMachine,
      branch: string,
      nodeName: string,
      targetStatus:
        | typeof ShadowNodeStatus.PENDING
        | typeof ShadowNodeStatus.RUNNING
        | typeof ShadowNodeStatus.COMPLETED
        | typeof ShadowNodeStatus.FAILED
    ): Promise<void> {
      await sm.registerNode(WORKFLOW_ID, branch, nodeName, true)
      let current = NodeStatus.PENDING
      // 复用 pathTo；ShadowNodeStatus 与 NodeStatus 在 PENDING/RUNNING/COMPLETED/FAILED 上字符串同值，
      // 故经 unknown 桥接到 NodeStatus 以复用辅助函数（非 as any）
      for (const next of pathTo(targetStatus as unknown as NodeStatus)) {
        await sm.transition({
          workflowId: WORKFLOW_ID,
          nodeName,
          fromStatus: current,
          toStatus: next,
          transition: transitionFor(current, next),
        })
        current = next
      }
    }

    it('should register a SHADOW node with correct node_type', async () => {
      const { sm } = buildSm()
      await sm.registerNode(WORKFLOW_ID, 'shadow-branch', 's1', true)
      const state = await sm.getNodeState('s1')
      expect(state).not.toBeNull()
      expect(state?.node_type).toBe(NodeType.SHADOW)
      expect(state?.status).toBe(NodeStatus.PENDING)
    })

    it('should transition shadow node PENDING → RUNNING → COMPLETED', async () => {
      const { sm, eventBus } = buildSm()
      await setupShadowNode(sm, 'shadow-branch', 's1', ShadowNodeStatus.COMPLETED)
      const state = await sm.getNodeState('s1')
      expect(state?.status).toBe(NodeStatus.COMPLETED)
      expect(state?.node_type).toBe(NodeType.SHADOW)
      // 铁律 #3: 应已广播 node.started + node.completed 两个事件
      const startedEvts = eventBus.events.filter(
        (e: any) => e.type === 'node.started'
      )
      const completedEvts = eventBus.events.filter(
        (e: any) => e.type === 'node.completed'
      )
      expect(startedEvts.length).toBeGreaterThanOrEqual(1)
      expect(completedEvts.length).toBeGreaterThanOrEqual(1)
    })

    it('should transition shadow node PENDING → RUNNING → FAILED', async () => {
      const { sm, eventBus } = buildSm()
      await setupShadowNode(sm, 'shadow-branch', 's1', ShadowNodeStatus.FAILED)
      const state = await sm.getNodeState('s1')
      expect(state?.status).toBe(NodeStatus.FAILED)
      expect(state?.node_type).toBe(NodeType.SHADOW)
      // 铁律 #3: 应已广播 node.failed
      const failedEvts = eventBus.events.filter(
        (e: any) => e.type === 'node.failed'
      )
      expect(failedEvts.length).toBeGreaterThanOrEqual(1)
    })

    it('should throw NodeTerminalViolationError from shadow COMPLETED → RUNNING', async () => {
      const { sm } = buildSm()
      await setupShadowNode(sm, 'shadow-branch', 's1', ShadowNodeStatus.COMPLETED)
      await expect(
        sm.transition({
          workflowId: WORKFLOW_ID,
          nodeName: 's1',
          fromStatus: NodeStatus.COMPLETED,
          toStatus: NodeStatus.RUNNING,
          transition: NodeTransition.DEPENDENCIES_MET,
        })
      ).rejects.toBeInstanceOf(NodeTerminalViolationError)
    })

    it('should enforce Iron Law #1: shadow PENDING → COMPLETED is invalid', async () => {
      const { sm } = buildSm()
      await sm.registerNode(WORKFLOW_ID, 'shadow-branch', 's1', true)
      // getValidNextNodeStatuses(SHADOW, PENDING) = [RUNNING]；COMPLETED ∉ valid
      await expect(
        sm.transition({
          workflowId: WORKFLOW_ID,
          nodeName: 's1',
          fromStatus: NodeStatus.PENDING,
          toStatus: NodeStatus.COMPLETED,
          transition: NodeTransition.DAG_COMPLETED,
        })
      ).rejects.toBeInstanceOf(InvalidNodeTransitionError)
    })
  })
})
