// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

import type {
  WorktreeConfig,
  WorktreeInfo,
  WorktreeMergeResult,
  WorktreeConflict,
  WorktreeStatus,
  WorktreeEvent,
  IWorktreePersister,
} from './types';
import { TERMINAL_WORKTREE_STATUSES, AUTO_CLEANUP_STATUSES } from './types';
import type { TerminalWorktreeStatus } from './types';
import type { IWorktreeManager } from './IWorktreeManager';
import type { IEventBus } from '../state-machine/IStateMachine';
import type { WorkflowEvent, NodeEvent } from '../state-machine/types';
import {
  WorktreeError,
  WorktreeNotFoundError,
  WorktreeCreationError,
  WorktreeConflictError,
  WorktreeMergeError,
  WorktreeCleanupError,
  WorktreeLockError,
  WorktreeStateNotPersistedError,
  WorktreeTerminalViolationError,
} from './errors';
import { $ } from 'bun';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Worktree Manager 实现
 *
 * 使用 Git Worktree 提供多 WORKFLOW 并发执行的文件隔离。
 *
 * 铁律：
 * - #15: 状态机不可绕过（所有状态变更必须经 update() API）
 * - #16: 终态不可逆（merged / deleted 达成后禁止再次更新）
 * - #17: 事件必须广播（每次状态变更 emit WorktreeEvent）
 * - #18: 状态持久化优先（验证 → 持久化 → 更新内存 → 广播事件）
 */
export class WorktreeManager implements IWorktreeManager {
  private worktrees: Map<string, WorktreeInfo> = new Map();
  private locks: Map<string, boolean> = new Map();
  private baseDir: string;
  private eventBus?: IEventBus;
  private persister?: IWorktreePersister;

  constructor(
    eventBus?: IEventBus,
    persister?: IWorktreePersister,
    baseDir: string = '.worktrees',
  ) {
    this.eventBus = eventBus;
    this.persister = persister;
    this.baseDir = baseDir;
  }

  // ========================================================================
  // 辅助方法
  // ========================================================================

  /**
   * 广播 WorktreeEvent（与 group-manager 一致的 as unknown 桥接模式）
   */
  private emit(event: WorktreeEvent): void {
    this.eventBus?.emit(event as unknown as WorkflowEvent | NodeEvent);
  }

