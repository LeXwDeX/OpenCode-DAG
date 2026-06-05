/**
 * @file State Machine Tests
 * @description DAG 状态机单元测试
 * 
 * 参考：workflow-dag-architecture.md §3B
 * 
 * 铁律检查：
 * - #15: 状态机不可绕过
 * - #16: 终态不可逆
 * - #17: 事件必须广播
 * - #18: 状态持久化优先
 */

import { describe, expect, it } from 'bun:test';
import {
  WorkflowStatus,
  NodeStatus,
  ShadowNodeStatus,
  NodeType,
  WorkflowTransition,
  NodeTransition,
  FallbackTrigger,
} from './types';
import type {
  WorkflowEvent,
  NodeEvent,
  WorkflowStateData,
  BranchStateData,
} from './types';
import {
  InvalidWorkflowTransitionError,
  WorkflowTerminalViolationError,
  InvalidNodeTransitionError,
  NodeTerminalViolationError,
  MissingRequiredNodeError,
  StateNotPersistedError,
  ErrorCode,
  isWorkflowTerminalStatus,
  isNodeTerminalStatus,
  getValidNextWorkflowStatuses,
  getValidNextNodeStatuses,
} from './errors';
import type { IEventBus, IStatePersister, UnsubscribeFunction } from './IStateMachine';
import { WorkflowStateMachine } from './WorkflowStateMachine';

// ============================================================================
// 1. Workflow 状态机测试
// ============================================================================

describe('WorkflowStateMachine', () => {
  describe('状态转移规则', () => {
    it('应该允许从 PENDING 转移到 RUNNING', () => {
      const validNext = getValidNextWorkflowStatuses(WorkflowStatus.PENDING);
      expect(validNext).toContain(WorkflowStatus.RUNNING);
    });

    it('应该允许从 RUNNING 转移到 PAUSED', () => {
      const validNext = getValidNextWorkflowStatuses(WorkflowStatus.RUNNING);
      expect(validNext).toContain(WorkflowStatus.PAUSED);
    });

    it('应该允许从 RUNNING 转移到 COMPLETED', () => {
      const validNext = getValidNextWorkflowStatuses(WorkflowStatus.RUNNING);
      expect(validNext).toContain(WorkflowStatus.COMPLETED);
    });

    it('应该允许从 RUNNING 转移到 FAILED', () => {
      const validNext = getValidNextWorkflowStatuses(WorkflowStatus.RUNNING);
      expect(validNext).toContain(WorkflowStatus.FAILED);
    });

    it('应该允许从 RUNNING 转移到 CANCELLED', () => {
      const validNext = getValidNextWorkflowStatuses(WorkflowStatus.RUNNING);
      expect(validNext).toContain(WorkflowStatus.CANCELLED);
    });

    it('应该允许从 PAUSED 转移到 RUNNING', () => {
      const validNext = getValidNextWorkflowStatuses(WorkflowStatus.PAUSED);
      expect(validNext).toContain(WorkflowStatus.RUNNING);
    });

    it('应该允许从 COMPLETED 转移到 ARCHIVED', () => {
      const validNext = getValidNextWorkflowStatuses(WorkflowStatus.COMPLETED);
      expect(validNext).toContain(WorkflowStatus.ARCHIVED);
    });

    it('应该允许从 FAILED 转移到 ARCHIVED', () => {
      const validNext = getValidNextWorkflowStatuses(WorkflowStatus.FAILED);
      expect(validNext).toContain(WorkflowStatus.ARCHIVED);
    });

    it('应该允许从 CANCELLED 转移到 ARCHIVED', () => {
      const validNext = getValidNextWorkflowStatuses(WorkflowStatus.CANCELLED);
      expect(validNext).toContain(WorkflowStatus.ARCHIVED);
    });

    it('不应该允许从 ARCHIVED 转移到其他状态', () => {
      const validNext = getValidNextWorkflowStatuses(WorkflowStatus.ARCHIVED);
      expect(validNext).toHaveLength(0);
    });
  });

  describe('终态检测', () => {
    it('应该正确识别 COMPLETED 为终态', () => {
      expect(isWorkflowTerminalStatus(WorkflowStatus.COMPLETED)).toBe(true);
    });

    it('应该正确识别 FAILED 为终态', () => {
      expect(isWorkflowTerminalStatus(WorkflowStatus.FAILED)).toBe(true);
    });

    it('应该正确识别 CANCELLED 为终态', () => {
      expect(isWorkflowTerminalStatus(WorkflowStatus.CANCELLED)).toBe(true);
    });

    it('应该正确识别 ARCHIVED 为终态', () => {
      expect(isWorkflowTerminalStatus(WorkflowStatus.ARCHIVED)).toBe(true);
    });

    it('应该正确识别 RUNNING 为非终态', () => {
      expect(isWorkflowTerminalStatus(WorkflowStatus.RUNNING)).toBe(false);
    });

    it('应该正确识别 PENDING 为非终态', () => {
      expect(isWorkflowTerminalStatus(WorkflowStatus.PENDING)).toBe(false);
    });

    it('应该正确识别 PAUSED 为非终态', () => {
      expect(isWorkflowTerminalStatus(WorkflowStatus.PAUSED)).toBe(false);
    });
  });
});

