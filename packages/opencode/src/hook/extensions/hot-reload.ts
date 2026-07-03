/**
 * [FORK:hook-ext] Settings file hot reload — not in upstream
 *
 * Watches all settings files in the 6-layer chain for changes and
 * triggers a reload when modifications are detected.
 *
 * Uses Node.js fs.watch (not @parcel/watcher) because:
 * 1. Settings files are few and stable — no need for recursive watching
 * 2. fs.watch is simpler and has lower overhead for individual files
 * 3. Avoids coupling to the FileWatcher service lifecycle
 *
 * Debounce: 500ms. Settings edits are human-driven; no need for
 * sub-second responsiveness. Prevents double-fire from save-as-you-type
 * editors.
 */

import { watch, type FSWatcher, existsSync } from "fs"
import path from "path"
import { Effect } from "effect"
import * as Log from "@/util/log"
import type { Settings } from "../settings"

const log = Log.create({ service: "hook.extensions.hot-reload" })

/**
 * Directories whose `settings.json` / `settings.local.json` participate in the
 * hook chain. We watch the parent directories (not the individual files) so a
 * settings file that does not exist yet is still detected the moment it is
 * created — watching the file directly would miss it entirely. Mirrors the
 * 6-layer chain in settings.ts loadChain().
 */
function settingsDirs(
  projectDir: string,
  worktree: string | undefined,
  opencodeGlobalConfig?: string,
): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
  const dirs = [
    path.join(home, ".claude"),
    path.join(projectDir, ".claude"),
    path.join(projectDir, ".opencode"),
  ]
  if (opencodeGlobalConfig) dirs.push(opencodeGlobalConfig)
  if (worktree && worktree !== projectDir) {
    dirs.push(path.join(worktree, ".claude"), path.join(worktree, ".opencode"))
  }
  // Dedupe (worktree may collapse onto project) and keep only existing dirs.
  return [...new Set(dirs)].filter((d) => existsSync(d))
}

export interface HotReloadHandle {
  /** Stop watching all files */
  close(): void
}

/**
 * Count total hooks in a settings object (for logging).
 */
function countHooks(settings: Settings): number {
  if (!settings.hooks) return 0
  let count = 0
  for (const matchers of Object.values(settings.hooks)) {
    if (!matchers) continue
    for (const m of matchers) {
      count += m.hooks.length
    }
  }
  return count
}

/**
 * Watch settings source directories for changes. On a `settings.json` /
 * `settings.local.json` change, call the reload callback which should re-run
 * loadChain() and update the state.
 *
 * @param projectDir - Project root directory
 * @param worktree - Optional git worktree root; its .claude/.opencode dirs are watched too
 * @param reload - Effect that re-runs loadChain() and returns new Settings
 * @param onReload - Callback invoked with new settings and changed file path
 * @param opencodeGlobalConfig - Optional path to opencode global config dir
 */
export function watchSettings(
  projectDir: string,
  worktree: string | undefined,
  reload: () => Effect.Effect<Settings>,
  onReload: (newSettings: Settings, changedFile: string) => void,
  opencodeGlobalConfig?: string,
): HotReloadHandle {
  const watchers: FSWatcher[] = []
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let lastReload = 0

  // Watch parent dirs and filter by settings filename inside the callback, so
  // a settings file created at runtime is detected even though it did not
  // exist when watching started.
  const watchedNames = new Set(["settings.json", "settings.local.json"])
  const dirs = settingsDirs(projectDir, worktree, opencodeGlobalConfig)
  log.info("watching settings dirs", { count: dirs.length, dirs })

  for (const dir of dirs) {
    try {
      const watcher = watch(dir, { persistent: false }, (eventType, filename) => {
        if (!filename || !watchedNames.has(filename)) return
        if (eventType !== "change") return

        // Debounce: 500ms
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          const now = Date.now()
          if (now - lastReload < 1000) return // Min 1s between reloads
          lastReload = now

          const file = path.join(dir, filename)
          log.info("settings file changed, reloading", { file })
          // Fire-and-forget: reload errors are logged but never crash
          Effect.runPromise(reload()).then(
            (settings) => {
              log.info("settings hot-reloaded", {
                file,
                hookCount: countHooks(settings),
              })
              onReload(settings, file)
            },
            (err) => log.warn("settings reload failed", { file, error: String(err) }),
          )
        }, 500)
      })
      watchers.push(watcher)
    } catch {
      // Dir removed between settingsDirs() and watch() — harmless.
      log.debug("skipping non-existent settings dir", { dir })
    }
  }

  return {
    close() {
      if (debounceTimer) clearTimeout(debounceTimer)
      for (const w of watchers) w.close()
      watchers.length = 0
      log.info("stopped watching settings files")
    },
  }
}
