# Claude Code Hooks API — Complete Reference

This document is the authoritative reference for the Claude Code hooks protocol as implemented in OpenCode.
All information is derived from the source code (`packages/opencode/src/hook/settings.ts`).

## Hook Events

### Actively Triggered (22 events)

These events have concrete `settingsHook.trigger()` call sites in the runtime:

| Event | Trigger | Payload Fields |
|---|---|---|
| `PreToolUse` | Before any tool executed | `toolName`, `toolInput`, `toolUseID?` |
| `PostToolUse` | After tool completes successfully | `toolName`, `toolInput`, `toolResponse`, `toolUseID?` |
| `PostToolUseFailure` | After tool execution fails | `toolName`, `toolInput`, `error`, `isInterrupt?` |
| `FileChanged` | File created/modified by edit/write | `path`, `changeType` |
| `UserPromptSubmit` | User submits a prompt | `prompt` |
| `Stop` | Agent finishes its turn | `stopHookActive`, `lastAssistantMessage?` |
| `StopFailure` | Agent loop fails | `stopHookActive`, `error`, `lastAssistantMessage?` |
| `InstructionsLoaded` | AGENTS.md/CLAUDE.md loaded | `path`, `content` |
| `SessionStart` | Session begins | `source` ("startup"\|"resume"\|"clear"\|"compact"), `model?`, `agentType?` |
| `SessionEnd` | Session ends | `reason` ("clear"\|"logout"\|"prompt_input_exit"\|"other") |
| `PermissionRequest` | Tool permission requested | `toolName`, `toolInput`, `permissionSuggestions?` |
| `PermissionDenied` | Tool permission denied | `toolName`, `toolInput`, `reason` |
| `SubagentStart` | Sub-agent launched | `agentID`, `agentType` |
| `SubagentStop` | Sub-agent finished | `stopHookActive`, `agentID?`, `agentTranscriptPath?`, `agentType?`, `lastAssistantMessage?` |
| `TaskCreated` | Task tool creates subtask | `taskID?`, `taskTitle?`, `taskDescription?` |
| `TaskCompleted` | Task tool completes | `taskID?`, `taskTitle?`, `result?` |
| `TeammateIdle` | Teammate becomes idle | `teammateID?`, `teammateName?` |
| `PreCompact` | Before context compaction | `trigger` ("auto"\|"manual"), `customInstructions?` |
| `PostCompact` | After context compaction | `trigger?`, `compactSummary?`, `customInstructions?` |
| `WorktreeCreate` | Git worktree created | `path`, `branch` |
| `WorktreeRemove` | Git worktree removed | `path`, `branch` |
| `ConfigChange` | Config file changes | `configPath`, `changes` |

### Schema-Defined Only (5 events)

Defined in the type system and accepted by the settings parser, but no runtime trigger call sites exist. Hooks registered for these events will be loaded but not fired:

`Notification`, `Setup`, `Elicitation`, `ElicitationResult`, `CwdChanged`

## Settings File Chain (6 Layers)

Hooks are loaded from these paths, merged in order (later layers **append** to earlier ones — they do NOT replace):

| Layer | Path | Scope |
|---|---|---|
| 1 | `~/.claude/settings.json` | Claude Code global |
| 2 | `~/.config/opencode/settings.json` | OpenCode global |
| 3 | `<project>/.claude/settings.json` | Claude Code project |
| 4 | `<project>/.opencode/settings.json` | OpenCode project |
| 5 | `<project>/.claude/settings.local.json` | Claude Code local |
| 6 | `<project>/.opencode/settings.local.json` | OpenCode local |

If the git worktree root differs the working directory, the corresponding paths under the worktree root are also checked (appended after layer 6).

## Hook Entry Types

| Type | Description | Key Fields |
|---|---|---|
| `command` | Shell command via stdin/stdout JSON envelope | `command`, `timeout?` |
| `mcp` | Invoke MCP tool (`mcp__<server>__<tool>`) | `command` (the MCP tool name) |
| `http` | POST JSON envelope to URL | `url` (or `command` as legacy fallback), `headers?`, `timeout?` |
| `prompt` | Single-turn LLM call with structured output | `prompt` (system prompt), `timeout?` |
| `agent` | Multi-turn LLM agent with read-only tools | `prompt` (system prompt), `timeout?` |