// ============================================================================
// 2. Node 状态机测试
// ============================================================================

describe('NodeStateMachine', () => {
  const nodeType = NodeType.NORMAL;
  
  describe('状态转移规则', () => {
    it('应该允许从 PENDING 转移到 RUNNING', () => {
      const validNext = getValidNextNodeStatuses(nodeType, NodeStatus.PENDING);
      expect(validNext).toContain(NodeStatus.RUNNING);
    });

    it('应该允许从 PENDING 转移到 SKIPPED', () => {
      const validNext = getValidNextNodeStatuses(nodeType, NodeStatus.PENDING);
      expect(validNext).toContain(NodeStatus.SKIPPED);
    });

    it('应该允许从 RUNNING 转移到 COMPLETED', () => {
      const validNext = getValidNextNodeStatuses(nodeType, NodeStatus.RUNNING);
      expect(validNext).toContain(NodeStatus.COMPLETED);
    });

    it('应该允许从 RUNNING 转移到 FAILED', () => {
      const validNext = getValidNextNodeStatuses(nodeType, NodeStatus.RUNNING);
      expect(validNext).toContain(NodeStatus.FAILED);
    });

    it('应该允许从 RUNNING 转移到 PAUSED', () => {
      const validNext = getValidNextNodeStatuses(nodeType, NodeStatus.RUNNING);
      expect(validNext).toContain(NodeStatus.PAUSED);
    });

    it('应该允许从 PAUSED 转移到 RUNNING', () => {
      const validNext = getValidNextNodeStatuses(nodeType, NodeStatus.PAUSED);
      expect(validNext).toContain(NodeStatus.RUNNING);
    });

    it('应该允许从 FAILED 转移到 RUNNING（fallback rerun）', () => {
      const validNext = getValidNextNodeStatuses(nodeType, NodeStatus.FAILED);
      expect(validNext).toContain(NodeStatus.RUNNING);
    });

    it('应该允许从 FAILED 转移到 ABORTED（fallback abort）', () => {
      const validNext = getValidNextNodeStatuses(nodeType, NodeStatus.FAILED);
      expect(validNext).toContain(NodeStatus.ABORTED);
    });

    it('不应该允许从 COMPLETED 转移到其他状态', () => {
      const validNext = getValidNextNodeStatuses(nodeType, NodeStatus.COMPLETED);
      expect(validNext).toHaveLength(0);
    });

    it('不应该允许从 ABORTED 转移到其他状态', () => {
      const validNext = getValidNextNodeStatuses(nodeType, NodeStatus.ABORTED);
      expect(validNext).toHaveLength(0);
    });

    it('不应该允许从 SKIPPED 转移到其他状态', () => {
      const validNext = getValidNextNodeStatuses(nodeType, NodeStatus.SKIPPED);
      expect(validNext).toHaveLength(0);
    });
  });

  describe('终态检测', () => {
    it('应该正确识别 COMPLETED 为终态', () => {
      expect(isNodeTerminalStatus(NodeStatus.COMPLETED)).toBe(true);
    });

    it('应该正确识别 FAILED 为终态', () => {
      expect(isNodeTerminalStatus(NodeStatus.FAILED)).toBe(true);
    });

    it('应该正确识别 ABORTED 为终态', () => {
      expect(isNodeTerminalStatus(NodeStatus.ABORTED)).toBe(true);
    });

    it('应该正确识别 SKIPPED 为终态', () => {
      expect(isNodeTerminalStatus(NodeStatus.SKIPPED)).toBe(true);
    });

    it('应该正确识别 RUNNING 为非终态', () => {
      expect(isNodeTerminalStatus(NodeStatus.RUNNING)).toBe(false);
    });

    it('应该正确识别 PENDING 为非终态', () => {
      expect(isNodeTerminalStatus(NodeStatus.PENDING)).toBe(false);
    });

    it('应该正确识别 PAUSED 为非终态', () => {
      expect(isNodeTerminalStatus(NodeStatus.PAUSED)).toBe(false);
    });
  });
});

