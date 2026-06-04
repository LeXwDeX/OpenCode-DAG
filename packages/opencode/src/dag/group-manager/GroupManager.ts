/**
 * Group Manager 实现
 *
 * @module dag/group-manager/GroupManager
 *
 * 铁律：
 * - #15: 状态机不可绕过（所有状态变更必须经 updateGroupStatus / updateBranchStatus）
 * - #16: 终态不可逆（completed / failed / cancelled 不可回退）
 * - #17: 事件必须广播（每次状态变更 emit GroupEvent）
 *
 * 设计：
 * - 依赖 DependencyGraph 管理 Group 间 has-a 依赖
 * - 依赖 IEventBus 广播事件
 * - 可选 IWorktreeManager 提供 Git Worktree 隔离
 * - 可选 IGroupStatePersister 提供状态持久化
 */

import type {
  IGroupManager,
} from './IGroupManager';
import type {
  IEventBus,
} from '../state-machine/IStateMachine';
import type { IWorktreeManager } from '../worktree-manager/IWorktreeManager';
import type {
  GroupConfig,
  Group,
  GroupStatus,
  BranchConfig,
  Branch,
  BranchStatus,
  GroupQueryResult,
  GroupMergeResult,
  WorktreeInfo,
  FallbackResult,
  ResolvedGroupConfig,
  GroupEvent,
  GroupID,
} from './types';
import {
  MAX_NESTING_DEPTH,
  DEFAULT_MAX_PARALLEL,
} from './types';
import {
  GroupNotFoundError,
  BranchNotFoundError,
  GroupConfigError,
  GroupNestingDepthError,
  GroupConflictError,
  BranchConflictError,
  GroupDependencyCycleError,
  GroupDependedOnError,
  InvalidGroupTransitionError,
  GroupTerminalViolationError,
  GroupMergeError,
  WorktreeCreationError,
  FallbackExecutionError,
} from './errors';
import { DependencyGraph } from './DependencyGraph';
import type { NodeStatus, WorkflowEvent, NodeEvent } from '../state-machine/types';

// ============================================================================
// 持久化接口
// ============================================================================

/**
 * Group 状态持久化接口
 *
 * 当提供时，updateGroupStatus 在 emit 事件之前调用 saveGroupState，
 * 确保持久化优先于事件广播（铁律 #17 扩展）。
 */
export interface IGroupStatePersister {
  saveGroupState(groupId: string, state: any): Promise<void>;
}

// ============================================================================
// 状态转移规则
// ============================================================================

