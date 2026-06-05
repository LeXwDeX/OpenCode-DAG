/**
 * @file State Machine Interface
 * @description DAG 状态机核心接口定义
 * 
 * 参考：workflow-dag-architecture.md §3B
 * 
 * 设计原则：
 * 1. 接口分离：状态转移、事件广播、持久化分离为独立接口
 * 2. 铁律约束：通过接口设计强制保证状态机铁律
 * 3. 可扩展性：支持 Workflow/Node/Shadow 三级状态机
 */

import type {
  WorkflowStatus,
  NodeStatus,
  ShadowNodeStatus,
  WorkflowStateData,
  NodeStateData,
  BranchStateData,
  WorkflowEvent,
  NodeEvent,
  WorkflowTransition,
  NodeTransition,
  FallbackTrigger,
} from './types';
import type { WorktreeEvent } from '../worktree-manager/types';
import type { GroupEvent } from '../group-manager/types';

// ============================================================================
// 1. 事件总线接口
// ============================================================================

/**
 * 事件监听器
 */
export type EventEmitter = (event: WorkflowEvent | NodeEvent | GroupEvent | WorktreeEvent) => void;

/**
 * 取消监听函数
 */
export type UnsubscribeFunction = () => void;

/**
 * 事件总线接口
 * 
 * 铁律：事件必须广播（所有状态转移必须发出对应 event）
 * 
 * @example
 * ```typescript
 * const unsubscribe = eventBus.subscribe('workflow.completed', (event) => {
 *   console.log('Workflow completed:', event.workflow_id);
 * });
 * 
 * // 取消订阅
 * unsubscribe();
 * ```
 */
export interface IEventBus {
  /**
   * 订阅事件
   * 
   * @param event - 事件类型（支持通配符 '*' 匹配所有事件）
   * @param listener - 事件监听器
   * @returns 取消订阅函数
   */
  subscribe(event: string, listener: EventEmitter): UnsubscribeFunction;

  /**
   * 广播事件
   * 
   * @param event - 事件对象
   */
  emit(event: WorkflowEvent | NodeEvent | GroupEvent | WorktreeEvent): void;

  /**
   * 清理事件总线
   */
  destroy(): void;
}

// ============================================================================
// 2. 状态持久化接口
// ============================================================================

/**
 * 状态持久化接口
 * 
 * 铁律：状态持久化优先（状态转移必须先写入 state.json，再广播 event）
 * 
 * 实现策略：
 * - 写入操作必须是原子的（使用 write-then-rename 模式）
 * - 读取操作支持缓存（提高性能）
 * - 所有操作支持异步
 * 
 * @example
 * ```typescript
 * await persister.writeWorkflowState(workflowId, state);
 * const state = await persister.readWorkflowState(workflowId);
 * ```
 */
export interface IStatePersister {
  /**
   * 写入 Workflow 状态
   * 
   * @param workflowId - Workflow ID
   * @param state - Workflow 状态数据
   * @throws StateNotPersistedError - 持久化失败
   */
  writeWorkflowState(
    workflowId: string,
    state: WorkflowStateData
  ): Promise<void>;

  /**
   * 读取 Workflow 状态
   * 
   * @param workflowId - Workflow ID
   * @returns Workflow 状态数据（如果不存在返回 null）
   */
  readWorkflowState(workflowId: string): Promise<WorkflowStateData | null>;

  /**
   * 删除 Workflow 状态
   * 
   * @param workflowId - Workflow ID
   */
  deleteWorkflowState(workflowId: string): Promise<void>;

  /**
   * 列出所有 Workflow 状态
   * 
   * @returns Workflow ID 列表
   */
  listWorkflowIds(): Promise<string[]>;
}

// ============================================================================
// 3. Workflow 状态机接口
// ============================================================================

/**
 * Workflow 状态转移参数
 */
export interface WorkflowTransitionParams {
  fromStatus: WorkflowStatus;
  toStatus: WorkflowStatus;
  transition: WorkflowTransition;
  reason?: string;
  timestamp?: Date;
}

