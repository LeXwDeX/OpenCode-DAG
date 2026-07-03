## Context

OpenCode's hooks system reads configuration from up to 10 files across 6 directory layers (including worktree variants), 3 of which are Claude Code's `.claude/` directories. Hooks are embedded inside `settings.json` alongside other settings. This design establishes hooks as a first-class citizen with dedicated `hooks.json` files in OpenCode-only directories.

**Code-verified findings (FABLE5 review):**
- `loadChain()` has exactly one call site (`settings.ts:1339`) + hot-reload callback (`:1356`)
- `watchSettings` wired at one point (`settings.ts:1353`)
- Other `.claude/` references (`provider.ts`, `instruction.ts`, `skill/index.ts`) are unrelated to hooks — boundary is clean
- `readJSON()` stamps `__sourceDir` per hook (`settings.ts:542`), driving `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}` expansion (`:486-487`) — migration must handle this
- Hot-reload contract: callback mutates `stateObj.settings` in place; `close()` via Effect finalizer
- `loadChain`/`watchSettings` have ZERO test coverage — must add

## Goals / Non-Goals

**Goals:**
- Hooks config in dedicated `hooks.json` (not mixed in `settings.json`)
- Only OpenCode directories read (`~/.config/opencode/` + `.opencode/` + worktree)
- `.claude/` completely cut for hooks
- Deprecation warning for hooks left in old `settings.json`
- Hot-reload: project-level only, interval polling (not fs.watch)
- Agent-guided slash command (`/import-claude-hooks`) with QA review
- AGENTS.md managed section for agent self-awareness

**Non-Goals:**
- Cutting `.claude/` from instructions (`instruction.ts` / `CLAUDE.md`) — separate change
- Cutting `.claude/` from skills (`skill/index.ts`) — separate change
- Changing the hooks protocol (events, handlers, matchers, permissions, exit codes)
- Watching global `~/.config/opencode/hooks.json` for hot-reload (startup-only)
- `.local` variant of hooks.json (one file per scope)

## Decisions

### D1. hooks.json format: top-level events (no wrapper)

File named `hooks.json` → outer `"hooks": {}` wrapper is redundant. Events are top-level keys. Graceful degradation: if wrapper IS present (migrated config), detect and extract inner object.

### D2. Three scopes (no .local)

```
~/.config/opencode/hooks.json     ← global (loaded once at startup)
.opencode/hooks.json              ← project (hot-reloaded)
<worktree>/.opencode/hooks.json   ← worktree (hot-reloaded, when worktree ≠ project)
```

No `.local` variant. Merge: concat-append (global → project → worktree, in load order). This matches the existing `mergeSettings()` behavior (`settings.ts:572`) and Claude Code semantics — hooks accumulate, they don't replace.

### D3. loadChain refactor

Minimal change to `loadChain()`:
1. Remove all `.claude/` path entries
2. Remove all `.local` entries
3. Change remaining entries from `settings.json` to `hooks.json`
4. Result: up to 3 candidate paths (global + project + worktree) instead of 10
5. Read top-level events (not `data.hooks`), with wrapper-detection fallback
6. `__sourceDir` stamping: points to `.opencode/` or `~/.config/opencode/` instead of `.claude/`

### D4. Deprecation warning for hooks in settings.json

If any `settings.json` in the old chain still contains a `hooks` field, `loadChain` logs a one-time warning per file:
```
"hooks field found in <path> — hooks are now loaded from hooks.json. Run /import-claude-hooks to migrate."
```
Hooks in `settings.json` are silently ignored (not executed).

### D5. Hot-reload: project-level only, interval polling

**Scope:** Only `.opencode/hooks.json` (project + worktree) is watched. Global `~/.config/opencode/hooks.json` loads once at startup — changing it requires restart.

**Strategy:** Interval polling (mtime/hash check every N seconds, default 2s, configurable). NOT `fs.watch`.

**Rationale:** WSL2 DrvFs mounts (`/mnt/*`) and network filesystems have unreliable inotify events. Polling one small file per interval is cheap and deterministic. The existing debounce/min-interval guard is kept (no reload storms).

**Contract:** On change detected → re-run hooks loader → mutate `stateObj.settings` in place (same contract as current `watchSettings` reload callback) → `close()` via Effect finalizer.

### D6. Slash command: .md format, agent-guided

Command file: `~/.config/opencode/command/import-claude-hooks.md` (OpenCode loads commands via `{command,commands}/**/*.md` glob — `.txt` would NOT be picked up).

The prompt instructs the agent to:
1. Read `~/.claude/settings.json`, `./.claude/settings.json`, `./.claude/settings.local.json`
2. Also read old-format `settings.json` hooks field (`.opencode/` + `~/.config/opencode/`)
3. Present each hook for review (import / skip / edit)
4. Handle `__sourceDir` migration: hooks using `${CLAUDE_PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_DATA}` must have paths updated (`.claude/` → `.opencode/`)
5. Write approved hooks to target `hooks.json` (global → global, project → project)
6. Update AGENTS.md managed section
7. Report summary; do NOT modify original `.claude/` files

### D7. AGENTS.md managed section

`<!-- Hooks_START -->` / `<!-- Hooks_END -->` markers. Import command writes a summary table between them. If markers absent, agent appends at end of AGENTS.md. Content outside markers preserved.

Format: Event | Matcher | Type | Summary (one-line). No full details (command paths, timeouts) — agent reads `hooks.json` on-demand.

## Risks / Trade-offs

- **[Breaking: .claude/ hooks stop working]** → `/import-claude-hooks` provides explicit migration; `.claude/` files unchanged
- **[Breaking: settings.json hooks field ignored]** → deprecation warning + import command reads old format
- **[`__sourceDir` path change breaks `${CLAUDE_PLUGIN_ROOT}` users]** → import command detects and rewrites paths during migration
- **[Polling overhead]** → 2s interval on one small file = negligible; configurable
- **[Global hooks not hot-reloaded]** → acceptable; global hooks change rarely; restart to apply
- **[AGENTS.md merge conflicts on managed section]** → clear markers; agent regenerates on import

## Open Questions

- **Q1.** Polling interval default (2s) — configurable via what? (opencode.jsonc field? env var?) Default: hardcoded constant for now.
- **Q2.** Should the managed section also update on hot-reload (runtime hooks.json change), or only on `/import-claude-hooks`? Default: only on import command.
- **Q3.** Resolved: OpenCode command glob is `{command,commands}/**/*.md` (`config/command.ts:15`), both singular and plural accepted. Use `~/.config/opencode/command/import-claude-hooks.md`.