// ============================================================================
// 3. Shadow Node 状态机测试
// ============================================================================

describe('ShadowNodeStateMachine', () => {
  const nodeType = NodeType.SHADOW;
  
  describe('状态转移规则', () => {
    it('应该允许从 PENDING 转移到 RUNNING', () => {
      const validNext = getValidNextNodeStatuses(nodeType, ShadowNodeStatus.PENDING);
      expect(validNext).toContain(ShadowNodeStatus.RUNNING);
    });

    it('应该允许从 RUNNING 转移到 COMPLETED', () => {
      const validNext = getValidNextNodeStatuses(nodeType, ShadowNodeStatus.RUNNING);
      expect(validNext).toContain(ShadowNodeStatus.COMPLETED);
    });

    it('应该允许从 RUNNING 转移到 FAILED', () => {
      const validNext = getValidNextNodeStatuses(nodeType, ShadowNodeStatus.RUNNING);
      expect(validNext).toContain(ShadowNodeStatus.FAILED);
    });

    it('不应该允许从 COMPLETED 转移到其他状态', () => {
      const validNext = getValidNextNodeStatuses(nodeType, ShadowNodeStatus.COMPLETED);
      expect(validNext).toHaveLength(0);
    });

    it('不应该允许从 FAILED 转移到其他状态', () => {
      const validNext = getValidNextNodeStatuses(nodeType, ShadowNodeStatus.FAILED);
      expect(validNext).toHaveLength(0);
    });

    it('Shadow 节点不应该有 PAUSED 状态', () => {
      expect(Object.values(ShadowNodeStatus)).not.toContain('paused');
    });

    it('Shadow 节点不应该有 SKIPPED 状态', () => {
      expect(Object.values(ShadowNodeStatus)).not.toContain('skipped');
    });

    it('Shadow 节点不应该有 ABORTED 状态', () => {
      expect(Object.values(ShadowNodeStatus)).not.toContain('aborted');
    });
  });
});

// ============================================================================
// 4. 错误类测试
// ============================================================================

