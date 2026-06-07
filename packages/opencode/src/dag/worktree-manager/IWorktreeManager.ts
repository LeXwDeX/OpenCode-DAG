// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

import type {
  WorktreeConfig,
  WorktreeInfo,
  WorktreeMergeResult,
  WorktreeConflict,
} from './types';

/**
 * Worktree Manager 接口
 *
 * 管理 Git Worktree 的创建、使用、合并和清理，提供多 WORKFLOW 并发执行的文件隔离。
 */
export interface IWorktreeManager {
  /**
   * 创建新的 worktree
   *
   * @param name - worktree 名称（用于标识）
   * @param config - worktree 配置
   * @returns 创建的 worktree 信息
   */
  create(name: string, config: WorktreeConfig): Promise<WorktreeInfo>;

  /**
   * 获取指定 worktree 的信息
   *
   * @param worktreeId - worktree ID
   * @returns worktree 信息，如果不存在则返回 undefined
   */
  get(worktreeId: string): Promise<WorktreeInfo | undefined>;

  /**
   * 列出所有 worktrees
   *
   * @returns 所有 worktree 的列表
   */
  list(): Promise<WorktreeInfo[]>;

  /**
   * 获取指定 Group 的所有 worktrees
   *
   * @param groupId - Group ID
   * @returns 该 Group 的 worktree 列表
   */
  listByGroup(groupId: string): Promise<WorktreeInfo[]>;

  /**
   * 更新 worktree 状态
   *
   * @param worktreeId - worktree ID
   * @param status - 新状态
   */
  update(worktreeId: string, status: WorktreeInfo['status']): Promise<void>;

  /**
   * 合并 worktree 到主分支
   *
   * @param worktreeId - worktree ID
   * @param targetBranch - 目标分支名称
   * @param commitMessage - 提交信息
   * @returns 合并结果
   */
  merge(
    worktreeId: string,
    targetBranch: string,
    commitMessage: string
  ): Promise<WorktreeMergeResult>;

  /**
   * 检测合并冲突
   *
   * @param worktreeId - worktree ID
   * @param targetBranch - 目标分支名称
   * @returns 冲突信息列表（空数组表示无冲突）
   */
  detectConflicts(
    worktreeId: string,
    targetBranch: string
  ): Promise<WorktreeConflict[]>;

  /**
   * 清理 worktree（删除 worktree 和分支）
   *
   * @param worktreeId - worktree ID
   */
  cleanup(worktreeId: string): Promise<void>;

  /**
   * 批量清理多个 worktrees
   *
   * @param worktreeIds - worktree ID 列表
   */
  cleanupMany(worktreeIds: string[]): Promise<void>;

  /**
   * 锁定 worktree（防止其他进程修改）
   *
   * @param worktreeId - worktree ID
   */
  lock(worktreeId: string): Promise<void>;

  /**
   * 解锁 worktree
   *
   * @param worktreeId - worktree ID
   */
  unlock(worktreeId: string): Promise<void>;

  /**
   * 获取 worktree 与目标分支的差异
   *
   * @param worktreeId - worktree ID
   * @param targetBranch - 目标分支名称
   * @returns diff 输出（unified diff 格式）
   */
  getDiff(worktreeId: string, targetBranch: string): Promise<string>;

  /**
   * 提交 worktree 中的更改
   *
   * @param worktreeId - worktree ID
   * @param commitMessage - 提交信息
   * @returns commit hash
   */
  commit(worktreeId: string, commitMessage: string): Promise<string>;

  /**
   * 拉取远程分支的最新更改到 worktree
   *
   * @param worktreeId - worktree ID
   * @param remoteBranch - 远程分支名称
   */
  pull(worktreeId: string, remoteBranch: string): Promise<void>;

  /**
   * 设置 worktree 的自动清理标志
   *
   * 启用后，当状态变为 completed / failed 时自动异步触发 cleanup()。
   *
   * @param worktreeId - worktree ID
   * @param enabled - 是否启用自动清理
   */
  setAutoCleanup(worktreeId: string, enabled: boolean): Promise<void>;
}
