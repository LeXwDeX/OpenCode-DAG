# js

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.2.12. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

## Hook System

OpenCode supports Claude Code-compatible hooks across 8 lifecycle events:
PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, SessionEnd,
Stop, SubagentStop, PreCompact.

### Handler Types

- `command` — shell command via stdin/stdout JSON envelope
- `mcp` — invoke an MCP tool registered as `mcp__<server>__<tool>`
- `http` — POST envelope to URL, parse JSON body
- `prompt` — LLM call with structured output (HookJSONOutput schema)
- `agent` — autonomous agent loop with bash/read_file/list_dir/grep tools

### Settings Layering

Six paths layered (last wins):

1. `~/.claude/settings.json`
2. `<opencode-global-config>/settings.json`
3. `<project>/.claude/settings.json`
4. `<project>/.opencode/settings.json`
5. `<project>/.claude/settings.local.json`
6. `<project>/.opencode/settings.local.json`

### CC Compatibility

- `Notification` event NOT supported — OpenCode permission UI uses the
  internal event bus instead.
- Exit code 2 → block; non-zero non-2 → silent log + continue.
- All handlers fail-safe: errors → silent allow + `log.warn` (a hook must
  never crash or block the host on infra failure).

