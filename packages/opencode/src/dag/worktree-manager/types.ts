// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * Worktree Manager 类型定义
 */

/**
 * Worktree 配置
 */
export interface WorktreeConfig {
  /** 工作区基础目录 */
  basePath: string;
  /** Git 分支名称 */
  branch: string;
  /** Group ID (可选) */
  groupId?: string;
  /** 是否自动清理（默认 true） */
  autoCleanup?: boolean;
  /** 远程仓库 URL（可选） */
  remoteUrl?: string;
  /**
   * 目标目录非 git 仓库 / 无任何 commit 时，是否自动临时 init 本地仓库并创建初始空提交，
   * 使 `git worktree add` 能成功（默认视为 true，开箱可用）。仅当显式为 false 时跳过。
   */
  autoInitGit?: boolean;
}

/**
 * Worktree 信息
 */
export interface WorktreeInfo {
  /** 工作区 ID */
  id: string;
  /** 工作区名称 */
  name: string;
  /** 工作区路径 */
  path: string;
  /** Git 分支名称 */
  branch: string;
  /** 所属 Group ID */
  groupId: string;
  /** 状态 */
  status: WorktreeStatus;
  /** 创建时间 */
  createdAt: number;
  /** 最后使用时间 */
  lastUsedAt: number;
  /** 是否自动清理（当状态变为 completed / failed 时自动触发 cleanup） */
  autoCleanup?: boolean;
}

/**
 * Worktree 状态
 */
export type WorktreeStatus = 'creating' | 'active' | 'merging' | 'cleanup' | 'completed' | 'failed' | 'merged' | 'deleted';

/**
 * Worktree 终态（不可逆状态）
 *
 * 铁律 #16：终态不可逆 — 达到这些状态的 Worktree 禁止再次更新状态。
 */
export const TERMINAL_WORKTREE_STATUSES = ['merged', 'deleted'] as const;
export type TerminalWorktreeStatus = typeof TERMINAL_WORKTREE_STATUSES[number];

/**
 * 触发 autoCleanup 的状态
 *
 * 当 autoCleanup 启用且 Worktree 达到这些状态时，异步触发 cleanup()。
 */
export const AUTO_CLEANUP_STATUSES: ReadonlyArray<WorktreeStatus> = ['completed', 'failed'];

/**
 * Worktree 合并结果
 */
export interface WorktreeMergeResult {
  success: boolean;
  commitHash: string;
  conflicts: string[];        // 冲突文件列表
  mergeCommitMessage: string;
}

/**
 * Worktree 冲突信息
 */
export interface WorktreeConflict {
  filePath: string;
  conflictType: 'edit' | 'delete' | 'both';
  ours: string;              // 当前分支的版本
  theirs: string;            // 被合并分支的版本
}

// ============================================================================
// Worktree 事件类型
// ============================================================================

/** worktree.created 事件 */
export interface WorktreeCreatedEvent {
  type: 'worktree.created';
  worktreeId: string;
  workflowId: string;
  path: string;
  timestamp: number;
}

/** worktree.deleted 事件 */
export interface WorktreeDeletedEvent {
  type: 'worktree.deleted';
  worktreeId: string;
  timestamp: number;
}

/** worktree.status_changed 事件 */
export interface WorktreeStatusChangedEvent {
  type: 'worktree.status_changed';
  worktreeId: string;
  oldStatus: WorktreeStatus;
  newStatus: WorktreeStatus;
  timestamp: number;
}

/** worktree.merged 事件 */
export interface WorktreeMergedEvent {
  type: 'worktree.merged';
  worktreeId: string;
  targetBranch: string;
  commitHash: string;
  timestamp: number;
}

/** worktree.conflict 事件 */
export interface WorktreeConflictEvent {
  type: 'worktree.conflict';
  worktreeId: string;
  conflicts: WorktreeConflict[];
  timestamp: number;
}

/** worktree.locked 事件 */
export interface WorktreeLockedEvent {
  type: 'worktree.locked';
  worktreeId: string;
  timestamp: number;
}

/** Worktree 事件联合类型 */
export type WorktreeEvent =
  | WorktreeCreatedEvent
  | WorktreeDeletedEvent
  | WorktreeStatusChangedEvent
  | WorktreeMergedEvent
  | WorktreeConflictEvent
  | WorktreeLockedEvent;

// ============================================================================
// Worktree 持久化接口
// ============================================================================

/**
 * Worktree 状态持久化接口
 *
 * 当提供时，状态变更前调用 save() 持久化所有 Worktree 状态；
 * 持久化失败时抛出 WorktreeStateNotPersistedError（铁律 #18）。
 */
export interface IWorktreePersister {
  /** 保存所有 Worktree 信息 */
  save(worktrees: WorktreeInfo[]): Promise<void>;
  /** 加载所有 Worktree 信息 */
  load(): Promise<WorktreeInfo[]>;
}