describe('Error Classes', () => {
  describe('InvalidWorkflowTransitionError', () => {
    it('应该包含正确的错误信息', () => {
      const error = new InvalidWorkflowTransitionError(
        WorkflowStatus.COMPLETED,
        WorkflowStatus.RUNNING,
        WorkflowTransition.DAG_EXECUTE
      );
      
      expect(error.message).toContain(WorkflowStatus.COMPLETED);
      expect(error.message).toContain(WorkflowStatus.RUNNING);
      expect(error.fromStatus).toBe(WorkflowStatus.COMPLETED);
      expect(error.toStatus).toBe(WorkflowStatus.RUNNING);
    });
  });

  describe('WorkflowTerminalViolationError', () => {
    it('应该包含正确的错误信息', () => {
      const error = new WorkflowTerminalViolationError(
        WorkflowStatus.COMPLETED,
        WorkflowStatus.RUNNING
      );
      
      expect(error.message).toContain(WorkflowStatus.COMPLETED);
      expect(error.currentStatus).toBe(WorkflowStatus.COMPLETED);
      expect(error.attemptedStatus).toBe(WorkflowStatus.RUNNING);
    });
  });

  describe('InvalidNodeTransitionError', () => {
    it('应该包含正确的错误信息', () => {
      const error = new InvalidNodeTransitionError(
        'implement_node',
        NodeStatus.COMPLETED,
        NodeStatus.RUNNING,
        NodeTransition.DEPENDENCIES_MET
      );
      
      expect(error.message).toContain(NodeStatus.COMPLETED);
      expect(error.message).toContain(NodeStatus.RUNNING);
      expect(error.message).toContain('implement_node');
      expect(error.fromStatus).toBe(NodeStatus.COMPLETED);
      expect(error.toStatus).toBe(NodeStatus.RUNNING);
      expect(error.nodeName).toBe('implement_node');
    });
  });

  describe('NodeTerminalViolationError', () => {
    it('应该包含正确的错误信息', () => {
      const error = new NodeTerminalViolationError(
        'implement_node',
        NodeStatus.COMPLETED,
        NodeStatus.RUNNING
      );
      
      expect(error.message).toContain(NodeStatus.COMPLETED);
      expect(error.message).toContain('implement_node');
      expect(error.currentStatus).toBe(NodeStatus.COMPLETED);
      expect(error.attemptedStatus).toBe(NodeStatus.RUNNING);
      expect(error.nodeName).toBe('implement_node');
    });
  });

  describe('MissingRequiredNodeError', () => {
    it('应该包含正确的错误信息', () => {
      const error = new MissingRequiredNodeError('skeleton');
      
      expect(error.message).toContain('skeleton');
      expect(error.requiredNodeName).toBe('skeleton');
    });
  });

  describe('StateNotPersistedError', () => {
    it('应该包含 workflowId 和错误信息', () => {
      const error = new StateNotPersistedError('wf-123', 'disk full');

      expect(error.message).toContain('wf-123');
      expect(error.message).toContain('disk full');
      expect(error.workflowId).toBe('wf-123');
      expect(error.code).toBe(ErrorCode.STATE_NOT_PERSISTED);
      expect(error.name).toBe('StateNotPersistedError');
    });

    it('无 reason 时应该使用默认消息', () => {
      const error = new StateNotPersistedError('wf-456');

      expect(error.message).toContain('wf-456');
      expect(error.workflowId).toBe('wf-456');
    });
  });
});

// ============================================================================
// 5. 类型定义测试
// ============================================================================

