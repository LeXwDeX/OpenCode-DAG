## Why

OpenCode's hooks configuration currently reads from 6 directory layers, 3 of which are Claude Code's `.claude/` directories. This creates an implicit dependency on Claude Code's ecosystem and a confusing dual-directory structure. This change establishes OpenCode's own identity by moving hooks to dedicated `hooks.json` files in OpenCode-only directories, with an agent-guided slash command for one-time migration from Claude configs.

## What Changes

### Config location: 6-layer chain (up to 10 files with worktree) → dedicated files

- **Global hooks**: `~/.config/opencode/hooks.json` (was: hooks field inside `~/.claude/settings.json` + `~/.config/opencode/settings.json`)
- **Project hooks**: `.opencode/hooks.json` (was: hooks field inside `.claude/settings.json` + `.opencode/settings.json` + `.local` variants)
- **Worktree hooks**: when the git worktree root differs from the project directory, `<worktree>/.opencode/hooks.json` is also read (preserves existing worktree support in `loadChain()`)
- `.claude/` directories are no longer read for hooks — complete cut, no backward compatibility layer
- `.local` variants are dropped — no `hooks.local.json`. One file per scope. (Users who need machine-local hooks can git-ignore `.opencode/hooks.json` themselves.)
- **Deprecation warning**: if any `settings.json` in the old chain still contains a `hooks` field, log a one-time warning per file pointing to `/import-claude-hooks` — hooks there are ignored, never silently executed

### File format: dedicated hooks.json

Hooks move out of `settings.json` into their own file. The `hooks` wrapper key is dropped (filename is self-describing):

```jsonc
// ~/.config/opencode/hooks.json or .opencode/hooks.json
{
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "./scripts/check.sh", "timeout": 10 }]
    }
  ],
  "SessionStart": [
    {
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "./scripts/welcome.sh" }]
    }
  ]
}
```

`settings.json` retains other settings (agents, permissions, `allowUntrusted`, etc.) but no longer carries a `hooks` field.

### Hot reload: project-level only

Hooks config hot reload watches **project-level (and worktree) `.opencode/hooks.json` only**. The global `~/.config/opencode/hooks.json` is loaded once at startup and NOT watched — global hooks change rarely; changing them requires a restart.

Detection strategy: **interval polling** (mtime/content-hash check every N seconds, default 2s, configurable) instead of relying solely on `fs.watch`. Rationale: inotify events are unreliable on WSL2 DrvFs mounts (`/mnt/*`) and network filesystems; polling one small file per interval is cheap and deterministic. On change: re-run the hooks loader and atomically swap the registered hook state (re-register), same semantics as the existing `watchSettings` reload callback. Keep the existing debounce/min-interval guard (no reload storms on rapid saves).

### Slash command: `/import-claude-hooks`

A global slash command (markdown prompt file, agent-guided — zero new TypeScript code) that:

1. Reads `~/.claude/settings.json` and `./.claude/settings.json` (and `.local` variants)
2. Extracts the `hooks` field from each
3. Presents each hook to the user for review (import / skip / edit)
4. Writes approved hooks to the corresponding `hooks.json` (global → global, project → project)
5. Updates the `<!-- Hooks_START -->...<!-- Hooks_END -->` managed section in `AGENTS.md`
6. Reports summary; does NOT modify the original `.claude/` files

### AGENTS.md managed section

A machine-managed block between HTML comment markers, auto-updated by the import command:

```markdown
<!-- Hooks_START -->
## Active Hooks (auto-generated — do not edit between markers)

| Event | Matcher | Type | Summary |
|-------|---------|------|---------|
| PreToolUse | Bash | command | Security validation before shell commands |
| SessionStart | * | command | Load project context |

Full config: `.opencode/hooks.json` and `~/.config/opencode/hooks.json`
<!-- Hooks_END -->
```

This section is read by the agent at session start (AGENTS.md is already loaded as instructions), giving the agent self-awareness of its hook environment without reading the full config.

## Capabilities

### New Capabilities

- `hooks-config`: Contract for hooks configuration file format, discovery paths, and migration flow.

### Modified Capabilities

(none — `openspec/specs/` has no prior hooks spec)

## Impact

- `packages/opencode/src/hook/settings.ts` — `loadChain()`: remove `.claude/` and `.local` paths, read `hooks.json` (global + project + worktree), top-level events (no `hooks` wrapper key), add deprecation warning for `hooks` field left in old `settings.json` files
- `packages/opencode/src/hook/extensions/hot-reload.ts` — `settingsDirs()`/`watchSettings()`: watch project-level (and worktree) `.opencode/hooks.json` only; switch from `fs.watch` to interval polling (default 2s, configurable); global dir no longer watched
- `~/.config/opencode/command/import-claude-hooks.md` — NEW slash command prompt (OpenCode loads commands via `{command,commands}/**/*.md`)
- `AGENTS.md` — add `<!-- Hooks_START -->` / `<!-- Hooks_END -->` markers (initially empty or populated by first import)
- `readJSON()`/`__sourceDir` stamping (settings.ts:542): adapt to the new top-level-events format; `__sourceDir` (drives `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}` expansion) will now point at `.opencode/` or `~/.config/opencode/` instead of `.claude/` — commands relying on it must be migrated by the import command, not copied verbatim
- Hot-reload wiring (settings.ts:1353): the polling watcher must keep the same contract as `watchSettings` — reload callback mutates `stateObj.settings` in place, `close()` via Effect finalizer
- `loadChain`/`watchSettings` currently have NO test coverage — this change must add unit tests for the new loader (path resolution, merge order, deprecation warning) and the polling reload
- No HTTP API route changes; no DB schema changes; no SDK regeneration
- Functional behavior (event dispatching, handler execution, permission decisions, matchers, exit codes) is UNCHANGED — this is a config-location and file-format change only
