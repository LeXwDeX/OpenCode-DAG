/**
 * Group Manager 类型定义
 * 
 * @module dag/group-manager/types
 */

import type { NodeStatus } from '../state-machine/types';

// ============================================================================
// 常量
// ============================================================================

/** 最大嵌套深度 */
export const MAX_NESTING_DEPTH = 5;

/** 默认最大并发数 */
export const DEFAULT_MAX_PARALLEL = Infinity;

// ============================================================================
// 基础标识
// ============================================================================

/** Group 唯一标识 */
export type GroupID = string;

/**
 * Group 状态
 *
 * 合法转移规则：
 * - pending → [running, cancelled]
 * - running → [completed, failed, cancelled]
 * - completed / failed / cancelled → [] (终态)
 */
export type GroupStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Branch 状态（与 GroupStatus 同构）
 */
export type BranchStatus = GroupStatus;

// ============================================================================
// 配置类型
// ============================================================================

/**
 * Group 配置
 *
 * 定义 Group 的创建参数，支持嵌套（sub_groups）与依赖（depends_on）。
 * - `id` 为唯一标识，在同一层级内不可重复
 * - `name` 为显示名称
 * - `parent_id` 由 createGroup 内部注入，用户无需填写
 */
export interface GroupConfig {
  /** 唯一标识 */
  id: GroupID;
  /** 显示名称 */
  name: string;
  /** 描述 */
  description?: string;
  /** 依赖的其他 Group ID 列表（运行时不可有环） */
  depends_on?: GroupID[];
  /** 父 Group ID（由 createGroup 注入） */
  parent_id?: GroupID;
  /** 嵌套子 Group 配置 */
  sub_groups?: GroupConfig[];
  /** 分支配置 */
  branches?: BranchConfig[];
  /** 环境变量（支持继承） */
  env?: Record<string, string>;
  /** Fallback 配置 */
  fallback?: FallbackConfig;
  /** Worktree 配置 */
  worktree?: WorktreeConfig;
  /** 最大并发分支数 */
  max_parallel?: number;
}

/**
 * 分支配置
 *
 * - `id` 在 Group 内唯一
 * - `name` 为显示名称
 * - `nodes` 为按顺序执行的节点名称列表
 */
export interface BranchConfig {
  /** 分支唯一标识（在 Group 内） */
  id: string;
  /** 显示名称 */
  name: string;
  /** 节点名称列表（按顺序执行） */
  nodes: string[];
}

/**
 * Fallback 配置
 *
 * - `node`: shadow 节点名称（触发 fallback 时激活的节点）
 * - `trigger`: 触发条件
 * - `condition`: 自定义条件表达式（当 trigger='custom' 时使用）
 */
export interface FallbackConfig {
  /** shadow 节点名称 */
  node: string;
  /** 触发条件 */
  trigger?: 'always' | 'on_error' | 'on_timeout' | 'custom';
  /** 自定义条件表达式（trigger='custom' 时） */
  condition?: string;
}

/**
 * Worktree 配置
 *
 * - `base_path`: worktree 基础目录
 * - `branch_prefix`: Git 分支前缀
 */
export interface WorktreeConfig {
  /** worktree 基础目录 */
  base_path: string;
  /** Git 分支前缀 */
  branch_prefix: string;
}

// ============================================================================
// 运行时类型
// ============================================================================

/**
 * Group 运行时实例
 *
 * 表示一个运行中的 Group，包含配置与实时状态。
 */
export interface Group {
  /** 唯一标识 */
  id: GroupID;
  /** 显示名称 */
  name: string;
  /** 描述 */
  description?: string;
  /** 原始配置 */
  config: GroupConfig;
  /** 当前状态 */
  status: GroupStatus;
  /** 分支实例映射（branchId → Branch） */
  branches: Map<string, Branch>;
  /** worktree 路径（如果有） */
  worktree_path?: string;
  /** 父 Group ID */
  parent_id?: GroupID;
  /** 开始时间（毫秒时间戳） */
  started_at?: number;
  /** 完成时间（毫秒时间戳） */
  completed_at?: number;
}

/**
 * Branch 运行时实例
 *
 * 表示一个运行中的分支，包含配置与实时状态。
 */
export interface Branch {
  /** 分支标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 分支配置 */
  config: BranchConfig;
  /** 当前状态 */
  status: BranchStatus;
  /** 节点状态映射（nodeName → NodeStatus） */
  nodes: Map<string, NodeStatus>;
  /** 开始时间（毫秒时间戳） */
  started_at?: number;
  /** 完成时间（毫秒时间戳） */
  completed_at?: number;
}

// ============================================================================
// 事件类型
// ============================================================================

/** Group 状态变更事件 */
export interface GroupStateChangedEvent {
  type: 'group.state_changed';
  groupId: GroupID;
  oldStatus: GroupStatus;
  newStatus: GroupStatus;
  timestamp: number;
}

/** Group 创建事件 */
export interface GroupCreatedEvent {
  type: 'group.created';
  groupId: GroupID;
  config: GroupConfig;
  timestamp: number;
}

/** Group 移除事件 */
export interface GroupRemovedEvent {
  type: 'group.removed';
  groupId: GroupID;
  timestamp: number;
}

/** Branch 状态变更事件 */
export interface BranchStateChangedEvent {
  type: 'branch.state_changed';
  groupId: GroupID;
  branchId: string;
  oldStatus: BranchStatus;
  newStatus: BranchStatus;
  timestamp: number;
}

/** Group 事件联合类型 */
export type GroupEvent =
  | GroupStateChangedEvent
  | GroupCreatedEvent
  | GroupRemovedEvent
  | BranchStateChangedEvent;

// ============================================================================
// 查询结果类型
// ============================================================================

/**
 * Group 查询结果
 *
 * 包含 Group 实例及其在层级树中的路径。
 */
export interface GroupQueryResult {
  group: Group;
  /** 从根到当前 Group 的父路径 */
  parent_path: GroupID[];
}

/**
 * Group 合并结果
 */
export interface GroupMergeResult {
  groupId: GroupID;
  success: boolean;
  merged_files: string[];
  conflicts?: Array<{
    file: string;
    reason: string;
  }>;
  message: string;
}

/**
 * Worktree 信息
 */
export interface WorktreeInfo {
  groupId: GroupID;
  path: string;
  branch: string;
  created_at: number;
}

/**
 * Fallback 执行结果
 */
export interface FallbackResult {
  groupId: GroupID;
  fallback_node: string;
  decision: 'rerun' | 'rollback' | 'abort';
  message: string;
  should_continue: boolean;
}

/**
 * 解析后的 Group 配置（已继承父级配置）
 */
export interface ResolvedGroupConfig {
  id: GroupID;
  name: string;
  env: Record<string, string>;
  fallback?: FallbackConfig;
  worktree?: WorktreeConfig;
  max_parallel?: number;
}

// ============================================================================
// 辅助类型
// ============================================================================

/** 依赖关系 */
export interface Dependency {
  from: GroupID;
  to: GroupID;
}

/** 拓扑排序结果 */
export interface TopologicalSortResult {
  sorted: GroupID[];
  cycle?: GroupID[];
}

/** 执行计划条目 */
export interface ExecutionPlan {
  node: GroupID;
  dependencies: GroupID[];
}

/** 完成策略 */
export type CompletionStrategy = 'all' | 'any' | 'first';

/** 环境变量配置 */
export type EnvironmentConfig = Record<string, string>;
