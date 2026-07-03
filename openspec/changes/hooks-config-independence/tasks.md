## 1. loadChain refactor — path + format

- [x] 1.1 `settings.ts` `loadChain()`: remove all `.claude/` path entries (lines ~597-611)
- [x] 1.2 Remove `.local` variant entries
- [x] 1.3 Change remaining entries from `settings.json` to `hooks.json`
- [x] 1.4 Add worktree candidate: `<worktree>/.opencode/hooks.json`
- [x] 1.5 Read top-level events (not `data.hooks`); add wrapper-detection fallback (`if "hooks" in data, use data.hooks`)
- [x] 1.6 Update `__sourceDir` stamping: now points to `.opencode/` or `~/.config/opencode/` (the directory containing the `hooks.json` that declared the hook)

## 2. Deprecation warning

- [x] 2.1 After loading `hooks.json`, scan the old `settings.json` chain for a `hooks` field
- [x] 2.2 If found, log a one-time warning per file: `"hooks field found in <path> — hooks are now loaded from hooks.json. Run /import-claude-hooks to migrate."`
- [x] 2.3 Hooks in `settings.json` are silently ignored (not loaded into the merge)

## 3. Hot-reload — project-only polling

- [x] 3.1 `hot-reload.ts`: remove global dir (`~/.config/opencode/`) from watch targets
- [x] 3.2 Remove all `.claude/` directories from watch targets
- [x] 3.3 Replace `fs.watch` with interval polling: check `.opencode/hooks.json` (and worktree variant) mtime every 2s (configurable constant)
- [x] 3.4 On mtime change: re-run hooks loader, mutate `stateObj.settings` in place (same contract as current `watchSettings`)
- [x] 3.5 Keep existing debounce (500ms) + min-interval (1s) guard
- [x] 3.6 `close()` via Effect finalizer (same as current)

## 4. Unit tests (loadChain + hot-reload — currently zero coverage)

- [x] 4.1 Test `loadChain` reads `hooks.json` from correct paths (global + project + worktree)
- [x] 4.2 Test merge order: global → project → worktree concat-append (global matchers first, project after, matching `mergeSettings()` at `settings.ts:572`)
- [x] 4.3 Test top-level events format parsing (no wrapper)
- [x] 4.4 Test wrapper-detection fallback (legacy `{"hooks": {...}}` format)
- [x] 4.5 Test deprecation warning fires when old `settings.json` has `hooks` field
- [x] 4.6 Test `.claude/` paths are NOT read
- [x] 4.7 Test polling reload: modify `hooks.json` → verify `stateObj.settings` mutated → verify new hooks take effect
- [x] 4.8 Test global `hooks.json` is NOT reloaded on change (startup-only)

## 5. Slash command — import-claude-hooks

- [x] 5.1 Verify OpenCode command glob pattern (`{command,commands}/**/*.md`) and determine correct directory (`command/` singular vs `commands/` plural)
- [x] 5.2 Create `~/.config/opencode/command/import-claude-hooks.md` (+ repo copy at `packages/opencode/command/`)
- [x] 5.3 Prompt instructs agent to read `~/.claude/settings.json`, `./.claude/settings.json`, `./.claude/settings.local.json`
- [x] 5.4 Prompt instructs agent to also read old-format hooks from `.opencode/settings.json` + `~/.config/opencode/settings.json`
- [x] 5.5 Prompt instructs agent to present each hook for user review (import / skip / edit)
- [x] 5.6 Prompt handles `__sourceDir` migration: detect `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}` references and rewrite paths from `.claude/` to `.opencode/`
- [x] 5.7 Prompt instructs agent to write approved hooks to target `hooks.json` (global → global, project → project)
- [x] 5.8 Prompt instructs agent to update AGENTS.md managed section
- [x] 5.9 Prompt instructs agent to report summary + remind user they can delete `.claude/` files

## 6. AGENTS.md managed section

- [x] 6.1 Define the marker format: `<!-- Hooks_START -->` / `<!-- Hooks_END -->`
- [x] 6.2 Define the summary table format: Event | Matcher | Type | Summary
- [x] 6.3 If markers absent in AGENTS.md, the import command appends them at the end
- [x] 6.4 If markers present, replace content between them (preserve outside)
- [x] 6.5 Verify the managed section is included in the agent's system prompt at session start (AGENTS.md is already loaded — just confirm the markers don't break parsing)

## 7. End-to-end validation

- [x] 7.1 Create a test `.claude/settings.json` with hooks → run `/import-claude-hooks` → verify hooks.json created correctly
- [x] 7.2 Modify `.opencode/hooks.json` at runtime → verify polling picks up the change → new hooks take effect
- [x] 7.3 Verify global `hooks.json` changes do NOT trigger reload (requires restart)
- [x] 7.4 Verify deprecation warning appears when old `settings.json` has hooks
- [x] 7.5 `bun run typecheck` from `packages/opencode` — green
- [x] 7.6 `bun test test/hook/` — all existing + new tests pass (21 pass, 0 fail; includes P1 `$schema` filtering + P2 deletion detection regression tests)
