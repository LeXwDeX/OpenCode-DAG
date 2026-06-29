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
 * All settings file paths that participate in the hook chain.
 * Mirrors the 6-layer chain in settings.ts loadChain().
 */
function settingsFiles(projectDir: string, opencodeGlobalConfig?: string): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
  const candidates = [
    path.join(home, ".claude", "settings.json"),
  ]

  // Layer 2: opencode global config (if provided)
  if (opencodeGlobalConfig) {
    candidates.push(path.join(opencodeGlobalConfig, "settings.json"))
  }

  // Project-level files
  candidates.push(
    path.join(projectDir, ".claude", "settings.json"),
    path.join(projectDir, ".opencode", "settings.json"),
    path.join(projectDir, ".claude", "settings.local.json"),
    path.join(projectDir, ".opencode", "settings.local.json"),
  )

  // Only watch files whose parent directory exists
  return candidates.filter((f) => existsSync(path.dirname(f)))
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
 * Watch all settings files for changes. On change, call the reload
 * callback which should re-run loadChain() and update the state.
 *
 * @param projectDir - Project root directory
 * @param reload - Effect that re-runs loadChain() and returns new Settings
 * @param onReload - Callback invoked with new settings and changed file path
 * @param opencodeGlobalConfig - Optional path to opencode global config dir
 */
export function watchSettings(
  projectDir: string,
  reload: () => Effect.Effect<Settings>,
  onReload: (newSettings: Settings, changedFile: string) => void,
  opencodeGlobalConfig?: string,
): HotReloadHandle {
  const watchers: FSWatcher[] = []
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let lastReload = 0

  const files = settingsFiles(projectDir, opencodeGlobalConfig)
  log.info("watching settings files", { count: files.length, files })

  for (const file of files) {
    try {
      const watcher = watch(file, { persistent: false }, (eventType) => {
        if (eventType !== "change") return

        // Debounce: 500ms
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          const now = Date.now()
          if (now - lastReload < 1000) return // Min 1s between reloads
          lastReload = now

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
      // File doesn't exist yet — that's fine, it might be created later
      log.debug("skipping non-existent settings file", { file })
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
