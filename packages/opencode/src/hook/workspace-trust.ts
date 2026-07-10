/**
 * [FORK:hook-ext] Workspace-trust gate for hook execution (WP-6B).
 *
 * Hooks reach into the user's shell, network, and LLM accounts — the same
 * threat model VS Code gates with workspace-trust. This module provides the
 * trust-decision primitive: `isTrusted(dir)` answers whether a directory is on
 * the persisted trust list, with PATH-SEGMENT-BOUNDARY matching so a sibling
 * like `/tmp/trusted-evil` cannot piggyback on `/tmp/trusted`'s trust.
 *
 * Trust list location: `<Global.Path.data>/trusted-workspaces.json` — a JSON
 * array of absolute directory paths. Missing file or invalid JSON degrades to
 * an empty list (everything untrusted); it NEVER throws (a trust gate that
 * throws would itself become a denial vector).
 *
 * Enforcement is opt-in (see settings.ts trigger): silent skip + log.warn when
 * enforcement is enabled and the dir is untrusted. This module only decides;
 * it does not enforce.
 */
import { existsSync, readFileSync, writeFileSync } from "fs"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@/util/log"

const log = Log.create({ service: "hook.workspace-trust" })

/** Absolute path to the persisted trust list. */
export function trustFilePath(): string {
  return path.join(Global.Path.data, "trusted-workspaces.json")
}

/**
 * Load the trust list from `file` (defaults to the persisted trust file).
 * Missing or unparseable file → empty array (everything untrusted). Non-string
 * entries are dropped. The `file` param lets tests point at an isolated temp
 * file instead of the real `<Global.Path.data>/trusted-workspaces.json`.
 */
export function loadTrustedList(file: string = trustFilePath()): string[] {
  try {
    if (!existsSync(file)) return []
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === "string")
  } catch (err) {
    log.warn("trusted-workspaces.json unreadable; treating all dirs as untrusted", {
      file,
      error: String(err),
    })
    return []
  }
}

/**
 * Pure trust predicate: is `dir` covered by any entry in `trusted`? Matches on
 * path-segment boundaries: `dir === entry` OR `dir` starts with `entry +
 * path.sep`. A bare `startsWith` would let `/home/u/proj-evil`蹭
 * `/home/u/proj`'s trust — explicitly forbidden. Exported (not just `isTrusted`)
 * so the boundary logic is unit-testable without touching the filesystem.
 */
export function isTrustedDir(dir: string, trusted: readonly string[]): boolean {
  for (const t of trusted) {
    if (dir === t || dir.startsWith(t + path.sep)) return true
  }
  return false
}

/**
 * Is `dir` trusted? Thin shell over `isTrustedDir(dir, loadTrustedList(file))`
 * — reads the persisted trust list and applies path-boundary matching. The
 * `file` param exists for test isolation and defaults to the real trust file.
 */
export function isTrusted(dir: string, file: string = trustFilePath()): boolean {
  return isTrustedDir(dir, loadTrustedList(file))
}

/**
 * Minimal write helper: append `dir` to the trust list (deduped, best-effort
 * atomic write). Used by the future interactive trust flow and by tests that
 * need to seed the list. Never throws — a write failure logs and is ignored
 * (the caller can retry; trust is additive, not safety-critical on write).
 * The `file` param exists for test isolation and defaults to the real file.
 */
export function addTrusted(dir: string, file: string = trustFilePath()): void {
  try {
    const trusted = loadTrustedList(file)
    if (trusted.includes(dir)) return
    trusted.push(dir)
    writeFileSync(file, JSON.stringify(trusted, null, 2))
  } catch (err) {
    log.warn("failed to persist trusted-workspaces.json entry", { dir, error: String(err) })
  }
}

/**
 * Scan the hooks.json chain (global / project / worktree) for a `requireTrust:
 * true` top-level key, without importing `loadChain` from settings.ts (that
 * would form a settings → workspace-trust → settings cycle). Mirrors the
 * chain semantics in settings.ts:requireTrust — any single layer opting in
 * enables enforcement. Used only by `/trust status` to report the gate source.
 */
function configRequireTrust(directory: string, worktree?: string): boolean {
  const files = [
    path.join(Global.Path.config, "hooks.json"),
    path.join(directory, ".opencode", "hooks.json"),
    ...(worktree && worktree !== directory ? [path.join(worktree, ".opencode", "hooks.json")] : []),
  ]
  for (const file of files) {
    try {
      if (!existsSync(file)) continue
      const parsed = JSON.parse(readFileSync(file, "utf8"))
      if (parsed && typeof parsed === "object" && parsed.requireTrust === true) return true
    } catch {
      // unreadable / unparseable — treat as not opting in
    }
  }
  return false
}

/**
 * `/trust` command dispatch (D3). Pure function — prompt.ts wires it via the
 * same early-return path as `/goal` and renders `{ text }` as a non-synthetic
 * text part. Trust writes are NEVER delegated to the LLM (security-sensitive).
 *
 * - `args === ""`        → add `directory` to the trust list (idempotent via
 *                          `addTrusted`'s never-throw dedup) and confirm.
 * - `args === "status"`  → trust judgment + requireTrust gate source
 *                          (hooks.json / env / off) + trust file path.
 *
 * The `file` param exists for test isolation and defaults to the real file.
 */
export function dispatchTrust(
  directory: string,
  args: string,
  worktree?: string,
  file: string = trustFilePath(),
): { text: string } {
  const sub = args.trim().toLowerCase()
  const envForced = process.env.OPENCODE_HOOKS_REQUIRE_TRUST === "1"
  const cfgForced = configRequireTrust(directory, worktree)
  const gateActive = envForced || cfgForced

  if (sub === "status") {
    const trusted = isTrusted(directory, file)
    const sources: string[] = []
    if (cfgForced) sources.push("hooks.json requireTrust")
    if (envForced) sources.push("OPENCODE_HOOKS_REQUIRE_TRUST=1")
    return {
      text:
        `工作区信任状态：\n` +
        `• 目录：${directory}\n` +
        `• 信任：${trusted ? "已信任" : "未信任"}\n` +
        `• requireTrust 门禁：${sources.length > 0 ? sources.join(" + ") : "未启用"}\n` +
        `• 信任文件：${file}`,
    }
  }

  // default: add current workspace to the trust list
  const already = isTrusted(directory, file)
  addTrusted(directory, file)
  // addTrusted never throws (write failure logs + is swallowed), so re-check
  // that the entry actually landed — a silent write failure must echo failure
  // to the user, not a false success (delta spec: hooks-workspace-trust).
  if (!already && !isTrusted(directory, file)) {
    return {
      text: `将 ${directory} 写入信任列表失败（信任文件：${file}）。请检查该路径是否可写，详细错误见日志。`,
    }
  }
  return {
    text: already
      ? `${directory} 已在信任列表中（幂等，未重复追加）。`
      : `已将 ${directory} 追加到信任列表。${gateActive ? "" : "\n（提示：requireTrust 门禁当前未启用；在 hooks.json 设置 \"requireTrust\": true 或 OPENCODE_HOOKS_REQUIRE_TRUST=1 后，信任列表才会门控 hook 执行。）"}`,
  }
}