/**
 * Workflow 状态机接口
 * 
 * 铁律：
 * - 状态机不可绕过（所有转移必须通过引擎 API）
 * - 终态不可逆（COMPLETED/FAILED/CANCELLED/ARCHIVED 不可回退）
 * 
 * 实现要求：
 * - 转移前验证合法性（检查 state machine rules）
 * - 转移后立即持久化（先写 state.json）
 * - 持久化成功后广播事件（再广播 event）
 * 
 * @example
 * ```typescript
 * const workflowSM = new WorkflowStateMachine(workflowId, eventBus, persister);
 * 
 * // 状态转移
 * await workflowSM.transition({
 *   fromStatus: WorkflowStatus.PENDING,
 *   toStatus: WorkflowStatus.RUNNING,
 *   transition: WorkflowTransition.DAG_EXECUTE,
 * });
 * 
 * // 查询状态
 * const status = await workflowSM.getStatus();
 * ```
 */
export interface IWorkflowStateMachine {
  /**
   * 获取当前状态
   */
  getStatus(): Promise<WorkflowStatus>;

  /**
   * 状态转移（含持久化与事件广播）
   * 
   * 执行顺序：验证 → 读取现有状态 → 合并 → 持久化 → 更新内存 → 广播事件
   * 
   * @param params - 转移参数
   * @throws {InvalidWorkflowTransitionError} 非法转移
   * @throws {WorkflowTerminalViolationError} 终态违规
   * @throws {StateNotPersistedError} 当状态持久化失败时抛出
   * @throws {Error} 当 readWorkflowState 读取失败时抛出（由下层 persister 抛出，不静默降级）
   */
  transition(params: WorkflowTransitionParams): Promise<void>;

  /**
   * 更新状态（用于初始化或修复）
   * 
   * 注意：此方法不验证合法性，仅用于初始化或异常恢复。
   * 正常使用应通过 transition() 方法。
   * 
   * @param status - 新状态
   */
  updateStatus(status: WorkflowStatus): Promise<void>;
}

// ============================================================================
// 4. Node 状态机接口
// ============================================================================

/**
 * Node 状态转移参数
 */
export interface NodeTransitionParams {
  workflowId: string;
  nodeName: string;
  fromStatus: NodeStatus | ShadowNodeStatus;
  toStatus: NodeStatus | ShadowNodeStatus;
  transition: NodeTransition;
  reason?: string;
  timestamp?: Date;
  /** 节点输出（仅 completed 状态） */
  output?: any;
  /** Diff 统计（仅 completed 状态） */
  diffStats?: any;
  /** Fallback 触发原因（用于 node.failed 事件 payload） */
  fallbackTrigger?: FallbackTrigger;
  /** 重试计数（用于 node.restarted 事件 payload） */
  retryCount?: number;
  /** 中止原因（用于 node.aborted 事件 payload） */
  abortReason?: string;
  /** 上游失败节点名（用于 node.skipped 事件 payload，经 transition 路径） */
  upstreamFailedNode?: string;
  /** 工作树路径（用于 node.started 事件 payload） */
  worktreePath?: string;
}

/**
 * Node 状态机接口
 * 
 * 铁律：
 * - 状态机不可绕过
 * - 终态不可逆（COMPLETED/FAILED/ABORTED/SKIPPED 不可回退）
 * 
 * 实现要求：
 * - 支持普通节点和 Shadow 节点
 * - 自动聚合 Branch 状态
 * - 自动聚合 Workflow 状态
 * 
 * @example
 * ```typescript
 * const nodeSM = new NodeStateMachine(workflowId, eventBus, persister);
 * 
 * // 状态转移
 * await nodeSM.transition({
 *   workflowId,
 *   nodeName: 'implement',
 *   fromStatus: NodeStatus.RUNNING,
 *   toStatus: NodeStatus.COMPLETED,
 *   transition: NodeTransition.DEPENDENCIES_MET,
 *   output: { files: ['src/foo.ts'] },
 * });
 * 
 * // 查询节点状态
 * const nodeState = await nodeSM.getNodeState('implement');
 * 
 * // 查询分支状态
 * const branchState = await nodeSM.getBranchState('dev');
 * 
 * // 查询所有节点状态
 * const allNodes = await nodeSM.getAllNodeStates();
 * ```
 */
