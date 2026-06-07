<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
-->

<p align="center">
  <a href="./README.md"><b>中文</b></a> · 
  <a href="./README_EN.md">English</a>
</p>

# OpenCode (Enhanced Edition)

> **⚠️ 声明**：本项目是基于 [opencode](https://github.com/sst/opencode) 的优化分支，由独立开发者在原版基础上维护。本项目与 **OpenCode 官方团队无关**，不存在任何隶属关系。原项目由 opencode 团队以 MIT 许可发布，本分支在保留上游 MIT 许可的基础上，新增了若干自研模块（详见 [NOTICE](./NOTICE)）。

## 简介

本项目是 opencode 官方版本的**改版与增强版**，目标是：

- 🔧 **修复中文特性问题**：DEBUG 上游若干中文分词、CJK 字符处理、全角标点、中文路径与中文输入法场景下的兼容性问题（详见 [中文特性修复清单](./docs/localization/zh-hans-fixes.md)）
- 🧩 **提供生产级 DAG 工作流引擎**：自研 [Harness-DAG-Workflow](./docs/harness-dag.md)，让 LLM agent 能在一次会话中编排并驱动多节点并行任务
- 🎯 **保留上游兼容性**：所有上游 MIT 许可的代码保持原样，不破坏原有构建、不污染上游 API

## 安装

```bash
# 直接安装 (YOLO)
curl -fsSL https://opencode.ai/install | bash

# 软件包管理器
npm i -g opencode-ai@latest        # 也可使用 bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS 和 Linux（推荐，始终保持最新）
brew install opencode              # macOS 和 Linux（官方 brew formula，更新频率较低）
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # 任意系统
nix run nixpkgs#opencode           # 或用 github:anomalyco/opencode 获取最新 dev 分支
```

> [!TIP]
> 安装前请先移除 0.1.x 之前的旧版本。

## 本分支独有特性

### 🧩 Harness-DAG-Workflow（自研模块 · AGPL-3.0）

一套生产级的 **有向无环图（DAG）工作流引擎**，让 LLM agent 能够在单个会话中编排复杂的并行任务。核心能力：

- **自动调度**：根据节点依赖关系自动 spawn 子 agent，并行执行
- **动态重规划**：运行中可实时 replan 工作流（增删改节点、调整并发上限）
- **铁律合规**：状态机不可绕过、终态不可逆、事件必广播、持久化优先
- **Slash 命令集成**：`/dag-ctl` 控制运行、`/dagworker` 配置工作流
- **持久化审计**：SQLite 6 表 schema，所有状态变更可追溯

完整架构设计见 [Harness-DAG-Workflow 文档](./docs/harness-dag.md)，开发指南见 [AGENTS.md](./packages/opencode/src/dag/AGENTS.md)。

> **许可**：该模块（[`packages/opencode/src/dag/`](./packages/opencode/src/dag/)、[`packages/opencode/src/tool/dagworker.ts`](./packages/opencode/src/tool/dagworker.ts)、[`packages/opencode/src/tool/node_complete.ts`](./packages/opencode/src/tool/node_complete.ts) 及相关模板与文档）采用 **GNU AGPL v3** 许可发布——使用本模块需开源所有修改。详见 [NOTICE](./NOTICE) 与 [packages/opencode/src/dag/LICENSE](./packages/opencode/src/dag/LICENSE)

### 🔧 中文特性 DEBUG（已修复的上游问题）

针对上游版本在中文使用场景下发现的若干兼容性 / 体验问题进行了 DEBUG 与优化，覆盖：

- **中文分词与 token 计数**：CJK 字符在部分 tokenizer 下的异常处理
- **全角标点兼容**：全角冒号、引号、括号在配置解析中的容错
- **中文路径处理**：含空格与 CJK 字符的文件路径在 hook / sandbox 中的正确传递
- **中文输入法（IME）兼容**：TUI 在 IME 候选窗下的输入延迟与光标抖动

具体修复记录与回归测试见 [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md)。

> 💡 如果你在使用中发现其他中文特性问题，请在 [issue 区](./issues) 提交复现步骤，我会持续 DEBUG。

## 保留自上游的能力

以下能力完全来自上游 opencode（MIT 许可），本分支未做功能性修改：

### 桌面应用程序 (BETA)

OpenCode 也提供桌面版应用。可直接从 [发布页 (releases page)](https://github.com/anomalyco/opencode/releases) 或 [opencode.ai/download](https://opencode.ai/download) 下载。

| 平台                  | 下载文件                              |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `opencode-desktop-darwin-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe`    |
| Linux                 | `.deb`、`.rpm` 或 AppImage            |

```bash
# macOS (Homebrew Cask)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

### Agents

OpenCode 内置两种 Agent，可用 `Tab` 键快速切换：

- **build** - 默认模式，具备完整权限，适合开发工作
- **plan** - 只读模式，适合代码分析与探索
  - 默认拒绝修改文件
  - 运行 bash 命令前会询问
  - 便于探索未知代码库或规划改动

另外还包含一个 **general** 子 Agent，用于复杂搜索和多步任务，内部使用，也可在消息中输入 `@general` 调用。

了解更多 [Agents](https://opencode.ai/docs/agents) 相关信息。

### ClaudeCode Hooks API 超集实现

本分支完整保留了上游的 Hooks API 体系与 22 个运行时触发事件。Hook 在配置文件的 `hooks` 字段中按事件名注册，支持 `command`、`mcp`、`http`、`prompt`、`agent` 五种执行类型，并通过 stdin/stdout 的 JSON 信封进行通信。完整协议参见 [`packages/opencode/src/session/prompt/hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md)。

详细事件清单与执行类型表见 [README 原版保留章节](./docs/readmes/upstream-features.md)。

## 许可与归属

本仓库采用**混合许可模式**：

| 内容 | 许可 | 位置 |
|------|------|------|
| 上游 opencode 代码（绝大多数文件） | **MIT** | 见 [`LICENSE`](./LICENSE) |
| 自研 DAG 工作流引擎（`packages/opencode/src/dag/` 及相关工具、模板、文档） | **GNU AGPL v3** | 见 [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

完整边界说明见 [`NOTICE`](./NOTICE) 文件。

### 与原 opencode 团队的关系

- ✅ 本项目**基于** [opencode](https://github.com/sst/opencode) 上游代码构建
- ❌ 本项目与 opencode 官方团队（sst / anomalyco）**无任何隶属或授权关系**
- ❌ 本项目不是 opencode 官方发布版本，也不对官方上游提供支持承诺
- ✅ 本项目的 DAG 工作流引擎、中文特性 DEBUG 等增强由作者独立维护
- ✅ 上游 MIT 代码的归属完整保留，未篡改作者与版权声明

如需使用 opencode 官方版本，请访问 https://opencode.ai 或 https://github.com/sst/opencode 。

## 文档索引

- [`docs/harness-dag.md`](./docs/harness-dag.md) — Harness-DAG-Workflow 完整文档
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — 中文特性修复清单
- [`docs/readmes/upstream-features.md`](./docs/readmes/upstream-features.md) — 上游 opencode 能力保留说明
- [`NOTICE`](./NOTICE) — 许可边界与归属声明
- [`AGENTS.md`](./AGENTS.md) — 二次开发与贡献指南

## 参与贡献

如有兴趣贡献代码，请在提交 PR 前阅读 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

### 基于本 fork 进行开发

如果你在项目名中使用了 "opencode"（如 "opencode-dashboard" 或 "opencode-mobile"），请在 README 里注明该项目不是 OpenCode 团队官方开发且与本 fork 作者无隶属关系。

## 常见问题 (FAQ)

### 这和 Claude Code 有什么不同？

功能上很相似，关键差异：

- 100% 开源
- 不绑定特定提供商。推荐使用 [OpenCode Zen](https://opencode.ai/zen) 的模型，但也可搭配 Claude、OpenAI、Google 甚至本地模型
- 内置 LSP 支持
- 聚焦终端界面 (TUI)
- 客户端/服务器架构。可在本机运行，同时用移动设备远程驱动

### 这和 opencode 官方版本有什么不同？

- 新增 Harness-DAG-Workflow 工作流引擎（AGPL-3.0）
- 持续 DEBUG 中文使用场景的兼容性问题
- 长期独立维护，与上游节奏解耦

## 社区

- 📖 [上游 opencode 社区](https://opencode.ai)
- 📝 [本分支 issue 区](./issues)（反馈问题与新特性建议）
