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
 * Is `dir` trusted? Thin shell over `isTrustedDir(dir, loadTrustedList())` —
 * reads the persisted trust list and applies path-boundary matching.
 */
export function isTrusted(dir: string): boolean {
  return isTrustedDir(dir, loadTrustedList())
}

/**
 * Minimal write helper: append `dir` to the trust list (deduped, best-effort
 * atomic write). Used by the future interactive trust flow and by tests that
 * need to seed the list. Never throws — a write failure logs and is ignored
 * (the caller can retry; trust is additive, not safety-critical on write).
 */
export function addTrusted(dir: string): void {
  try {
    const trusted = loadTrustedList()
    if (trusted.includes(dir)) return
    trusted.push(dir)
    writeFileSync(trustFilePath(), JSON.stringify(trusted, null, 2))
  } catch (err) {
    log.warn("failed to persist trusted-workspaces.json entry", { dir, error: String(err) })
  }
}
