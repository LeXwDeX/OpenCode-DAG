/**
 * Group Manager 接口定义
 *
 * @module dag/group-manager/IGroupManager
 *
 * Group Manager 负责管理 DAG 中的多层级 Group 结构，包括：
 * - Group 的创建、查询、删除
 * - Group 间依赖管理（depends_on，无环依赖图）
 * - Worktree 隔离（每个 Group 独立 worktree）
 * - 环境注入（env 自动沿父链继承）
 * - Fallback 策略（Group 级别 fallback）
 * - 并发控制（max_parallel）
 * - 嵌套深度限制（≤ 5 层）
 *
 * 铁律：
 * - #15: 状态机不可绕过（所有状态变更必须经 updateGroupStatus）
 * - #16: 终态不可逆（completed/failed/cancelled 不可回退）
 * - #17: 事件必须广播（所有状态变更必须 emit GroupEvent）
 */

import type {
  Group,
  GroupConfig,
  GroupStatus,
  Branch,
  BranchConfig,
  BranchStatus,
  GroupQueryResult,
  GroupMergeResult,
  WorktreeInfo,
  FallbackResult,
  ResolvedGroupConfig,
} from './types';

/**
 * Group Manager 接口
 */
export interface IGroupManager {

  // ==========================================================================
  // Group CRUD
  // ==========================================================================

  /**
   * 创建 Group
   *
   * - 校验嵌套深度 ≤ 5
   * - 校验 depends_on 的 Group 存在
   * - 注入 parent_id
   * - 广播 group.created 事件
   */
  createGroup(config: GroupConfig): Promise<Group>;

  /**
   * 删除 Group
   *
   * - 校验无其他 Group 依赖此 Group
   * - 清理 worktree（如果有）
   */
  deleteGroup(groupId: string): Promise<void>;

  /**
   * 查询 Group（含 parent_path）
   */
  getGroup(groupId: string): Promise<GroupQueryResult>;

  /**
   * 查询所有 Groups
   */
  getAllGroups(): Promise<GroupQueryResult[]>;

  // ==========================================================================
  // Branch CRUD
  // ==========================================================================

  /**
   * 添加分支到 Group
   */
  addBranch(groupId: string, branchConfig: BranchConfig): Promise<Branch>;

  /**
   * 删除分支
   */
  deleteBranch(groupId: string, branchId: string): Promise<void>;

  /**
   * 查询分支
   */
  getBranch(groupId: string, branchId: string): Promise<Branch>;

  /**
   * 查询 Group 的所有分支
   */
  getBranches(groupId: string): Promise<Branch[]>;

  // ==========================================================================
  // 状态管理（铁律 #15 #16 #17）
  // ==========================================================================

  /**
   * 更新 Group 状态
   *
   * 铁律：
   * - #15: 验证转移合法性
   * - #16: 终态不可逆
   * - #17: 广播 group.state_changed 事件
   */
  updateGroupStatus(groupId: string, status: GroupStatus): Promise<void>;

  /**
   * 更新分支状态
   *
   * 广播 branch.state_changed 事件
   */
  updateBranchStatus(
    groupId: string,
    branchId: string,
    status: BranchStatus
  ): Promise<void>;

  // ==========================================================================
  // 依赖管理
  // ==========================================================================

  /**
   * 获取 Group 的依赖列表
   */
  getDependencies(groupId: string): Promise<string[]>;

  /**
   * 添加依赖（校验无环）
   */
  addDependency(groupId: string, dependsOn: string[]): Promise<void>;

  /**
   * 移除依赖
   */
  removeDependency(groupId: string, dependsOn: string[]): Promise<void>;

  /**
   * 检查依赖图是否有环
   */
  hasCycles(): Promise<boolean>;

  /**
   * 获取拓扑排序
   */
  getTopologicalOrder(): Promise<string[]>;

  /**
   * 获取可执行的 Groups（所有依赖已完成且状态为 pending）
   */
  getExecutableGroups(): Promise<string[]>;

  // ==========================================================================
  // Worktree 管理
  // ==========================================================================

  /**
   * 创建 Worktree（委托 IWorktreeManager，不可用时返回空 info）
   */
  createWorktree(groupId: string): Promise<WorktreeInfo>;

  /**
   * 删除 Worktree
   */
  deleteWorktree(groupId: string): Promise<void>;

  /**
   * 获取 Worktree 信息
   */
  getWorktreeInfo(groupId: string): Promise<WorktreeInfo>;

  /**
   * 合并 Worktree 回主工作树
   */
  mergeWorktree(
    groupId: string,
    strategy?: 'default' | 'force' | 'abort_on_conflict'
  ): Promise<GroupMergeResult>;

  // ==========================================================================
  // 环境管理（支持继承）
  // ==========================================================================

  /**
   * 设置环境变量
   */
  setEnvironment(
    groupId: string,
    env: Record<string, string>
  ): Promise<void>;

  /**
   * 获取环境变量（包含从父 Group 继承的）
   */
  getEnvironment(groupId: string): Promise<Record<string, string>>;

  // ==========================================================================
  // Fallback 管理
  // ==========================================================================

  /**
   * 设置 Fallback 配置
   */
  setFallback(
    groupId: string,
    fallback: {
      node: string;
      trigger?: 'always' | 'on_error' | 'on_timeout' | 'custom';
      condition?: string;
    }
  ): Promise<void>;

  /**
   * 获取 Fallback 配置
   */
  getFallback(
    groupId: string
  ): Promise<{
    node: string;
    trigger?: 'always' | 'on_error' | 'on_timeout' | 'custom';
    condition?: string;
  } | null>;

  /**
   * 执行 Fallback
   */
  executeFallback(groupId: string): Promise<FallbackResult>;

  // ==========================================================================
  // 并发控制
  // ==========================================================================

  /**
   * 设置最大并发分支数
   */
  setMaxParallel(groupId: string, maxParallel: number): Promise<void>;

  /**
   * 获取最大并发分支数
   */
  getMaxParallel(groupId: string): Promise<number>;

  /**
   * 检查当前并发是否超限
   */
  isConcurrencyExceeded(groupId: string): Promise<boolean>;

  /**
   * 获取当前运行的分支数
   */
  getRunningBranchCount(groupId: string): Promise<number>;

  // ==========================================================================
  // 配置继承
  // ==========================================================================

  /**
   * 获取解析后的配置（沿父链合并 env/fallback/worktree）
   */
  getResolvedConfig(groupId: string): Promise<ResolvedGroupConfig>;

  // ==========================================================================
  // 生命周期
  // ==========================================================================

  /**
   * 清理所有 Groups
   */
  cleanup(): Promise<void>;

  /**
   * 导出所有 Group 配置
   */
  exportConfig(): Promise<GroupConfig[]>;

  /**
   * 导入 Group 配置
   */
  importConfig(configs: GroupConfig[]): Promise<void>;
}