const VALID_TRANSITIONS: Record<GroupStatus, GroupStatus[]> = {
  pending: ['running', 'cancelled'],
  running: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

const TERMINAL_STATUSES: ReadonlySet<GroupStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

function isValidTransition(from: GroupStatus, to: GroupStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

function isTerminalStatus(status: GroupStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

// ============================================================================
// GroupManager
// ============================================================================

export class GroupManager implements IGroupManager {
  private groups: Map<GroupID, Group> = new Map();
  private depGraph = new DependencyGraph();
  /** parentId → Set<childId> */
  private children: Map<GroupID, Set<GroupID>> = new Map();
  private eventBus: IEventBus;
  private worktreeManager?: IWorktreeManager;
  private statePersister?: IGroupStatePersister;

  constructor(
    eventBus: IEventBus,
    worktreeManager?: IWorktreeManager,
    statePersister?: IGroupStatePersister,
  ) {
    this.eventBus = eventBus;
    this.worktreeManager = worktreeManager;
    this.statePersister = statePersister;
  }

  // ==========================================================================
  // Group CRUD
  // ==========================================================================

  async createGroup(config: GroupConfig): Promise<Group> {
    // 校验 ID 唯一性
    if (this.groups.has(config.id)) {
      throw new GroupConflictError(config.id);
    }

    // 校验嵌套深度
    const depth = this.computeDepth(config);
    if (depth > MAX_NESTING_DEPTH) {
      throw new GroupNestingDepthError(depth, MAX_NESTING_DEPTH);
    }

    // 校验依赖存在性
    if (config.depends_on) {
      for (const dep of config.depends_on) {
        if (!this.groups.has(dep)) {
          throw new GroupConfigError(
            `Dependency group not found: ${dep}`,
            { groupId: config.id, missingDep: dep }
          );
        }
      }
    }

    // 创建 Group 实例
    const group: Group = {
      id: config.id,
      name: config.name,
      description: config.description,
      config: { ...config },
      status: 'pending',
      branches: new Map(),
      parent_id: config.parent_id,
    };

    // 注册到依赖图
    this.depGraph.addNode(config.id);
    if (config.depends_on) {
      for (const dep of config.depends_on) {
        this.depGraph.addEdge(config.id, dep);
      }
    }

    // 注册父子关系
    if (config.parent_id) {
      if (!this.children.has(config.parent_id)) {
        this.children.set(config.parent_id, new Set());
      }
      this.children.get(config.parent_id)!.add(config.id);
    }

    // 注册子 Group（递归）
    if (config.sub_groups) {
      for (const subConfig of config.sub_groups) {
        const childConfig = { ...subConfig, parent_id: config.id };
        await this.createGroup(childConfig);
      }
    }

    // 注册初始分支
    if (config.branches) {
      for (const branchConfig of config.branches) {
        group.branches.set(branchConfig.id, this.createBranchInstance(branchConfig));
      }
    }

    this.groups.set(config.id, group);

    // 铁律 #17：广播创建事件
    this.emit({
      type: 'group.created',
      groupId: config.id,
      config: group.config,
      timestamp: Date.now(),
    });

    return group;
  }

  async deleteGroup(groupId: string): Promise<void> {
    if (!this.groups.has(groupId)) {
      throw new GroupNotFoundError(groupId);
    }

    // 阶段 1: 全量校验整个子树是否可删（保证原子性）
    this.validateSubtreeDeletability(groupId);

    // 阶段 2: 执行删除（此时保证不会抛出依赖错误）
    this.executeSubtreeDeletion(groupId);
  }

  private validateSubtreeDeletability(groupId: string): void {
    const dependents = this.depGraph.getDependents(groupId);
    if (dependents.length > 0) {
      throw new GroupDependedOnError(groupId, dependents);
    }

    const childIds = this.children.get(groupId);
    if (childIds) {
      for (const childId of childIds) {
        this.validateSubtreeDeletability(childId);
      }
    }
  }

  private executeSubtreeDeletion(groupId: string): void {
    // 在删除前读取 parent_id（否则 groups.get 将返回 undefined）
    const group = this.groups.get(groupId);
    const parentId = group?.parent_id;

    const childIds = this.children.get(groupId);
    if (childIds) {
      for (const childId of [...childIds]) {
        this.executeSubtreeDeletion(childId);
      }
    }

    this.groups.delete(groupId);
    this.depGraph.removeNode(groupId);
    this.children.delete(groupId);

    if (parentId) {
      this.children.get(parentId)?.delete(groupId);
    }

    // 铁律 #17：广播移除事件
    this.emit({
      type: 'group.removed',
      groupId,
      timestamp: Date.now(),
    });
  }

  async getGroup(groupId: string): Promise<GroupQueryResult> {
    const group = this.requireGroup(groupId);
    return {
      group,
      parent_path: this.getParentPath(groupId),
    };
  }

  async getAllGroups(): Promise<GroupQueryResult[]> {
    const results: GroupQueryResult[] = [];
    for (const groupId of this.groups.keys()) {
      results.push({
        group: this.groups.get(groupId)!,
        parent_path: this.getParentPath(groupId),
      });
    }
    return results;
  }

  // ==========================================================================
  // Branch CRUD
  // ==========================================================================

  async addBranch(groupId: string, branchConfig: BranchConfig): Promise<Branch> {
    const group = this.requireGroup(groupId);

    if (group.branches.has(branchConfig.id)) {
      throw new BranchConflictError(branchConfig.id);
    }

    const branch = this.createBranchInstance(branchConfig);
    group.branches.set(branchConfig.id, branch);
    return branch;
  }

  async deleteBranch(groupId: string, branchId: string): Promise<void> {
    const group = this.requireGroup(groupId);
    if (!group.branches.has(branchId)) {
      throw new BranchNotFoundError(branchId);
    }
    group.branches.delete(branchId);
  }

  async getBranch(groupId: string, branchId: string): Promise<Branch> {
    const group = this.requireGroup(groupId);
    const branch = group.branches.get(branchId);
    if (!branch) throw new BranchNotFoundError(branchId);
    return branch;
  }

  async getBranches(groupId: string): Promise<Branch[]> {
    const group = this.requireGroup(groupId);
    return Array.from(group.branches.values());
  }

  // ==========================================================================
  // 状态管理（铁律 #15 #16 #17）
  // ==========================================================================

  async updateGroupStatus(groupId: string, status: GroupStatus): Promise<void> {
    const group = this.requireGroup(groupId);
    const oldStatus = group.status;

    // 铁律 #16：终态不可逆
    if (isTerminalStatus(oldStatus)) {
      throw new GroupTerminalViolationError(groupId, oldStatus, status);
    }

    // 铁律 #15：验证转移合法性
    if (!isValidTransition(oldStatus, status)) {
      throw new InvalidGroupTransitionError(groupId, oldStatus, status);
    }

    // 持久化优先（在 emit 之前，保证持久化优先于事件广播）
    if (this.statePersister) {
      await this.statePersister.saveGroupState(groupId, {
        ...group,
        status,
      });
    }

    // 更新状态
    group.status = status;
    if (status === 'running' && !group.started_at) {
      group.started_at = Date.now();
    }
    if (isTerminalStatus(status)) {
      group.completed_at = Date.now();
    }

    // 铁律 #17：广播事件
    this.emit({
      type: 'group.state_changed',
      groupId,
      oldStatus,
      newStatus: status,
      timestamp: Date.now(),
    });
  }

  async updateBranchStatus(
    groupId: string,
    branchId: string,
    status: BranchStatus
  ): Promise<void> {
    const branch = await this.getBranch(groupId, branchId);
    const oldStatus = branch.status;

    if (isTerminalStatus(oldStatus)) {
      throw new GroupTerminalViolationError(
        `${groupId}/${branchId}`,
        oldStatus,
        status
      );
    }

    if (!isValidTransition(oldStatus, status)) {
      throw new InvalidGroupTransitionError(
        `${groupId}/${branchId}`,
        oldStatus,
        status
      );
    }

    branch.status = status;
    if (status === 'running' && !branch.started_at) {
      branch.started_at = Date.now();
    }
    if (isTerminalStatus(status)) {
      branch.completed_at = Date.now();
    }

    this.emit({
      type: 'branch.state_changed',
      groupId,
      branchId,
      oldStatus,
      newStatus: status,
      timestamp: Date.now(),
    });
  }

  // ==========================================================================
  // 依赖管理
  // ==========================================================================

  async getDependencies(groupId: string): Promise<string[]> {
    this.requireGroup(groupId);
    return this.depGraph.getDependencies(groupId);
  }

  async addDependency(groupId: string, dependsOn: string[]): Promise<void> {
    this.requireGroup(groupId);
    for (const dep of dependsOn) {
      this.requireGroup(dep);
      if (!this.depGraph.hasEdge(groupId, dep)) {
        this.depGraph.addEdge(groupId, dep);
      }
    }
    // 更新 config 的 depends_on
    const group = this.groups.get(groupId)!;
    const currentDeps = group.config.depends_on ?? [];
    group.config.depends_on = [...new Set([...currentDeps, ...dependsOn])];
  }

  async removeDependency(groupId: string, dependsOn: string[]): Promise<void> {
    this.requireGroup(groupId);
    for (const dep of dependsOn) {
      if (this.depGraph.hasEdge(groupId, dep)) {
        this.depGraph.removeEdge(groupId, dep);
      }
    }
    const group = this.groups.get(groupId)!;
    group.config.depends_on = (group.config.depends_on ?? []).filter(
      (d) => !dependsOn.includes(d)
    );
  }

  async hasCycles(): Promise<boolean> {
    return this.depGraph.hasCycle();
  }

  async getTopologicalOrder(): Promise<string[]> {
    return this.depGraph.topologicalSort();
  }

  async getExecutableGroups(): Promise<string[]> {
    const completedSet = new Set<string>();
    for (const [id, group] of this.groups.entries()) {
      if (group.status === 'completed') {
        completedSet.add(id);
      }
    }

    const executable = this.depGraph.getExecutableNodes(completedSet);

    // 过滤：只返回 pending 状态的 Group（排除 running/failed/cancelled）
    return executable.filter(id => {
      const group = this.groups.get(id);
      return group && group.status === 'pending';
    });
  }

  // ==========================================================================
  // Worktree 管理
  // ==========================================================================

  async createWorktree(groupId: string): Promise<WorktreeInfo> {
    const group = this.requireGroup(groupId);

    if (!this.worktreeManager) {
      // Worktree 服务不可用时返回空信息
      const info: WorktreeInfo = {
        groupId,
        path: '',
        branch: '',
        created_at: Date.now(),
      };
      return info;
    }

    const wtConfig = group.config.worktree;
    if (!wtConfig) {
      throw new WorktreeCreationError(groupId, 'No worktree config defined');
    }

    const wtInfo = await this.worktreeManager.create(groupId, {
      basePath: wtConfig.base_path,
      branch: `${wtConfig.branch_prefix}${groupId}`,
      groupId,
    });

    group.worktree_path = wtInfo.path;

    return {
      groupId,
      path: wtInfo.path,
      branch: wtInfo.branch,
      created_at: wtInfo.createdAt,
    };
  }

  async deleteWorktree(groupId: string): Promise<void> {
    const group = this.requireGroup(groupId);
    group.worktree_path = undefined;
  }

  async getWorktreeInfo(groupId: string): Promise<WorktreeInfo> {
    const group = this.requireGroup(groupId);
    return {
      groupId,
      path: group.worktree_path ?? '',
      branch: group.config.worktree
        ? `${group.config.worktree.branch_prefix}${groupId}`
        : '',
      created_at: group.started_at ?? 0,
    };
  }

  async mergeWorktree(
    groupId: string,
    strategy: 'default' | 'force' | 'abort_on_conflict' = 'default'
  ): Promise<GroupMergeResult> {
    const group = this.requireGroup(groupId);

    if (!this.worktreeManager || !group.worktree_path) {
      return {
        groupId,
        success: false,
        merged_files: [],
        message: 'No worktree to merge',
      };
    }

    const wtInfos = await this.worktreeManager.listByGroup(groupId);
    if (wtInfos.length === 0) {
      return {
        groupId,
        success: false,
        merged_files: [],
        message: 'No worktree found for group',
      };
    }

    const wtInfo = wtInfos[0]!;
    const result = await this.worktreeManager.merge(
      wtInfo.id,
      'main',
      `merge group ${groupId}`
    );

    const conflicts = result.conflicts.map((f) => ({
      file: f,
      reason: 'merge conflict',
    }));

    if (!result.success && strategy === 'abort_on_conflict') {
      throw new GroupMergeError(groupId, `Merge conflicts: ${result.conflicts.join(', ')}`);
    }

    return {
      groupId,
      success: result.success || strategy === 'force',
      merged_files: result.success ? [result.commitHash] : [],
      conflicts: conflicts.length > 0 ? conflicts : undefined,
      message: result.success ? 'Merged successfully' : 'Merge had conflicts',
    };
  }

  // ==========================================================================
  // 环境管理（支持继承）
  // ==========================================================================

  async setEnvironment(
    groupId: string,
    env: Record<string, string>
  ): Promise<void> {
    const group = this.requireGroup(groupId);
    group.config.env = env;
  }

  async getEnvironment(groupId: string): Promise<Record<string, string>> {
    this.requireGroup(groupId);
    return this.resolveEnv(groupId);
  }

  // ==========================================================================
  // Fallback 管理
  // ==========================================================================

  async setFallback(
    groupId: string,
    fallback: {
      node: string;
      trigger?: 'always' | 'on_error' | 'on_timeout' | 'custom';
      condition?: string;
    }
  ): Promise<void> {
    const group = this.requireGroup(groupId);
    group.config.fallback = fallback;
  }

  async getFallback(
    groupId: string
  ): Promise<{
    node: string;
    trigger?: 'always' | 'on_error' | 'on_timeout' | 'custom';
    condition?: string;
  } | null> {
    const group = this.requireGroup(groupId);
    return group.config.fallback ?? null;
  }

  async executeFallback(groupId: string): Promise<FallbackResult> {
    const group = this.requireGroup(groupId);

    if (!group.config.fallback) {
      throw new FallbackExecutionError(groupId, 'No fallback config defined');
    }

    const fallback = group.config.fallback;
    return {
      groupId,
      fallback_node: fallback.node,
      decision: 'rerun',
      message: `Fallback triggered for node: ${fallback.node}`,
      should_continue: true,
    };
  }

  // ==========================================================================
  // 并发控制
  // ==========================================================================

  async setMaxParallel(groupId: string, maxParallel: number): Promise<void> {
    const group = this.requireGroup(groupId);
    group.config.max_parallel = maxParallel;
  }

  async getMaxParallel(groupId: string): Promise<number> {
    const group = this.requireGroup(groupId);
    return group.config.max_parallel ?? DEFAULT_MAX_PARALLEL;
  }

  async isConcurrencyExceeded(groupId: string): Promise<boolean> {
    const group = this.requireGroup(groupId);
    const maxParallel = group.config.max_parallel ?? DEFAULT_MAX_PARALLEL;
    const runningCount = this.countRunningBranches(groupId);
    return runningCount >= maxParallel;
  }

  async getRunningBranchCount(groupId: string): Promise<number> {
    this.requireGroup(groupId);
    return this.countRunningBranches(groupId);
  }

  // ==========================================================================
  // 配置继承
  // ==========================================================================

  async getResolvedConfig(groupId: string): Promise<ResolvedGroupConfig> {
    const group = this.requireGroup(groupId);
    const env = this.resolveEnv(groupId);

    return {
      id: group.id,
      name: group.name,
      env,
      fallback: group.config.fallback,
      worktree: group.config.worktree,
      max_parallel: group.config.max_parallel,
    };
  }

  // ==========================================================================
  // 生命周期
  // ==========================================================================

  async cleanup(): Promise<void> {
    const groupIds = [...this.groups.keys()];
    for (const id of groupIds) {
      const group = this.groups.get(id)!;
      group.worktree_path = undefined;
    }
    this.groups.clear();
    this.depGraph.clear();
    this.children.clear();
  }

  async exportConfig(): Promise<GroupConfig[]> {
    return Array.from(this.groups.values()).map((g) => g.config);
  }

  async importConfig(configs: GroupConfig[]): Promise<void> {
    for (const config of configs) {
      if (!this.groups.has(config.id)) {
        await this.createGroup(config);
      }
    }
  }

  // ==========================================================================
  // Internal helpers
  // ==========================================================================

  private requireGroup(groupId: string): Group {
    const group = this.groups.get(groupId);
    if (!group) throw new GroupNotFoundError(groupId);
    return group;
  }

  private emit(event: GroupEvent): void {
    this.eventBus.emit(event as unknown as WorkflowEvent | NodeEvent);
  }

  private getParentPath(groupId: string): GroupID[] {
    const path: GroupID[] = [];
    let current = this.groups.get(groupId);
    while (current?.parent_id) {
      path.unshift(current.parent_id);
      current = this.groups.get(current.parent_id);
    }
    return path;
  }

  private computeDepth(config: GroupConfig, depth = 1): number {
    let maxDepth = depth;
    if (config.sub_groups) {
      for (const sub of config.sub_groups) {
        maxDepth = Math.max(maxDepth, this.computeDepth(sub, depth + 1));
      }
    }
    return maxDepth;
  }

  private resolveEnv(groupId: string): Record<string, string> {
    const path = this.getParentPath(groupId);
    const group = this.groups.get(groupId)!;
    const merged: Record<string, string> = {};

    // 从根到当前，逐步覆盖
    for (const ancestorId of path) {
      const ancestor = this.groups.get(ancestorId);
      if (ancestor?.config.env) {
        Object.assign(merged, ancestor.config.env);
      }
    }
    if (group.config.env) {
      Object.assign(merged, group.config.env);
    }

    return merged;
  }

  private countRunningBranches(groupId: string): number {
    const group = this.groups.get(groupId);
    if (!group) return 0;
    let count = 0;
    for (const branch of group.branches.values()) {
      if (branch.status === 'running') count++;
    }
    return count;
  }

  private createBranchInstance(config: BranchConfig): Branch {
    return {
      id: config.id,
      name: config.name,
      config,
      status: 'pending',
      nodes: new Map(),
    };
  }
}