describe('Type Definitions', () => {
  describe('WorkflowStatus', () => {
    it('应该包含所有 7 种状态', () => {
      expect(Object.values(WorkflowStatus)).toHaveLength(7);
      expect(WorkflowStatus.PENDING).toBe(WorkflowStatus.PENDING);
      expect(WorkflowStatus.RUNNING).toBe(WorkflowStatus.RUNNING);
      expect(WorkflowStatus.PAUSED).toBe(WorkflowStatus.PAUSED);
      expect(WorkflowStatus.COMPLETED).toBe(WorkflowStatus.COMPLETED);
      expect(WorkflowStatus.FAILED).toBe(WorkflowStatus.FAILED);
      expect(WorkflowStatus.CANCELLED).toBe(WorkflowStatus.CANCELLED);
      expect(WorkflowStatus.ARCHIVED).toBe(WorkflowStatus.ARCHIVED);
    });
  });

  describe('NodeStatus', () => {
    it('应该包含所有 8 种状态', () => {
      expect(Object.values(NodeStatus)).toHaveLength(8);
      expect(NodeStatus.PENDING).toBe(NodeStatus.PENDING);
      expect(NodeStatus.QUEUED).toBe(NodeStatus.QUEUED);
      expect(NodeStatus.RUNNING).toBe(NodeStatus.RUNNING);
      expect(NodeStatus.PAUSED).toBe(NodeStatus.PAUSED);
      expect(NodeStatus.COMPLETED).toBe(NodeStatus.COMPLETED);
      expect(NodeStatus.FAILED).toBe(NodeStatus.FAILED);
      expect(NodeStatus.ABORTED).toBe(NodeStatus.ABORTED);
      expect(NodeStatus.SKIPPED).toBe(NodeStatus.SKIPPED);
    });
  });

  describe('ShadowNodeStatus', () => {
    it('应该包含所有 4 种状态', () => {
      expect(Object.values(ShadowNodeStatus)).toHaveLength(4);
      expect(ShadowNodeStatus.PENDING).toBe(ShadowNodeStatus.PENDING);
      expect(ShadowNodeStatus.RUNNING).toBe(ShadowNodeStatus.RUNNING);
      expect(ShadowNodeStatus.COMPLETED).toBe(ShadowNodeStatus.COMPLETED);
      expect(ShadowNodeStatus.FAILED).toBe(ShadowNodeStatus.FAILED);
    });
  });

  describe('NodeType', () => {
    it('应该包含 NORMAL 和 SHADOW 两种类型', () => {
      expect(Object.values(NodeType)).toHaveLength(2);
      expect(NodeType.NORMAL).toBe(NodeType.NORMAL);
      expect(NodeType.SHADOW).toBe(NodeType.SHADOW);
    });
  });

  describe('FallbackTrigger', () => {
    it('应该包含所有 4 种触发条件', () => {
      expect(Object.values(FallbackTrigger)).toHaveLength(4);
      expect(FallbackTrigger.EXEC_FAILED).toBe(FallbackTrigger.EXEC_FAILED);
      expect(FallbackTrigger.PUSH_EXHAUSTED).toBe(FallbackTrigger.PUSH_EXHAUSTED);
      expect(FallbackTrigger.VERDICT_FAIL).toBe(FallbackTrigger.VERDICT_FAIL);
      expect(FallbackTrigger.TIMEOUT).toBe(FallbackTrigger.TIMEOUT);
    });

    it('TIMEOUT 值应该等于 "timeout"', () => {
      expect(Object.values(FallbackTrigger)).toContain('timeout' as FallbackTrigger);
    });
  });

  describe('NodeEvent node.timeout', () => {
    it('应该支持 node.timeout 事件类型', () => {
      const event: NodeEvent = {
        type: 'node.timeout',
        workflow_id: 'wf-123',
        node_name: 'implement',
        timeout_sec: 300,
      };

      expect(event.type).toBe('node.timeout');
      expect(event.workflow_id).toBe('wf-123');
      expect(event.node_name).toBe('implement');
      expect(event.timeout_sec).toBe(300);
    });

    it('node.timeout 事件应包含所有必需字段', () => {
      const event: NodeEvent = {
        type: 'node.timeout',
        workflow_id: 'wf-456',
        node_name: 'review',
        timeout_sec: 600,
      };

      expect(Object.keys(event).sort()).toEqual(
        ['node_name', 'timeout_sec', 'type', 'workflow_id']
      );
    });
  });
});

// ============================================================================
// 6. 持久化优先测试（铁律 #18）
// ============================================================================

function createStubEventBus() {
  const callLog: Array<{ method: string; args: unknown[] }> = [];
  const bus: IEventBus = {
    subscribe(_event: string, _listener: unknown): UnsubscribeFunction {
      return () => {};
    },
    emit(event: WorkflowEvent | NodeEvent): void {
      callLog.push({ method: 'emit', args: [event] });
    },
    destroy(): void {},
  };
  return { bus, callLog };
}

function createStubPersister(opts?: { shouldFail?: boolean; failReason?: string }) {
  const callLog: Array<{ method: string; args: unknown[] }> = [];
  const persister: IStatePersister = {
    async writeWorkflowState(workflowId: string, state: WorkflowStateData): Promise<void> {
      callLog.push({ method: 'writeWorkflowState', args: [workflowId, state] });
      if (opts?.shouldFail) {
        throw new Error(opts.failReason ?? 'persist error');
      }
    },
    async readWorkflowState(_workflowId: string): Promise<WorkflowStateData | null> {
      return null;
    },
    async deleteWorkflowState(_workflowId: string): Promise<void> {},
    async listWorkflowIds(): Promise<string[]> {
      return [];
    },
  };
  return { persister, callLog };
}

