/**
 * Group Manager 错误类型定义
 * 
 * @module dag/group-manager/errors
 */

// ============================================================================
// 基础错误类
// ============================================================================

/**
 * Group Manager 基础错误类
 *
 * 所有 Group Manager 错误均继承自此类。
 */
export class GroupManagerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'GroupManagerError';
  }
}

// ============================================================================
// 实体不存在错误
// ============================================================================

/**
 * Group 不存在
 */
export class GroupNotFoundError extends GroupManagerError {
  constructor(groupId: string) {
    super(`Group not found: ${groupId}`, 'GROUP_NOT_FOUND', { groupId });
    this.name = 'GroupNotFoundError';
  }
}

/**
 * Branch 不存在
 */
export class BranchNotFoundError extends GroupManagerError {
  constructor(branchId: string) {
    super(`Branch not found: ${branchId}`, 'BRANCH_NOT_FOUND', { branchId });
    this.name = 'BranchNotFoundError';
  }
}

// ============================================================================
// 配置与结构错误
// ============================================================================

/**
 * Group 配置错误
 */
export class GroupConfigError extends GroupManagerError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'GROUP_CONFIG_ERROR', details);
    this.name = 'GroupConfigError';
  }
}

/**
 * 嵌套深度超限
 *
 * Group 层级树深度超过 MAX_NESTING_DEPTH（5）。
 */
export class GroupNestingDepthError extends GroupManagerError {
  constructor(depth: number, maxDepth: number) {
    super(
      `Maximum nesting depth (${maxDepth}) exceeded: current depth is ${depth}`,
      'GROUP_NESTING_DEPTH_EXCEEDED',
      { depth, maxDepth }
    );
    this.name = 'GroupNestingDepthError';
  }
}

/**
 * Group ID 冲突
 *
 * 在同一层级内存在重复的 Group ID。
 */
export class GroupConflictError extends GroupManagerError {
  constructor(groupId: string) {
    super(`Group ID already exists: ${groupId}`, 'GROUP_CONFLICT', { groupId });
    this.name = 'GroupConflictError';
  }
}

/**
 * Branch ID 冲突
 */
export class BranchConflictError extends GroupManagerError {
  constructor(branchId: string) {
    super(`Branch ID already exists: ${branchId}`, 'BRANCH_CONFLICT', { branchId });
    this.name = 'BranchConflictError';
  }
}

// ============================================================================
// 依赖图错误
// ============================================================================

/**
 * Group 依赖循环
 */
export class GroupDependencyCycleError extends GroupManagerError {
  constructor(groupId: string, cycle: string[]) {
    super(
      `Group dependency cycle detected involving: ${groupId}`,
      'GROUP_DEPENDENCY_CYCLE',
      { groupId, cycle }
    );
    this.name = 'GroupDependencyCycleError';
  }
}

/**
 * 依赖图循环（底层 DAG 级别）
 */
export class CycleError extends GroupManagerError {
  constructor(cycle: string[]) {
    super(
      `Dependency cycle detected: ${cycle.join(' -> ')}`,
      'CYCLE_DETECTED',
      { cycle }
    );
    this.name = 'CycleError';
  }
}

/**
 * 被依赖的 Group 不可删除
 */
export class GroupDependedOnError extends GroupManagerError {
  constructor(groupId: string, dependents: string[]) {
    super(
      `Cannot remove group ${groupId}: depended on by ${dependents.join(', ')}`,
      'GROUP_DEPENDED_ON',
      { groupId, dependents }
    );
    this.name = 'GroupDependedOnError';
  }
}

// ============================================================================
// 状态机错误（铁律 #15, #16）
// ============================================================================

/**
 * 非法 Group 状态转移
 *
 * 铁律 #15：所有状态变更必须经合法转移路径。
 */
export class InvalidGroupTransitionError extends GroupManagerError {
  constructor(groupId: string, fromStatus: string, toStatus: string) {
    super(
      `Invalid group transition: ${groupId} (${fromStatus} -> ${toStatus})`,
      'INVALID_GROUP_TRANSITION',
      { groupId, fromStatus, toStatus }
    );
    this.name = 'InvalidGroupTransitionError';
  }
}

/**
 * Group 终态违规
 *
 * 铁律 #16：终态不可逆。
 */
export class GroupTerminalViolationError extends GroupManagerError {
  constructor(groupId: string, terminalStatus: string, attemptedStatus: string) {
    super(
      `Cannot transition from terminal state: ${groupId} (${terminalStatus} -> ${attemptedStatus})`,
      'GROUP_TERMINAL_VIOLATION',
      { groupId, terminalStatus, attemptedStatus }
    );
    this.name = 'GroupTerminalViolationError';
  }
}

// ============================================================================
// Worktree & Fallback 错误
// ============================================================================

/**
 * Group 合并错误
 */
export class GroupMergeError extends GroupManagerError {
  constructor(groupId: string, message: string) {
    super(message, 'GROUP_MERGE_ERROR', { groupId });
    this.name = 'GroupMergeError';
  }
}

/**
 * Worktree 创建错误
 */
export class WorktreeCreationError extends GroupManagerError {
  constructor(groupId: string, message: string) {
    super(message, 'WORKTREE_CREATION_ERROR', { groupId });
    this.name = 'WorktreeCreationError';
  }
}

/**
 * Fallback 执行错误
 */
export class FallbackExecutionError extends GroupManagerError {
  constructor(groupId: string, message: string) {
    super(message, 'FALLBACK_EXECUTION_ERROR', { groupId });
    this.name = 'FallbackExecutionError';
  }
}
