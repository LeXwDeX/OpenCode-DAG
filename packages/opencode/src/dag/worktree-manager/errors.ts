/**
 * Worktree Manager 错误定义
 */

import type { TerminalWorktreeStatus } from './types';

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeError';
  }
}

export class WorktreeNotFoundError extends WorktreeError {
  constructor(worktreeId: string) {
    super(`Worktree not found: ${worktreeId}`);
    this.name = 'WorktreeNotFoundError';
  }
}

export class WorktreeCreationError extends WorktreeError {
  constructor(worktreeName: string, reason: string) {
    super(`Failed to create worktree '${worktreeName}': ${reason}`);
    this.name = 'WorktreeCreationError';
  }
}

export class WorktreeConflictError extends WorktreeError {
  constructor(conflicts: string[]) {
    super(`Merge conflicts detected: ${conflicts.join(', ')}`);
    this.name = 'WorktreeConflictError';
    this.conflicts = conflicts;
  }

  conflicts: string[];
}

export class WorktreeMergeError extends WorktreeError {
  constructor(worktreeId: string, reason: string) {
    super(`Failed to merge worktree '${worktreeId}': ${reason}`);
    this.name = 'WorktreeMergeError';
  }
}

export class WorktreeCleanupError extends WorktreeError {
  constructor(worktreeId: string, reason: string) {
    super(`Failed to cleanup worktree '${worktreeId}': ${reason}`);
    this.name = 'WorktreeCleanupError';
  }
}

export class WorktreeLockError extends WorktreeError {
  constructor(worktreeId: string, reason: string) {
    super(`Failed to lock worktree '${worktreeId}': ${reason}`);
    this.name = 'WorktreeLockError';
  }
}

/**
 * 状态持久化失败错误
 *
 * 铁律 #18：状态持久化优先 — persist 失败时抛出，阻止内存状态更新。
 */
export class WorktreeStateNotPersistedError extends WorktreeError {
  constructor(worktreeId: string, reason: string) {
    super(`Failed to persist worktree state for ${worktreeId}: ${reason}`);
    this.name = 'WorktreeStateNotPersistedError';
  }
}

/**
 * 终态不可逆错误
 *
 * 铁律 #16：终态不可逆 — 达到 merged / deleted 状态后禁止再次更新。
 */
export class WorktreeTerminalViolationError extends WorktreeError {
  constructor(worktreeId: string, terminalStatus: TerminalWorktreeStatus) {
    super(`Cannot update worktree ${worktreeId} after terminal state ${terminalStatus}`);
    this.name = 'WorktreeTerminalViolationError';
  }
}