describe('持久化优先（铁律 #18）', () => {
  it('persist-first: persister.writeWorkflowState 应该先于 eventBus.emit 被调用', async () => {
    const { bus, callLog: busLog } = createStubEventBus();
    const { persister, callLog: persistLog } = createStubPersister();
    const machine = new WorkflowStateMachine('wf-order', bus, persister);
    machine.initialize(WorkflowStatus.PENDING);

    const timestamp = new Date('2026-01-01');
    const mergedLog: Array<{ call: string }> = [];
    busLog.length = 0;
    persistLog.length = 0;

    // Wrap to track cross-source ordering
    const origEmit = bus.emit;
    bus.emit = (event: WorkflowEvent | NodeEvent) => {
      mergedLog.push({ call: 'emit' });
      origEmit(event);
    };
    const origPersist = persister.writeWorkflowState.bind(persister);
    persister.writeWorkflowState = async (wfId: string, state: WorkflowStateData) => {
      mergedLog.push({ call: 'persist' });
      return origPersist(wfId, state);
    };

    await machine.transition({
      fromStatus: WorkflowStatus.PENDING,
      toStatus: WorkflowStatus.RUNNING,
      transition: WorkflowTransition.DAG_EXECUTE,
      timestamp,
    });

    expect(mergedLog).toEqual([{ call: 'persist' }, { call: 'emit' }]);
  });

  it('persist failure: 持久化失败时应该抛出 StateNotPersistedError 且状态不变', async () => {
    const { bus, callLog: busLog } = createStubEventBus();
    const { persister } = createStubPersister({ shouldFail: true, failReason: 'disk full' });
    const machine = new WorkflowStateMachine('wf-fail', bus, persister);
    machine.initialize(WorkflowStatus.PENDING);

    await expect(
      machine.transition({
        fromStatus: WorkflowStatus.PENDING,
        toStatus: WorkflowStatus.RUNNING,
        transition: WorkflowTransition.DAG_EXECUTE,
      })
    ).rejects.toBeInstanceOf(StateNotPersistedError);

    // 状态不变 — 仍然是 PENDING
    const statusAfter = await machine.getStatus();
    expect(statusAfter).toBe(WorkflowStatus.PENDING);

    // 事件不应被广播
    expect(busLog.length).toBe(0);
  });

  it('persist success: 持久化成功后应该正常广播事件并更新状态', async () => {
    const { bus, callLog: busLog } = createStubEventBus();
    const { persister, callLog: persistLog } = createStubPersister();
    const machine = new WorkflowStateMachine('wf-ok', bus, persister);
    machine.initialize(WorkflowStatus.PENDING);

    const timestamp = new Date('2026-06-01');
    await machine.transition({
      fromStatus: WorkflowStatus.PENDING,
      toStatus: WorkflowStatus.RUNNING,
      transition: WorkflowTransition.DAG_EXECUTE,
      timestamp,
    });

    // 状态已更新
    expect(await machine.getStatus()).toBe(WorkflowStatus.RUNNING);

    // 持久化被调用
    expect(persistLog.length).toBe(1);
    expect(persistLog[0]!.method).toBe('writeWorkflowState');

    // 事件被广播
    expect(busLog.length).toBe(1);
    const emitted = busLog[0]!.args[0] as WorkflowEvent;
    expect(emitted.type).toBe('workflow.started');
  });
});

// ============================================================================
// 7. 状态累积保持测试（buildStateSnapshot 正确性）
// ============================================================================

function createStatefulStubPersister(initial?: WorkflowStateData) {
  let storedState: WorkflowStateData | null = initial ?? null;
  const persister: IStatePersister = {
    async writeWorkflowState(_workflowId: string, state: WorkflowStateData): Promise<void> {
      storedState = state;
    },
    async readWorkflowState(_workflowId: string): Promise<WorkflowStateData | null> {
      return storedState;
    },
    async deleteWorkflowState(_workflowId: string): Promise<void> {
      storedState = null;
    },
    async listWorkflowIds(): Promise<string[]> {
      return storedState ? [storedState.workflow_id] : [];
    },
  };
  return {
    persister,
    get lastWrittenState() { return storedState; },
  };
}