  /**
   * 持久化所有 Worktree 状态
   *
   * 铁律 #18：持久化失败时抛出 WorktreeStateNotPersistedError，阻止内存状态更新。
   */
  private async persist(): Promise<void> {
    if (!this.persister) return;

    try {
      await this.persister.save(Array.from(this.worktrees.values()));
    } catch (error) {
      throw new WorktreeStateNotPersistedError(
        'unknown',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * 内部状态更新（跳过终态检查，用于 merge/cleanup 内部的中间状态转移）
   *
   * 仍然执行持久化和事件广播。
   */
  private async setState(worktreeId: string, newStatus: WorktreeStatus): Promise<void> {
    const worktree = this.worktrees.get(worktreeId);
    if (!worktree) throw new WorktreeNotFoundError(worktreeId);

    const oldStatus = worktree.status;
    worktree.status = newStatus;
    worktree.lastUsedAt = Date.now();

    await this.persist();

    this.emit({
      type: 'worktree.status_changed',
      worktreeId,
      oldStatus,
      newStatus,
      timestamp: Date.now(),
    });
  }

  /**
   * Git 命令执行 seam（透明转发 Bun `$` 标签模板）。
   *
   * 抽出为 protected 是为可测性：Bun 原生 `bun` 模块导出的 `$` 无法被
   * `mock.module` 拦截，单元测试因此通过子类覆写本方法注入假 git 执行，
   * 从而在不触碰真实 git 的前提下验证 ensureGitRepo 的分支行为。
   * 生产路径下与直接调用 `$` 行为完全一致。
   *
   * 返回类型收窄为 `Promise<unknown>`：现有调用方仅 `await` 其副作用
   * （成功/抛错），不消费 `.text()` 等结果，便于测试以普通 Promise 注入。
   */
  protected git(...args: Parameters<typeof $>): Promise<unknown> {
    return $(...args);
  }

  /**
   * 确保 baseDir 所在目录可用于 `git worktree add`（幂等）。
   *
   * - 非 git 工作树 → `git init`
   * - 无 HEAD commit → 创建初始空提交（`-c` 内联注入身份，不依赖全局 git config）
   * - 已是 git 仓库且有 commit → 不执行任何写操作
   */
  private async ensureGitRepo(): Promise<void> {
    // 1) 是否在 git 工作树：失败（抛错）视为非 repo → git init
    let insideWorkTree = true;
    try {
      await this.git`git rev-parse --is-inside-work-tree`;
    } catch {
      insideWorkTree = false;
    }
    if (!insideWorkTree) {
      await this.git`git init`;
    }

    // 2) 是否存在 HEAD commit：失败（无 commit）→ 创建初始空提交
    //    身份用 -c 内联注入，不依赖全局 git config，保证 CI / 全新环境可用
    let hasHeadCommit = true;
    try {
      await this.git`git rev-parse --verify HEAD`;
    } catch {
      hasHeadCommit = false;
    }
    if (!hasHeadCommit) {
      await this.git`git -c user.email=dag@local -c user.name=dag commit --allow-empty -m ${'chore: init independent workspace base'}`;
    }
  }

  // ========================================================================
  // CRUD
  // ========================================================================

  async create(name: string, config: WorktreeConfig): Promise<WorktreeInfo> {
    const worktreePath = path.join(this.baseDir, name);

    try {
      // P0：确保目标目录可用于 git worktree add（非 repo / 无 commit 时自动初始化）。
      // autoInitGit 默认视为 true；仅当显式为 false 时跳过 ensureGitRepo。
      if (config.autoInitGit !== false) {
        await this.ensureGitRepo();
      }

      // 创建 Git Worktree（经 git() seam 转发，便于单元测试注入）
      await this.git`git worktree add ${worktreePath} -b ${config.branch}`;

      const now = Date.now();
      const worktree: WorktreeInfo = {
        id: `worktree-${name}-${now}`,
        name,
        path: worktreePath,
        branch: config.branch,
        groupId: config.groupId || '',
        status: 'active',
        createdAt: now,
        lastUsedAt: now,
        autoCleanup: config.autoCleanup,
      };

      // 铁律 #18：先持久化（临时加入 map 以便 save 包含新条目）
      this.worktrees.set(worktree.id, worktree);
      try {
        await this.persist();
      } catch (e) {
        this.worktrees.delete(worktree.id);
        throw e;
      }

      // 铁律 #17：广播创建事件
      this.emit({
        type: 'worktree.created',
        worktreeId: worktree.id,
        workflowId: config.groupId || '',
        path: worktreePath,
        timestamp: now,
      });

      return worktree;
    } catch (error: any) {
      if (error instanceof WorktreeStateNotPersistedError) throw error;
      throw new WorktreeCreationError(name, error.message);
    }
  }

  async get(worktreeId: string): Promise<WorktreeInfo | undefined> {
    return this.worktrees.get(worktreeId);
  }

  async list(): Promise<WorktreeInfo[]> {
    return Array.from(this.worktrees.values());
  }

  async listByGroup(groupId: string): Promise<WorktreeInfo[]> {
    return Array.from(this.worktrees.values()).filter(
      (w) => w.branch.includes(groupId)
    );
  }

  // ========================================================================
  // 状态管理（铁律 #15 #16 #17 #18）
  // ========================================================================

  async update(worktreeId: string, status: WorktreeStatus): Promise<void> {
    const worktree = this.worktrees.get(worktreeId);
    if (!worktree) {
      throw new WorktreeNotFoundError(worktreeId);
    }

    // 铁律 #16：终态不可逆
    if ((TERMINAL_WORKTREE_STATUSES as ReadonlyArray<WorktreeStatus>).includes(worktree.status)) {
      throw new WorktreeTerminalViolationError(
        worktreeId,
        worktree.status as TerminalWorktreeStatus,
      );
    }

    const oldStatus = worktree.status;

    // 铁律 #18：先持久化（内存已更新但可回滚）
    worktree.status = status;
    worktree.lastUsedAt = Date.now();
    try {
      await this.persist();
    } catch (e) {
      worktree.status = oldStatus;
      worktree.lastUsedAt = Date.now();
      throw e;
    }

    // 铁律 #17：广播状态变更事件
    this.emit({
      type: 'worktree.status_changed',
      worktreeId,
      oldStatus,
      newStatus: status,
      timestamp: Date.now(),
    });

    // autoCleanup：状态达到 completed / failed 时异步触发 cleanup（不阻塞当前 update）
    if (worktree.autoCleanup && AUTO_CLEANUP_STATUSES.includes(status)) {
      setTimeout(() => {
        this.cleanup(worktreeId).catch((err) =>
          console.error(`Auto-cleanup failed for ${worktreeId}:`, err),
        );
      }, 0);
    }
  }

  // ========================================================================
  // 合并
  // ========================================================================

  async merge(
    worktreeId: string,
    targetBranch: string,
    commitMessage: string
  ): Promise<WorktreeMergeResult> {
    const worktree = this.worktrees.get(worktreeId);
    if (!worktree) {
      throw new WorktreeNotFoundError(worktreeId);
    }

    // 铁律 #16：merge 前也做终态检查（避免在已 merged 的 worktree 上重复合并）
    if ((TERMINAL_WORKTREE_STATUSES as ReadonlyArray<WorktreeStatus>).includes(worktree.status)) {
      throw new WorktreeTerminalViolationError(
        worktreeId,
        worktree.status as TerminalWorktreeStatus,
      );
    }

    try {
      // 通过 update() 设置 'merging'（含终态检查、持久化、事件广播）
      await this.update(worktreeId, 'merging');

      // 检测冲突
      const conflicts = await this.detectConflicts(worktreeId, targetBranch);
      if (conflicts.length > 0) {
        // 铁律 #17：广播冲突事件
        this.emit({
          type: 'worktree.conflict',
          worktreeId,
          conflicts,
          timestamp: Date.now(),
        });

        // 状态转为 failed（使用 setState 避免再次终态检查）
        await this.setState(worktreeId, 'failed');

        return {
          success: false,
          commitHash: '',
          conflicts: conflicts.map((c) => c.filePath),
          mergeCommitMessage: '',
        };
      }

      // 切换到目标分支并合并
      await $`git checkout ${targetBranch}`;
      await $`git merge --no-ff -m "${commitMessage}" ${worktree.branch}`;
      const commitHash = (await $`git rev-parse HEAD`).text().trim();

      // 状态转为 merged（终态）
      await this.setState(worktreeId, 'merged');

      // 铁律 #17：广播合并成功事件
      this.emit({
        type: 'worktree.merged',
        worktreeId,
        targetBranch,
        commitHash,
        timestamp: Date.now(),
      });

      return {
        success: true,
        commitHash,
        conflicts: [],
        mergeCommitMessage: commitMessage,
      };
    } catch (error: any) {
      if (error instanceof WorktreeTerminalViolationError) {
        throw new WorktreeMergeError(worktreeId, error.message);
      }

      // 非冲突/非终态错误：设置 failed 并重新抛出为 WorktreeMergeError
      try {
        await this.setState(worktreeId, 'failed');
      } catch {
        // 如果 setState 也失败，继续抛出原始错误
      }
      throw new WorktreeMergeError(worktreeId, error.message);
    }
  }

  async detectConflicts(
    worktreeId: string,
    targetBranch: string
  ): Promise<WorktreeConflict[]> {
    const worktree = this.worktrees.get(worktreeId);
    if (!worktree) {
      throw new WorktreeNotFoundError(worktreeId);
    }

    try {
      // 使用 git merge-tree 检测冲突
      const result = await $`git merge-tree ${worktree.branch} ${targetBranch}`;
      const output = result.text();

      const conflicts: WorktreeConflict[] = [];
      const lines = output.split('\n');

      for (const line of lines) {
        if (line.includes('CONFLICT')) {
          const filePath = line.split(' ').pop() || '';
          conflicts.push({
            filePath,
            conflictType: 'edit',
            ours: '',
            theirs: '',
          });
        }
      }

      return conflicts;
    } catch (error: any) {
      return [];
    }
  }

  // ========================================================================
  // 清理
  // ========================================================================

  async cleanup(worktreeId: string): Promise<void> {
    const worktree = this.worktrees.get(worktreeId);
    if (!worktree) {
      throw new WorktreeNotFoundError(worktreeId);
    }

    try {
      // 状态转为 'cleanup'（使用 update 获得终态检查 + 持久化 + 事件广播）
      await this.update(worktreeId, 'cleanup');

      // 删除 worktree
      try {
        await $`git worktree remove ${worktree.path}`;
      } catch (e) {
        // 尝试强制删除
        try {
          await $`git worktree remove --force ${worktree.path}`;
        } catch (forceError) {
          // 如果仍然失败，继续执行
        }
      }

      // 删除分支 (如果分支不存在)
      try {
        await $`git rev-parse --verify ${worktree.branch}`;
        // 分支存在，删除它
        await $`git branch -D ${worktree.branch}`;
      } catch (e) {
        // 分支不存在，跳过
      }

      // 铁律 #17：广播删除事件（在移除 map 之前，以便事件携带完整信息）
      this.emit({
        type: 'worktree.deleted',
        worktreeId,
        timestamp: Date.now(),
      });

      this.worktrees.delete(worktreeId);
      this.locks.delete(worktreeId);
    } catch (error: any) {
      // 已经删除了 worktee，所以忽略清理错误
      this.emit({
        type: 'worktree.deleted',
        worktreeId,
        timestamp: Date.now(),
      });
      this.worktrees.delete(worktreeId);
      this.locks.delete(worktreeId);
    }
  }

  async cleanupMany(worktreeIds: string[]): Promise<void> {
    await Promise.all(worktreeIds.map((id) => this.cleanup(id)));
  }

  // ========================================================================
  // 锁定
  // ========================================================================

  async lock(worktreeId: string): Promise<void> {
    const worktree = this.worktrees.get(worktreeId);
    if (!worktree) {
      throw new WorktreeNotFoundError(worktreeId);
    }

    if (this.locks.has(worktreeId)) {
      throw new WorktreeLockError(worktreeId, 'Worktree is already locked');
    }

    this.locks.set(worktreeId, true);

    // 铁律 #17：广播锁定事件
    this.emit({
      type: 'worktree.locked',
      worktreeId,
      timestamp: Date.now(),
    });
  }

  async unlock(worktreeId: string): Promise<void> {
    if (!this.locks.has(worktreeId)) {
      throw new WorktreeNotFoundError(worktreeId);
    }

    this.locks.delete(worktreeId);
  }

  // ========================================================================
  // autoCleanup
  // ========================================================================

  async setAutoCleanup(worktreeId: string, enabled: boolean): Promise<void> {
    const worktree = this.worktrees.get(worktreeId);
    if (!worktree) throw new WorktreeNotFoundError(worktreeId);
    worktree.autoCleanup = enabled;
  }

  // ========================================================================
  // Git 操作
  // ========================================================================

  async getDiff(worktreeId: string, targetBranch: string): Promise<string> {
    const worktree = this.worktrees.get(worktreeId);
    if (!worktree) {
      throw new WorktreeNotFoundError(worktreeId);
    }

    const result = await $`git diff ${targetBranch}...${worktree.branch}`;
    return result.text();
  }

  async commit(worktreeId: string, commitMessage: string): Promise<string> {
    const worktree = this.worktrees.get(worktreeId);
    if (!worktree) {
      throw new WorktreeNotFoundError(worktreeId);
    }

    // 进入 worktree 目录
    const originalDir = process.cwd();
    process.chdir(worktree.path);

    try {
      // 添加所有更改
      await $`git add .`;

      // 检查是否有更改
      const status = await $`git status --porcelain`;
      if (status.text().trim() === '') {
        return '';
      }

      // 提交
      await $`git commit -m "${commitMessage}"`;
      const commitHash = (await $`git rev-parse HEAD`).text().trim();

      return commitHash;
    } finally {
      // 恢复到原始目录
      process.chdir(originalDir);
    }
  }

  async pull(worktreeId: string, remoteBranch: string): Promise<void> {
    const worktree = this.worktrees.get(worktreeId);
    if (!worktree) {
      throw new WorktreeNotFoundError(worktreeId);
    }

    const originalDir = process.cwd();
    process.chdir(worktree.path);

    try {
      await $`git pull origin ${remoteBranch}`;
    } finally {
      process.chdir(originalDir);
    }
  }
}