export interface INodeStateMachine {
  /**
   * 节点状态转移
   * 
   * @param params - 转移参数
   * @throws InvalidNodeTransitionError - 非法转移
   * @throws NodeTerminalViolationError - 终态违规
   */
  transition(params: NodeTransitionParams): Promise<void>;

  /**
   * 获取节点状态
   * 
   * @param nodeName - 节点名称
   * @returns 节点状态数据（不存在返回 null）
   */
  getNodeState(nodeName: string): Promise<NodeStateData | null>;

  /**
   * 获取分支状态
   * 
   * @param branchName - 分支名称
   * @returns 分支状态数据（不存在返回 null）
   */
  getBranchState(branchName: string): Promise<BranchStateData | null>;

  /**
   * 获取所有节点状态
   * 
   * @returns 所有节点状态（按分支分组）
   */
  getAllNodeStates(): Promise<Record<string, BranchStateData>>;

  /**
   * 注册新节点
   * 
   * @param workflowId - Workflow ID
   * @param branchName - 分支名称
   * @param nodeName - 节点名称
   * @param isShadow - 是否为 Shadow 节点
   */
  registerNode(
    workflowId: string,
    branchName: string,
    nodeName: string,
    isShadow: boolean
  ): Promise<void>;

  /**
   * 重置节点（用于 Fallback）
   * 
   * @param nodeName - 节点名称
   */
  resetNode(nodeName: string): Promise<void>;

  /**
   * 跳过节点（上游失败时）
   * 
   * @param nodeName - 节点名称
   * @param reason - 跳过原因
   */
  skipNode(nodeName: string, reason: string): Promise<void>;

  /**
   * 增加 Push 计数
   * 
   * @param nodeName - 节点名称
   * @param reason - Push 原因
   */
  incrementPushCount(nodeName: string, reason: string): Promise<void>;

  /**
   * 增加 Fallback 计数
   * 
   * @param nodeName - 节点名称
   */
  incrementFallbackCount(nodeName: string): Promise<void>;

  /**
   * 检查是否所有 required_nodes 已完成
   * 
   * @param requiredNodes - 必需节点列表
   * @returns 是否全部完成
   */
  areAllRequiredNodesCompleted(requiredNodes: string[]): Promise<boolean>;
}

// ============================================================================
// 5. 状态机工厂接口
// ============================================================================

/**
 * 状态机工厂接口
 * 
 * @example
 * ```typescript
 * const factory = new StateMachineFactory(eventBus, persister);
 * 
 * // 创建 Workflow 状态机
 * const workflowSM = factory.createWorkflowStateMachine(workflowId);
 * 
 * // 创建 Node 状态机
 * const nodeSM = factory.createNodeStateMachine(workflowId);
 * ```
 */
export interface IStateMachineFactory {
  /**
   * 创建 Workflow 状态机
   * 
   * @param workflowId - Workflow ID
   */
  createWorkflowStateMachine(workflowId: string): IWorkflowStateMachine;

  /**
   * 创建 Node 状态机
   * 
   * @param workflowId - Workflow ID
   */
  createNodeStateMachine(workflowId: string): INodeStateMachine;
}

// ============================================================================
// 6. 依赖注入容器接口
// ============================================================================

/**
 * 依赖注入容器接口
 * 
 * 用于解耦状态机的依赖，支持测试和扩展。
 * 
 * @example
 * ```typescript
 * const container = new DIContainer();
 * container.bind('eventBus', new EventBus());
 * container.bind('persister', new FileStatePersister());
 * container.bind('factory', new StateMachineFactory(container.get('eventBus'), container.get('persister')));
 * 
 * const factory = container.get<IStateMachineFactory>('factory');
 * ```
 */
export interface IDIContainer {
  /**
   * 绑定依赖
   * 
   * @param key - 依赖名称
   * @param instance - 依赖实例
   */
  bind<T>(key: string, instance: T): void;

  /**
   * 获取依赖
   * 
   * @param key - 依赖名称
   * @returns 依赖实例
   * @throws Error - 依赖不存在
   */
  get<T>(key: string): T;

  /**
   * 检查依赖是否存在
   * 
   * @param key - 依赖名称
   */
  has(key: string): boolean;

  /**
   * 清理事记容器
   */
  destroy(): void;
}
