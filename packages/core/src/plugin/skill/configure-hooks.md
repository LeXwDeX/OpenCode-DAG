<!--
  Built-in skill. Name and description are registered in code at
  packages/opencode/src/skill/index.ts (CONFIGURE_HOOKS_SKILL_DESCRIPTION).
  The body below becomes the skill's content.
-->

# Configuring OpenCode hooks

Hooks let you run code (shell command, MCP tool, HTTP call, LLM prompt, or an
autonomous sub-agent) automatically when specific events happen during a
session — before/after a tool call, on session start, on compaction, etc.
Config lives in dedicated `hooks.json` files (NOT `opencode.json`, NOT
`.claude/settings.json` — `.claude/` is never read for hooks).

## Where files live

| Scope   | Path                                | Hot-reloaded?                    |
| ------- | ------------------------------------ | --------------------------------- |
| Global  | `~/.config/opencode/hooks.json`      | No — requires restart             |
| Project | `.opencode/hooks.json`               | Yes — polled every ~2s            |
| Worktree| `<worktree>/.opencode/hooks.json`    | Yes (when worktree ≠ project dir) |

Layers concat-append (do NOT override by key): global hooks run, then project
hooks are appended after, in file order. A single event can have hooks from
multiple layers all firing.

If you find a `hooks` field left inside `settings.json` or `.claude/`, it is
ignored — point the user at `/import-claude-hooks` to migrate it.

## File format

Top-level keys are event names; each maps to a list of matcher blocks:

```json
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

`matcher` selects which tool/target the block applies to:

- `"*"` or omitted — matches everything
- `"Bash"` — exact match (case-insensitive)
- `"Bash|Edit|Write"` — pipe-separated list
- any other string — treated as a regex tested against the target

## Events (27 total)

Tool lifecycle: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`
Permission: `PermissionRequest`, `PermissionDenied`
Session lifecycle: `Setup`, `SessionStart`, `SessionEnd`, `Stop`, `StopFailure`
Subagents: `SubagentStart`, `SubagentStop`
Prompt/compaction: `UserPromptSubmit`, `PreCompact`, `PostCompact`
Tasks/goals: `TaskCreated`, `TaskCompleted`, `TeammateIdle`
Other: `Notification`, `Elicitation`, `ElicitationResult`, `ConfigChange`,
`WorktreeCreate`, `WorktreeRemove`, `InstructionsLoaded`, `CwdChanged`,
`FileChanged`

If you need the exact input/output shape for a specific event, read
`packages/opencode/src/hook/settings.ts` (`HookEvent`, `HookSpecificOutput`) —
this skill is a map, not the full schema.

## Hook types (all 5 implemented)

| `type`    | What it does                                                                 |
| --------- | ----------------------------------------------------------------------------- |
| `command` | Runs a shell command. Event data is piped to stdin as JSON; stdout/exit code drive the result. |
| `mcp`     | Invokes an MCP tool, addressed as `mcp__<server>__<tool>`.                    |
| `http`    | POSTs the event envelope to `url`; response body is parsed as JSON.           |
| `prompt`  | Sends the event to an LLM, constrained to structured JSON output.             |
| `agent`   | Runs an autonomous sub-agent loop (bash/read_file/list_dir/grep) to react to the event. |

### `command` protocol

- stdin: JSON envelope with event data
- exit code `0`: success, stdout optionally parsed as `HookJSONOutput` JSON
- exit code `2`: **block** — stderr becomes the block reason, shown to the agent
- any other exit code, or timeout: logged as a warning, does NOT abort the flow
- `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` expand to the directory the
  hook was declared in / its data dir — usable in `command`
- `options` (fork-only field, no CC equivalent): exported as
  `CLAUDE_PLUGIN_OPTION_<KEY>` env vars in the subprocess

### Common output fields (`HookJSONOutput`, applies across types)

```json
{
  "decision": "approve" | "block",
  "reason": "shown when blocking",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow" | "deny" | "ask",
    "additionalContext": "text injected into the session"
  }
}
```

Not every field applies to every event — `hookSpecificOutput` shape varies per
event (see `HookSpecificOutput` in `settings.ts` for the exact per-event union).

## Applying changes

Global `hooks.json` loads once at startup — **restart required**. Project and
worktree `hooks.json` are polled and take effect within a few seconds without
a restart.

## Migrating from Claude Code

`/import-claude-hooks` reads `~/.claude/settings.json` / `./.claude/settings.json`
/ `.claude/settings.local.json`, walks the user through importing each hook,
and writes approved ones into the right `hooks.json`. Point users here instead
of hand-copying Claude Code hook config.
