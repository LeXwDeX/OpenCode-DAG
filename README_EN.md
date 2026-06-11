<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
-->

<p align="center">
  <a href="./README.md">中文</a> ·
  <a href="./README_EN.md"><b>English</b></a> ·
  <a href="./README_AR.md">العربية</a> ·
  <a href="./README_BR.md">Português (Brasil)</a> ·
  <a href="./README_BS.md">Bosanski</a> ·
  <a href="./README_DA.md">Dansk</a> ·
  <a href="./README_DE.md">Deutsch</a> ·
  <a href="./README_ES.md">Español</a> ·
  <a href="./README_FR.md">Français</a> ·
  <a href="./README_JA.md">日本語</a> ·
  <a href="./README_KO.md">한국어</a> ·
  <a href="./README_NO.md">Norsk</a> ·
  <a href="./README_PL.md">Polski</a> ·
  <a href="./README_RU.md">Русский</a> ·
  <a href="./README_TH.md">ไทย</a> ·
  <a href="./README_TR.md">Türkçe</a> ·
  <a href="./README_UK.md">Українська</a>
</p>

# OpenCode (Enhanced Edition)

> **⚠️ Disclaimer** — This project is an enhanced fork of [opencode](https://github.com/sst/opencode), maintained by an independent developer. It is **not affiliated with, endorsed by, or officially supported** by the OpenCode team. The original project is released under the MIT License by the opencode team. This fork keeps upstream code under MIT while adding new proprietary modules under a stronger copyleft license. See [NOTICE](./NOTICE) for details.

## Introduction

This is a **reimagined and enhanced edition** of the upstream `opencode`, focused on:

- 🔧 **Debugging Chinese-language edge cases** — fixes for issues with CJK tokenization, fullwidth punctuation, Chinese paths, and IME interaction discovered in the upstream version (see [CJK Fixes Log](./docs/localization/zh-hans-fixes.md))
- 🧩 **Shipping a production-grade DAG workflow engine** — the self-developed [Harness-DAG-Workflow](./docs/harness-dag.md) lets LLM agents orchestrate multi-node parallel tasks inside a single session
- 🎯 **Preserving upstream compatibility** — upstream MIT-licensed code is untouched functionally, no build breakage, no API pollution

## Installation

```bash
# Direct install (YOLO)
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest        # also works with bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS & Linux (recommended, always latest)
brew install opencode              # macOS & Linux (official formula, less frequent)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # any OS
nix run nixpkgs#opencode           # or use github:anomalyco/opencode for latest dev branch
```

> [!TIP]
> Remove pre-0.1.x versions before installing.

## Unique Features of This Branch

This branch, built on upstream opencode, **adds** or **significantly enhances** the following capabilities (details in each section):

| Feature | Description | License |
|--------|-------------|---------|
| 🧩 DAG HARNESS Orchestration Task System | Enables LLM agent to orchestrate multi-node parallel workflows in a single session | AGPL-3.0 |
| 🪝 HOOKS API Superset Implementation | Full Hooks system with 22 runtime events × 5 execution types | MIT + branch enhancements |
| 🛡️ Lightweight CODING Isolation Spaces | Dual-track isolated execution environments via Sandbox + Worktree | MIT + branch enhancements |
| 🔧 Chinese Localization DEBUG | CJK tokenization / fullwidth punctuation / IME compatibility / Chinese paths | MIT |
| 🔬 Other Minor DEBUGs | Copy-paste, East-Asian width, Chinese output truncation, etc. | MIT |

### 🧩 DAG HARNESS Orchestration Task System (Self-developed Module · AGPL-3.0)

Formerly Harness-DAG-Workflow. A production-grade **Directed Acyclic Graph (DAG) workflow engine** that enables an LLM agent to orchestrate complex parallel tasks within a single session. Core capabilities:

- **Auto-scheduling**: Automatically spawn sub-agents based on node dependencies, executing in parallel
- **Dynamic re-planning**: Replan the workflow at runtime (add/remove/modify nodes, adjust concurrency limits)
- **Mandatory compliance**: Unbypassable state machine, irreversible terminal states, guaranteed event broadcasting, persistence-first design
- **Slash command integration**: `/dag-ctl` for runtime control, `/dag-worker` for workflow configuration
- **Persistent auditing**: SQLite 6-table schema; all state changes are fully traceable

Complete architecture design: [Harness-DAG-Workflow documentation](./docs/harness-dag.md), development guide: [AGENTS.md](./packages/opencode/src/dag/AGENTS.md).

> **License**: This module ([`packages/opencode/src/dag/`](./packages/opencode/src/dag/), [`packages/opencode/src/tool/dag-worker.ts`](./packages/opencode/src/tool/dag-worker.ts), [`packages/opencode/src/tool/node_complete.ts`](./packages/opencode/src/tool/node_complete.ts) and associated templates and documentation) is released under the **GNU AGPL v3** license — using this module requires open-sourcing all modifications. See [NOTICE](./NOTICE) and [packages/opencode/src/dag/LICENSE](./packages/opencode/src/dag/LICENSE)

### 🪝 HOOKS API Superset Implementation

This branch fully retains and enhances the upstream Hooks API system:

- **22 runtime trigger events**: `PreToolUse` / `PostToolUse` / `FileChanged` / `UserPromptSubmit` / `Stop` / `SessionStart` / `SessionEnd` / `PermissionRequest` / `PermissionDenied` / `SubagentStart` / `SubagentStop` / `TaskCreated` / `TaskCompleted` / `TeammateIdle` / `PreCompact` / `PostCompact` / `WorktreeCreate` / `WorktreeRemove` / `ConfigChange` / `InstructionsLoaded` / `StopFailure` / `PostToolUseFailure`
- **5 execution types**: `command` (shell) / `mcp` (MCP tool) / `http` (REST) / `prompt` (single-turn LLM) / `agent` (multi-turn LLM)
- **stdin/stdout JSON envelope communication protocol**: complete protocol documentation in [`hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md)
- **Branch enhancements**: DAG workflow event bus integration (`workflow.*` / `node.*` events) + TUI subscription + HTTP API forwarding

### 🛡️ Lightweight CODING Isolation Spaces

This branch provides a dual-track isolated execution environment, allowing agents/users to trial-run code in a safe sandbox without polluting the real repository:

| Isolation Level | Mechanism | Use Case |
|----------------|-----------|----------|
| **Sandbox** (lightweight) | Temporary directory + LSP diagnostics + multi-language toolchains (Python/Node/TS/Go/Rust/C/C++) | Code trial runs for single-file/small experiments |
| **Worktree** (heavyweight) | `git worktree` independent branch + separate filesystem view | Multi-agent parallel editing, large-scale refactoring |

- 📦 **Sandbox tool**: `packages/opencode/src/tool/sandbox.ts`, each sandbox has isolated dependency caches (venv / node_modules), supports `ephemeral` one-shot mode and `background` async long tasks
- 🌳 **DAG Worktree manager**: within DAG workflows, each parallel node can be automatically assigned to an independent worktree branch; upon node completion, results are merged back via `git merge`

### 🔧 Chinese Localization DEBUG (Upstream Issues Fixed)

Several compatibility/experience issues encountered in upstream versions under Chinese usage scenarios have been debugged and optimized, covering:

- **Chinese tokenization & token counting**: anomalous handling of CJK characters by certain tokenizers
- **Fullwidth punctuation compatibility**: tolerance for fullwidth colons, quotation marks, brackets during config parsing
- **Chinese path handling**: correct propagation of file paths containing spaces and CJK characters through hooks/sandboxes
- **Chinese Input Method (IME) compatibility**: input latency and cursor jitter in the TUI while the IME candidate window is active

For detailed fix records and regression tests, see [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md).

> 💡 If you discover other Chinese-related issues during use, please submit reproduction steps in the [issue area](./issues); I will continue debugging.

### 🔬 Other Minor DEBUGs (Integrated Upstream Fixes)

This branch fully retains several minor experience fixes from upstream, verified through regression testing:

| Issue | Upstream fix commit | Impact |
|-------|--------------------| ---|
| 📋 **Copy-paste content corruption** — pasted prompt content being incorrectly truncated or losing characters in the TUI | `564cde393e` [#28156](https://github.com/anomalyco/opencode/pull/28156) | TUI input experience |
| 📐 **Layout not refreshed after paste** — prompt box height not expanding automatically after pasting long text, causing visual truncation | `1124315267` [#28164](https://github.com/anomalyco/opencode/pull/28164) | TUI input experience |
| 📎 **No fallback on clipboard write failure** — when `navigator.clipboard` API fails (HTTP environment, etc.), copy operations error out directly | `fe143df151` [#27993](https://github.com/anomalyco/opencode/pull/27993) | Cross-browser compatibility |
| 🎨 **Insufficient foreground contrast on paste badge** — paste operation summary badge text hard to read in some themes | `e94aecaa08` [#27969](https://github.com/anomalyco/opencode/pull/27969) | TUI visual experience |
| 📏 **CJK / East-Asian character width estimation** — display width of emoji, fullwidth characters, Chinese characters not matching actual occupied width, causing cursor misalignment | Incorporated into the CJK tokenization fix system | TUI character alignment |
| ⌨️ **IME candidate window jitter** — cursor jitter + character insertion delay when Chinese/Japanese input methods are active | Local workaround patch | TUI input experience |

> This branch does not reinvent wheels: upstream-fixed issues are synced with the `stable` branch merges; this branch primarily debugs Chinese localization / DAG workflow-related issues not yet handled upstream.

## Features Preserved from Upstream (MIT)

All of the following come verbatim from the upstream opencode repo (MIT-licensed); this fork has made no functional changes to them.

### Desktop App (BETA)

Also available as a desktop app. Download from the [releases page](https://github.com/anomalyco/opencode/releases) or [opencode.ai/download](https://opencode.ai/download).

| Platform              | File                                    |
| --------------------- | --------------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-darwin-aarch64.dmg`   |
| macOS (Intel)         | `opencode-desktop-darwin-x64.dmg`       |
| Windows               | `opencode-desktop-windows-x64.exe`      |
| Linux                 | `.deb`, `.rpm`, or AppImage             |

```bash
# macOS (Homebrew Cask)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

### Agents

OpenCode ships with two agents, switchable via the `Tab` key:

- **build** — default mode, full permissions, for development work
- **plan** — read-only mode, for code analysis and exploration
  - refuses to modify files by default
  - asks before running bash commands
  - convenient for exploring unfamiliar code bases or planning changes

A **general** sub-agent is also included for complex search and multi-step tasks; can be invoked with `@general` inline.

Learn more about [Agents](https://opencode.ai/docs/agents).

### ClaudeCode Hooks API

This fork preserves the upstream Hooks API system and its 22 runtime-triggered events. Hooks are registered under the `hooks` field in the config file by event name and support five execution types: `command`, `mcp`, `http`, `prompt`, `agent`. They communicate via stdin/stdout JSON envelopes.

See [`packages/opencode/src/session/prompt/hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md) for the full protocol.

For the complete event table, see [upstream features retention doc](./docs/readmes/upstream-features.md).

## License & Attribution

This repository uses a **mixed licensing model**:

| Content | License | Location |
|---------|---------|----------|
| Upstream opencode code (the vast majority of files) | **MIT** | [`LICENSE`](./LICENSE) |
| Self-developed DAG workflow engine (`packages/opencode/src/dag/` and related tools / templates / docs) | **GNU AGPL v3** | [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

See the [`NOTICE`](./NOTICE) file for the full boundary description.

### 🔒 AGPL v3 Mandatory License Declaration (Hard Constraint for This Branch)

**The project author's policy on further development of this repository:**

1. **In-house code must adopt GNU AGPL v3** — Any code newly written, rewritten, or significantly modified by the author of this branch **must** be licensed under the GNU Affero General Public License v3 or later (AGPL-3.0-or-later)
2. **AGPL's copyleft requirement** — Any project that uses, modifies, or derives from AGPL-3.0 modules (e.g., DAG workflow engine) **must open-source its complete source code under AGPL-3.0**, and must provide access to end users
3. **SaaS mandatory open-source** — If you deploy this project or its derivative works as a network service (SaaS / cloud platform), you **must provide a complete source code download link to all users of that service** (this is the core clause that differentiates AGPL from GPL, §13)
4. **Attribution retention** — Must retain original author statements, copyright notices, and attribution information in the NOTICE file

> ⚖️ **Why AGPL?** The author believes the value of open-source software lies in ongoing collaboration. AGPL prevents the harm of 'closed-source SaaSification' to the open-source community — any commercial user benefiting from this project must give back to the community.

**MIT-licensed portions are not bound by this clause**, and are solely controlled by the upstream opencode team.

### Relationship with the Original OpenCode Team

- ✅ This project is **built upon** [opencode](https://github.com/sst/opencode) upstream code
- ❌ This project has **no affiliation or authorization relationship** with the official opencode team (sst / anomalyco)
- ❌ This project is not an official opencode release, and makes no support commitments to the official upstream
- ❌ **The OpenCode official team provides no technical support, warranty, or endorsement for this branch** (per upstream README's explicit attribution requirements)
- ✅ This project's enhancements such as the DAG workflow engine and Chinese-language DEBUG features are independently maintained by the author
- ✅ The attribution of upstream MIT code is fully preserved, with no tampering of authors and copyright notices

If you need to use the official opencode version, please visit https://opencode.ai or https://github.com/sst/opencode .

## Documentation Index

- [`docs/harness-dag.md`](./docs/harness-dag.md) — Harness-DAG-Workflow full docs
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — Chinese-language fix log
- [`docs/readmes/upstream-features.md`](./docs/readmes/upstream-features.md) — upstream opencode feature retention
- [`NOTICE`](./NOTICE) — license boundaries and attribution
- [`AGENTS.md`](./AGENTS.md) — contributor / secondary-dev guide

## Contributing

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) before opening a PR.

### Building on top of this fork

If you use "opencode" in your project name (e.g. "opencode-dashboard" or "opencode-mobile"), please state in your README that your project is not officially developed by, nor affiliated with, either the OpenCode team or the author of this fork.

## FAQ

### How is this different from Claude Code?

Functionally similar, but the key differences are:

- 100% open source
- Provider agnostic — we recommend [OpenCode Zen](https://opencode.ai/zen), but also works with Claude, OpenAI, Google, or local models
- Built-in LSP support
- Focused on the terminal UI (TUI)
- Client/server architecture — run on your machine, drive remotely from mobile
- **🪝 Hooks API Superset**: Building on Claude Code's 22 trigger events × 5 execution types, this fork is **fully compatible with the Claude Code Hooks protocol** and additionally provides DAG workflow event-bus integration (`workflow.*` / `node.*` events), TUI subscriptions, and HTTP API forwarding. Full protocol specification: [`hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md)
- **🎯 Goal Instruction System**: `todowrite` tool + structured goal tracking — persists a working task queue across long multi-step agent sessions, preventing task state loss from context-window churn
- **🪝 TODO PreHook**: Supports injecting the TODO list into context via `PreToolUse` hooks — a hooks-driven goal-reentry mechanism ensures the agent always sees current progress
- **🛡️ Sandbox Coding Workspace**: Every sandbox comes with its own ephemeral directory + LSP diagnostics + multi-language toolchains (Python/Node/TS/Go/Rust/C/C++) — agents can trial, compile, and debug code in isolation and only merge into project files via edit/write once verified

### How is this different from the official opencode?

- **🪝 Hooks API Superset + Goal Instructions + TODO PreHook + Sandbox Workspace**: Retains all upstream Hooks capabilities and adds DAG event integration, structured task tracking, hooks-driven goal reentry, and a multi-language isolated Coding sandbox (see above for details)
- **🧩 DAG WorkFlow Mode (WIP · ~90% complete)**: A self-developed [Harness-DAG-Workflow](./docs/harness-dag.md) engine that lets an LLM agent orchestrate multi-node parallel tasks within a single session. Core capabilities are landed (scheduling / lifecycle / pause-resume-cancel-replan-step / sub-DAG / conditional branching / data flow / crash recovery / probes), TUI panel connected, remaining polish in progress (see [DAG AGENTS.md](./packages/opencode/src/dag/AGENTS.md))
- **🔧 Chinese-Language Compatibility Fixes**: Ongoing DEBUG of CJK tokenization, fullwidth punctuation, Chinese path handling, and IME edge cases inherited from upstream
- Independently maintained, decoupled from upstream release cadence

## Community

- 📖 [Upstream opencode community](https://opencode.ai)
- 📝 [This fork's issues](./issues) (bug reports and feature suggestions)
