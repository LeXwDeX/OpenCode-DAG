<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
-->

<p align="center">
  <a href="./README.md">中文</a> · 
  <a href="./README_EN.md"><b>English</b></a>
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

## Features Unique to This Fork

### 🧩 Harness-DAG-Workflow (self-developed · AGPL-3.0)

A production-grade **Directed Acyclic Graph (DAG) workflow engine** that lets an LLM agent orchestrate complex parallel tasks in a single session. Core capabilities:

- **Automatic scheduling** — spawns sub-agents based on node dependency graph, executes in parallel
- **Live replanning** — add/remove/update nodes and concurrency caps mid-execution
- **Iron-laws compliant** — state machine cannot be bypassed; terminal states are irreversible; all state changes broadcast events and are persisted first
- **Slash command integration** — `/dag-ctl` for runtime control, `/dagworker` for workflow configuration
- **Durable audit trail** — 6-table SQLite schema, every state transition is traceable

Full architecture design: [Harness-DAG-Workflow docs](./docs/harness-dag.md). Developer guide: [AGENTS.md](./packages/opencode/src/dag/AGENTS.md).

> **License**: this module ([`packages/opencode/src/dag/`](./packages/opencode/src/dag/), [`packages/opencode/src/tool/dagworker.ts`](./packages/opencode/src/tool/dagworker.ts), [`packages/opencode/src/tool/node_complete.ts`](./packages/opencode/src/tool/node_complete.ts), and related templates/docs) is licensed under **GNU AGPL v3** — all modifications must be open-sourced. See [NOTICE](./NOTICE) and [packages/opencode/src/dag/LICENSE](./packages/opencode/src/dag/LICENSE).

### 🔧 Chinese-Language Bug Fixes

Fixes and improvements to upstream issues that surface in Chinese usage scenarios:

- **CJK tokenization / counting** — graceful handling of CJK characters in certain tokenizers
- **Fullwidth punctuation compatibility** — parser tolerates fullwidth colons, quotes, brackets in settings
- **Chinese paths** — hook / sandbox correctly propagate file paths that contain spaces or CJK characters
- **IME (Input Method Editor) compat** — reduced input lag and cursor jitter in the TUI under active IME candidate windows

Regression tests and full changelog: [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md).

> 💡 Found another Chinese-language bug? Open an [issue](./issues) with a repro — I'll keep debugging.

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

### Relationship with the Original opencode Team

- ✅ This project is **built on top of** [opencode](https://github.com/sst/opencode) upstream code
- ❌ This project has **no affiliation or authorization** from the OpenCode official team (sst / anomalyco)
- ❌ This is not an official opencode release and provides no upstream support
- ✅ The DAG engine, Chinese-language fixes, and other enhancements are independently maintained by the author
- ✅ Attribution and copyright notices from upstream MIT code are preserved in full

For the official opencode release, visit https://opencode.ai or https://github.com/sst/opencode .

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

### How is this different from the official opencode?

- Adds the Harness-DAG-Workflow engine (AGPL-3.0)
- Ongoing DEBUG of Chinese-language edge cases
- Independently maintained, decoupled from upstream release cadence

## Community

- 📖 [Upstream opencode community](https://opencode.ai)
- 📝 [This fork's issues](./issues) (bug reports and feature suggestions)