### Common Fields (all types)

| Field | Type | Description |
|---|---|---|
| `timeout` | `number` (seconds) | Default: 60s. For `agent` type: milliseconds (default 60000) |
| `once` | `boolean` | Remove entry after first execution |
| `options` | `Record<string, unknown>` | Exported as `CLAUDE_PLUGIN_OPTION_<KEY>` env vars |

## Configuration Format

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "edit|write",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/script.sh",
            "timeout": 30
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "mempalace hook run --hook session-start --harness claude-code"
          }
        ]
      }
    ]
  }
}
```

### Matcher Patterns

| Pattern | Behavior |
|---|---|
| `undefined` or `"*"` | Match all |
| `"edit"` | Exact match (case-insensitive) |
| `"edit\|write"` | Pipe-separated list |
| `"/regex/"` | Regular expression |

For tool-bound events (PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, PermissionDenied), the matcher tests against the tool name. For other events, all matchers are matched.

## stdin Envelope

Every `command` hook receives a JSON object on stdin:

```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "01HXYZ...",
  "transcript_path": "/path/to/transcript",
  "cwd": "/path/to/project",
  "permission_mode": "default",
  "tool_name": "edit",
  "tool_input": { "filePath": "/path/to/file", "oldString": "...", "newString": "..." }
}
```

### Common Envelope Fields

| Field | Present In | Description |
|---|---|---|
| `hook_event_name` | All | Event name string |
| `session_id` | All | Current session ID |
| `transcript_path` | All | Path to transcript (may be empty) |
| `cwd` | All | Working directory |
| `permission_mode` | All | `"plan"` or `"default"` (derived from agent name) |
| `agent_id` | Subagent events | Sub-agent ID |
| `agent_type` | Subagent events | Sub-agent type name |

### Event-Specific Fields

- **PreToolUse**: `tool_name`, `tool_input`, `tool_use_id?`
- **PostToolUse**: `tool_name`, `tool_input`, `tool_response`, `tool_use_id?`
- **PostToolUseFailure**: `tool_name`, `tool_input`, `error`, `is_interrupt?`
- **FileChanged**: `path`, `change_type`
- **UserPromptSubmit**: `prompt`
- **Stop/StopFailure**: `stop_hook_active`, `last_assistant_message?` (+ `error` for StopFailure)
- **SessionStart**: `source`, `model?`, `agent_type?`
- **SessionEnd**: `reason`
- **PermissionRequest**: `tool_name`, `tool_input`, `permission_suggestions?`
- **PermissionDenied**: `tool_name`, `tool_input`, `reason`
- **SubagentStart**: `agent_id`, `agent_type`
- **SubagentStop**: `stop_hook_active`, `agent_id?`, `agent_transcript_path?`, `agent_type?`, `last_assistant_message?`
- **PreCompact**: `trigger`, `custom_instructions`
- **PostCompact**: `trigger?`, `compact_summary?`, `custom_instructions?`
- **WorktreeCreate/Remove**: `path`, `branch`
- **ConfigChange**: `config_path`, `changes`
- **TaskCreated**: `task_id?`, `task_title?`, `task_description?`
- **TaskCompleted**: `task_id?`, `task_title?`, `result?`
- **TeammateIdle**: `teammate_id?`, `teammate_name?`

## stdout Control JSON

The hook can return JSON on stdout to control runtime behavior:

```json
{
  "continue": true,
  "stopReason": "...",
  "suppressOutput": false,
  "systemMessage": "message to inject as system reminder",
  "decision": "approve",
  "reason": "explanation",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "...",
    "updatedInput": { "key": "rewritten-value" },
    "additionalContext": "text injected into agent context"
  }
}
```

### Top-Level Fields

| Field | Type | Effect |
|---|---|---|
| `continue` | `boolean` | `false` = stop the agent loop |
| `stopReason` | `string` | Reason for stopping (aggregated across hooks) |
| `suppressOutput` | `boolean` | Accepted but no-op (fork default is silent) |
| `systemMessage` | `string` | Injected as system reminder |
| `decision` | `"approve" \| "block"` | High-level decision |
| `reason` | `string` | Explanation for the decision |

### hookSpecificOutput Fields (by event)

**PreToolUse**:

- `permissionDecision`: `"allow" | "deny" | "ask"` — overrides permission check
- `permissionDecisionReason`: explanation
- `updatedInput`: rewrites tool arguments (last hook wins)
- `additionalContext`: text injected into agent context

**PostToolUse**:

- `additionalContext`: text appended to tool result
- `updatedMCPToolOutput`: replaces MCP tool output

**UserPromptSubmit / SessionStart / Notification / PermissionRequest / PermissionDenied / Setup / SubagentStart**:

- `additionalContext`: text injected into agent context

**SessionStart** additionally:

- `initialUserMessage`: synthetic first user message
- `watchPaths`: file paths to watch

**PostCompact** additionally:

- `displayMessage`, `compactSummary`, `customSummary`

## Exit Code Semantics

| Code | Meaning |
|---|---|
| `0` | Allow — parse stdout for control JSON |
| `2` | Block — stderr becomes the block reason |
| Other | Log warning, continue (hooks must never crash the host) |
| Timeout | Log warning, continue (non-blocking) |
| Spawn Error | Silent allow (hook infrastructure failure is non-fatal) |

## Environment Variables

| Variable | Source | Description |
|---|---|---|
| `CLAUDE_PROJECT_DIR` | Runtime | Project working directory |
| `CLAUDE_PLUGIN_ROOT` | `__sourceDir` | Directory of the settings file that declared the hook |
| `CLAUDE_PLUGIN_DATA` | Computed | Per-plugin persistent data directory: `<global-data>/hooks/<parent>-<base>-<sha256(sourceDir).slice(0,6)>` |
| `CLAUDE_PLUGIN_OPTION_<KEY>` | `options` field | Each key in `options` exported as `CLAUDE_PLUGIN_OPTION_<KEY>=JSON.stringify(value)` |

## Template Variables in `command`

| Template | Resolves To |
|---|---|
| `${CLAUDE_PLUGIN_ROOT}` | `entry.__sourceDir` (settings file directory) |
| `${CLAUDE_PLUGIN_DATA}` | `computeDataDir(entry.__sourceDir)` |
| `${user_config.<key>}` | `entry.options?.[key]` (string passthrough; non-string → `JSON.stringify`) |

Unknown/unresolvable templates are left verbatim (the shell's own env expansion may handle them).

## Aggregation Rules (Multiple Hooks)

When multiple hooks match the same event:

1. **additionalContext**: all strings collected, deduplicated
2. **permissionDecision**: first `"deny"` wins (short-circuit); otherwise last `"allow"` wins
3. **updatedInput**: last hook's value wins (CC behavior)
4. **blocked**: first `exit code 2` short-circuits remaining hooks
5. **continue=false**: first occurrence stops the agent loop
6. **systemMessage**: all messages collected

## Session-Scoped Hooks

In addition to the 6-layer settings file chain, hooks can be dynamically attached to a session at runtime (e.g., by a skill or agent frontmatter). These session-scoped hooks participate in the same matcher/aggregation pipeline as on-disk hooks.

Lifecycle: `add(sessionID, entry)` → active → `remove(sessionID, id)` or `clear(sessionID)` on session end.

## MCP Configuration

MCP servers are configured in OpenCode's config file:

```json
// ~/.config/opencode/opencode.json
{
  "mcp": {
    "server-name": {
      "type": "local",
      "command": ["npx", "-y", "some-mcp-server"]
    }
  }
}
```

This differs from Claude Code's `~/.claude.json` format, but the MCP protocol itself is identical. The same MCP server binaries work in both runtimes.
