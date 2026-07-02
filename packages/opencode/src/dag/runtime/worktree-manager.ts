/**
 * DAG WorktreeManager — minimal port from dag-iron-laws, chdir-race fixed.
 *
 * Only the operations the DAG runtime needs: create, get, cleanup. The old 563-line
 * module carried merge/conflict/commit/pull/lock — all unused by the DAG runtime,
 * and the commit/pull methods had a process.chdir race condition. Those methods
 * are NOT ported; if needed later, they must use Bun's `$.cwd(...)` or `cwd:` option.
 *
 * create() uses `git worktree add` via Bun's `$` shell. cleanup() uses
 * `git worktree remove` + `git branch -D`.
 */

import { $ } from "bun"
import * as path from "path"
import { randomUUID } from "crypto"

export interface WorktreeConfig {
  basePath: string
  branch: string
  autoCleanup?: boolean
  autoInitGit?: boolean
}

export interface WorktreeInfo {
  id: string
  name: string
  path: string
  branch: string
  status: WorktreeStatus
  createdAt: number
  lastUsedAt: number
  autoCleanup?: boolean
}

export type WorktreeStatus = "active" | "completed" | "failed" | "deleted"

export class WorktreeManager {
  private worktrees: Map<string, WorktreeInfo> = new Map()

  async create(name: string, config: WorktreeConfig): Promise<WorktreeInfo> {
    const id = randomUUID()
    const branch = config.branch || `dag-${id.slice(0, 8)}`
    const wtPath = path.join(config.basePath, `.worktrees`, id)

    // Ensure the target repo is a git repo with at least one commit
    if (config.autoInitGit !== false) {
      await $`git rev-parse --git-dir`
        .cwd(config.basePath)
        .quiet()
        .nothrow()
        .then(async (result) => {
          if (result.exitCode !== 0) {
            await $`git init`.cwd(config.basePath)
            await $`git -c user.email=dag@opencode.ai -c user.name=DAG commit --allow-empty -m init`.cwd(config.basePath)
          }
        })
    }

    // Create the worktree with a new branch
    await $`git worktree add -b ${branch} ${wtPath}`.cwd(config.basePath)

    const info: WorktreeInfo = {
      id,
      name,
      path: wtPath,
      branch,
      status: "active",
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      autoCleanup: config.autoCleanup,
    }
    this.worktrees.set(id, info)
    return info
  }

  async get(id: string): Promise<WorktreeInfo | undefined> {
    return this.worktrees.get(id)
  }

  async list(): Promise<WorktreeInfo[]> {
    return Array.from(this.worktrees.values())
  }

  async update(id: string, status: WorktreeStatus): Promise<void> {
    const wt = this.worktrees.get(id)
    if (!wt) throw new Error(`Worktree not found: ${id}`)
    wt.status = status
    wt.lastUsedAt = Date.now()
    if (wt.autoCleanup && (status === "completed" || status === "failed")) {
      // Async cleanup — don't block the caller
      void this.cleanup(id).catch(() => {})
    }
  }

  async cleanup(id: string): Promise<void> {
    const wt = this.worktrees.get(id)
    if (!wt) throw new Error(`Worktree not found: ${id}`)

    // Remove the worktree (force, since it may have uncommitted changes)
    await $`git worktree remove --force ${wt.path}`.cwd(wt.path).quiet().nothrow()
    // Delete the branch
    await $`git branch -D ${wt.branch}`.cwd(wt.path).quiet().nothrow()

    wt.status = "deleted"
  }

  async cleanupMany(ids: string[]): Promise<void> {
    await Promise.allSettled(ids.map((id) => this.cleanup(id)))
  }

  /** Read the use_worktree flag from node config (preserved read pattern). */
  static readUseWorktree(config: unknown): boolean {
    return (config as { use_worktree?: boolean } | undefined)?.use_worktree === true
  }
}
