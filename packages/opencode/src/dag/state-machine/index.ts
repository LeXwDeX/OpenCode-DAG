/**
 * @file State Machine Module Entry
 * @description DAG 状态机模块入口文件
 * 
 * 本模块实现了 DAG 工作流的状态机核心逻辑，包括：
 * - Workflow/Node/Shadow 三级状态定义
 * - 状态转移规则验证
 * - 事件广播机制
 * - 状态持久化接口
 * 
 * 参考：workflow-dag-architecture.md §3B
 * 
 * 铁律：
 * - 状态机不可绕过
 * - 终态不可逆
 * - 事件必须广播
 * - 状态持久化优先
 */

// ============================================================================
// 1. 类型导出
// ============================================================================

export {
  // 状态枚举
  WorkflowStatus,
  NodeStatus,
  ShadowNodeStatus,
  
  // 状态转移触发条件
  WorkflowTransition,
  NodeTransition,
  FallbackTrigger,
  
  // 事件类型
  type WorkflowEvent,
  type NodeEvent,
  
  // 状态数据接口
  type NodeStateData,
  type BranchStateData,
  type WorkflowStateData,
  type DiffStats,
} from './types';

// ============================================================================
// 2. 错误类导出
// ============================================================================

export {
  // 错误代码
  ErrorCode,
  
  // 基础错误类
  StateMachineError,
  
  // Workflow 级错误
  InvalidWorkflowTransitionError,
  WorkflowTerminalViolationError,
  MissingRequiredNodeError,
  StateNotPersistedError,
  
  // Node 级错误
  InvalidNodeTransitionError,
  NodeTerminalViolationError,
  DuplicateNodeNameError,
  DependencyNotMetError,
  FallbackDepthExceededError,
  PushCountExceededError,
  
  // 工具函数
  isWorkflowTerminalStatus,
  isNodeTerminalStatus,
  isShadowNodeStatus,
  getValidNextNodeStatuses,
  getValidNextWorkflowStatuses,
} from './errors';

// ============================================================================
// 3. 接口导出
// ============================================================================

export type {
  // 事件总线
  EventEmitter,
  UnsubscribeFunction,
  IEventBus,
  
  // 状态持久化
  IStatePersister,
  
  // 状态机接口
  IWorkflowStateMachine,
  INodeStateMachine,
  IStateMachineFactory,
  
  // 状态转移参数
  WorkflowTransitionParams,
  NodeTransitionParams,
  
  // 依赖注入
  IDIContainer,
} from './IStateMachine';

// ============================================================================
// 4. 实现类导出
// ============================================================================

export { EventBus } from './EventBus';
export { WorkflowStateMachine } from './WorkflowStateMachine';

// ============================================================================
// 5. 常量导出
// ============================================================================

/**
 * 模块版本
 */
export const STATE_MACHINE_VERSION = '1.0.0';

/**
 * 最大 Fallback 深度
 * 
 * 铁律：Fallback 链深度超过此值时，节点进入 FAILED 状态
 */
export const MAX_FALLBACK_COUNT = 3;

/**
 * 最大 Push 计数
 * 
 * 铁律：Push 次数超过此值时，节点进入 FAILED 状态
 */
export const MAX_PUSH_COUNT = 3;

/**
 * 状态持久化超时（毫秒）
 */
export const STATE_PERSISTENCE_TIMEOUT_MS = 5000;

/**
 * 事件广播超时（毫秒）
 */
export const EVENT_BROADCAST_TIMEOUT_MS = 1000;
