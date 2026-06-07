<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
-->

# Upstream OpenCode Features Preserved / 上游 OpenCode 能力保留

This document is a retention mirror of the upstream opencode README features that are unchanged in this fork. The upstream content is released under the **MIT License** (see [`/LICENSE`](/LICENSE)).

本文件保留自上游 opencode README 的能力描述，本 fork 未做功能性修改。上游内容采用 **MIT 许可**发布（见根目录 [`/LICENSE`](/LICENSE)）。

---

## Agents (from upstream README)

OpenCode ships two built-in agents switchable via `Tab`:

- **build** — default mode, full permissions
- **plan** — read-only, for analysis/exploration

A **general** sub-agent is also available, internally used or invokable inline via `@general`.

Learn more: [Agents](https://opencode.ai/docs/agents)

## Hooks API (from upstream README)

Hooks are registered under the `hooks` field in the config file by event name, supporting 5 execution types: `command`, `mcp`, `http`, `prompt`, `agent`. They communicate via stdin/stdout JSON envelopes.

Full protocol: [`packages/opencode/src/session/prompt/hooks-reference.md`](../../packages/opencode/src/session/prompt/hooks-reference.md)

### Runtime-triggered events (22 from upstream)

`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `FileChanged`, `UserPromptSubmit`, `Stop`, `StopFailure`, `InstructionsLoaded`, `SessionStart`, `SessionEnd`, `PermissionRequest`, `PermissionDenied`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `TeammateIdle`, `PreCompact`, `PostCompact`, `WorktreeCreate`, `WorktreeRemove`, `ConfigChange`.

### Schema-defined-only events (5 from upstream)

`Notification`, `Setup`, `Elicitation`, `ElicitationResult`, `CwdChanged`. (Registered hooks are loaded but never fire in current codebase.)

### Hook execution types

| Type | Description | Key fields |
|------|-------------|------------|
| `command` | Shell command via stdin/stdout JSON envelope | `command`, `timeout?` |
| `mcp` | Calls MCP tools (`mcp__<server>__<tool>`) | `command` (MCP tool name) |
| `http` | POSTs JSON envelope to URL | `url`, `headers?`, `timeout?` |
| `prompt` | Single-turn LLM call with structured output | `prompt`, `timeout?` |
| `agent` | Multi-turn read-only LLM agent | `prompt`, `timeout?` |

## Desktop App (from upstream README)

Download from [opencode.ai/download](https://opencode.ai/download) or the [releases page](https://github.com/anomalyco/opencode/releases).

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `opencode-desktop-darwin-aarch64.dmg` |
| macOS (Intel) | `opencode-desktop-darwin-x64.dmg` |
| Windows | `opencode-desktop-windows-x64.exe` |
| Linux | `.deb` / `.rpm` / AppImage |

```bash
brew install --cask opencode-desktop              # macOS
scoop bucket add extras; scoop install extras/opencode-desktop  # Windows
```

## Installation directory priority

1. `$OPENCODE_INSTALL_DIR` (custom)
2. `$XDG_BIN_DIR`
3. `$HOME/bin`
4. `$HOME/.opencode/bin` (default fallback)

## FAQ (from upstream)

### How is opencode different from Claude Code?

Functionally similar, but the key differences are:

- 100% open source
- Provider agnostic
- Built-in LSP support
- Focused on TUI
- Client/server architecture — run on your machine, drive remotely from mobile

---

**License note**: All content in this document (and the referenced upstream features) is copyright (c) 2025 opencode and licensed under MIT. See [`/LICENSE`](/LICENSE).