describe('buildStateSnapshot 状态累积保持', () => {
  it('多次 transition 后 started_at 保持首次值且 paused_at 正确更新', async () => {
    const { bus } = createStubEventBus();
    const statefulPersister = createStatefulStubPersister();
    const machine = new WorkflowStateMachine('wf-1', bus, statefulPersister.persister);
    machine.initialize(WorkflowStatus.PENDING);

    // 首次 transition: PENDING → RUNNING
    await machine.transition({
      fromStatus: WorkflowStatus.PENDING,
      toStatus: WorkflowStatus.RUNNING,
      transition: WorkflowTransition.DAG_EXECUTE,
      timestamp: new Date('2026-01-01T10:00:00Z'),
    });

    // 第二次 transition: RUNNING → PAUSED
    await machine.transition({
      fromStatus: WorkflowStatus.RUNNING,
      toStatus: WorkflowStatus.PAUSED,
      transition: WorkflowTransition.DAG_PAUSE,
      timestamp: new Date('2026-01-01T10:05:00Z'),
    });

    const finalState = statefulPersister.lastWrittenState;
    // started_at 保持首次 transition 的时间（不被覆盖为第二次时间）
    expect(finalState!.started_at).toBe('2026-01-01T10:00:00.000Z');
    expect(finalState!.paused_at).toBe('2026-01-01T10:05:00.000Z');
    expect(finalState!.status).toBe(WorkflowStatus.PAUSED);
  });

  it('transition 保留 branches 和 accumulated_diff 不被清空', async () => {
    const initialBranches: Record<string, BranchStateData> = {
      'feature-a': {
        branch_name: 'feature-a',
        status: NodeStatus.COMPLETED,
        nodes: {},
      },
    };
    const initial: WorkflowStateData = {
      workflow_id: 'wf-1',
      status: WorkflowStatus.RUNNING,
      started_at: '2026-01-01T10:00:00.000Z',
      paused_at: null,
      completed_at: null,
      branches: initialBranches,
      accumulated_diff: 'src/a.ts',
    };

    const { bus } = createStubEventBus();
    const statefulPersister = createStatefulStubPersister(initial);
    const machine = new WorkflowStateMachine('wf-1', bus, statefulPersister.persister);
    machine.initialize(WorkflowStatus.RUNNING);

    await machine.transition({
      fromStatus: WorkflowStatus.RUNNING,
      toStatus: WorkflowStatus.PAUSED,
      transition: WorkflowTransition.DAG_PAUSE,
      timestamp: new Date('2026-01-01T10:05:00Z'),
    });

    const finalState = statefulPersister.lastWrittenState;
    expect(finalState!.branches).toEqual(initialBranches);
    expect(finalState!.accumulated_diff).toBe('src/a.ts');
    expect(finalState!.started_at).toBe('2026-01-01T10:00:00.000Z');
    expect(finalState!.status).toBe(WorkflowStatus.PAUSED);
  });

  it('readWorkflowState 异常不被静默降级，向上层抛出', async () => {
    const { bus } = createStubEventBus();
    const persister: IStatePersister = {
      async readWorkflowState(_workflowId: string): Promise<WorkflowStateData | null> {
        throw new Error('DB connection lost');
      },
      async writeWorkflowState(_workflowId: string, _state: WorkflowStateData): Promise<void> {},
      async deleteWorkflowState(_workflowId: string): Promise<void> {},
      async listWorkflowIds(): Promise<string[]> {
        return [];
      },
    };

    const machine = new WorkflowStateMachine('wf-1', bus, persister);
    machine.initialize(WorkflowStatus.PENDING);

    await expect(
      machine.transition({
        fromStatus: WorkflowStatus.PENDING,
        toStatus: WorkflowStatus.RUNNING,
        transition: WorkflowTransition.DAG_EXECUTE,
        timestamp: new Date('2026-01-01T10:00:00Z'),
      })
    ).rejects.toThrow('DB connection lost');
  });
});
