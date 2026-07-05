<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
-->

<p align="center">
  <a href="./README.md"><b>English</b></a> ·
  <a href="./README.zh.md">简体中文</a>
</p>

# OpenCode-DAG

> **An enhanced fork of [opencode](https://github.com/anomalyco/opencode) with a production-grade DAG workflow engine for multi-agent orchestration.**

Built on top of the MIT-licensed [opencode](https://github.com/anomalyco/opencode) terminal AI agent. **Not affiliated with or endorsed by the OpenCode team.**

---

## Branch Status

| Branch | Base | Content | Status |
|--------|------|---------|--------|
| **`main`** | v1.17.11 | Hooks + Goal + Tools optimization | ✅ **Stable** |
| **`dag-branch`** | main + DAG | DAG workflow engine (114 files) | 🔧 **In Development** — adapting to v1.17.11 APIs |

> [!IMPORTANT]
> The **DAG workflow engine is currently being ported** from v1.15.10 to the v1.17.11 codebase.
> It lives on the `dag-branch` and is **not yet functional**. The `main` branch is fully usable
> with Hooks, Goal auto-loop, and Tools exception exposure — all production-ready.

---

## What makes this fork different

### 📌 Stable on `main`

#### Hooks API (26 events × 5 execution types)

Full Claude Code hooks protocol compatibility: `command`, `mcp`, `http`, `prompt`, `agent` hook types with 26 hook events including `PreToolUse`, `PostToolUse`, `SessionStart`, `PermissionRequest`, `WorktreeCreate`, and more. Hooks load from a global / project / worktree `hooks.json` chain, or can be registered per-session at runtime over the HTTP API; optional workspace-trust gating (`requireTrust` + the `/trust` command) limits hook execution to directories you have approved.

See [hooks reference](./packages/core/src/plugin/skill/configure-hooks.md).

#### Goal Auto-Loop

An autonomous agent loop that continuously drives an agent toward a user-defined goal. An LLM judge decides after each turn whether the goal is achieved or needs more turns, within a configurable turn budget. `/goal <target>` to set, `/subgoal` to add sub-goals, `/goal resume` to continue a paused goal.

#### Tools Exception Exposure

- **JSON repair**: `safeParseJson` + `fixJsonUnicodeEscapes` — repairs broken multi-byte Unicode escapes in LLM-generated JSON
- **Question tool validation**: structured error formatting with field-level hints and correct-call examples
- **Tool descriptions**: expanded `.txt` docs for `question`, `task`, `skill`, `webfetch`, `websearch` with Parameters + Returns sections
- **Shell pipe fix**: `stdout/stderr: "pipe"` on all `ChildProcess.make` calls + reader fiber grace drain

### 🔧 In Development on `dag-branch`

#### DAG Workflow Engine (AGPL-3.0)

A **directed acyclic graph (DAG) workflow engine** that lets LLM agents orchestrate complex multi-node parallel tasks within a single session.

> ⚠️ **Status**: Raw-copied from the v1.15.10 fork (114 files). 217 type errors pending API adaptation (sync `Database.use` → Effect-based `Database.Service`, `Bus` → `EventV2Bridge`, etc.). Not yet compilable.

| Capability | Description |
|---|---|
| **Auto-scheduling** | Spawns child agents based on dependency order, parallel where possible |
| **Dynamic replanning** | Add/remove/update nodes and adjust concurrency mid-run |
| **State machine integrity** | Four iron laws: state machine bypass forbidden, terminal states irreversible, events must broadcast, persist before mutate |
| **Terminal TUI** | Full DAG control panel with block-char topology map, tree view, node dialogs, real-time updates |
| **Crash recovery** | Detects and resumes orphaned running workflows on restart |
| **Conditional branching** | Nodes can conditionally execute or skip based on upstream output |
| **Sub-DAG nesting** | Worker type `dag` spawns recursive sub-workflows (max depth 3) |
| **Persistent audit** | 6-table SQLite schema, all state transitions traceable |

### CJK & localization fixes

Extensive fixes for Chinese/Japanese/Korean text handling: tokenization, full-width punctuation, file paths, IME input in the terminal UI. See [fixes list](./docs/localization/zh-hans-fixes.md).

### Dual isolation: Sandbox + Worktree

- **Sandbox** — ephemeral temp dirs with LSP diagnostics for safe code experiments
- **Worktree** — `git worktree` per-workflow isolation for parallel multi-agent editing

---

## Install

```bash
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest
brew install anomalyco/tap/opencode
scoop install opencode
# ...and more — see upstream docs
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

---

## Keep the upstream — plus more

All upstream MIT-licensed capabilities are fully preserved:

- **Desktop app** (macOS / Windows / Linux) — download from [releases](https://github.com/anomalyco/opencode/releases)
- **Build & Plan agents** — `Tab` to switch between full-access and read-only modes
- **Multi-provider** — Claude, OpenAI, Google, local models via [OpenCode Zen](https://opencode.ai/zen)
- **Built-in LSP** — real-time diagnostics from language servers
- **Client/server architecture** — run locally, drive remotely from mobile

This fork adds the DAG engine, CJK fixes, sandbox coding workspace, and goal tracking on top — without breaking anything.

---

## License

This repository uses a **mixed license model**:

| Content | License | Location |
|---------|---------|----------|
| Upstream opencode code (the vast majority) | **MIT** | [`LICENSE`](./LICENSE) |
| Self-developed DAG workflow engine | **GNU AGPL v3** | [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

Full boundary details in [`NOTICE`](./NOTICE).

> ⚖️ **Why AGPL?** The DAG engine is the core differentiated work. AGPL ensures any derivative — including SaaS deployments — must contribute back.

---

## Docs

- [`docs/harness-dag.md`](./docs/harness-dag.md) — DAG engine architecture & usage
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — CJK fixes catalogue
- [`NOTICE`](./NOTICE) — license boundaries & attribution
- [`AGENTS.md`](./AGENTS.md) — contribution & development guide

## Community

- 📖 [Upstream opencode community](https://opencode.ai)
- 📝 [Fork issue tracker](./issues)
- 🔗 [GitHub](https://github.com/LeXwDeX/OpenCode-DAG)
