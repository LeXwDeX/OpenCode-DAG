<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
-->

<p align="center">
  <a href="./README.md"><b>中文</b></a> ·
  <a href="./README_EN.md">English</a> ·
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

> **⚠️ 声明**：本项目是基于 [opencode](https://github.com/sst/opencode) 的优化分支，由独立开发者在原版基础上维护。本项目与 **OpenCode 官方团队无关**，不存在任何隶属关系、授权关系，也不是官方发布版本。原项目由 opencode 团队以 MIT 许可发布；**OpenCode 官方团队不对本分支提供任何支持或维护承诺**（按上游 README 的明确归属要求声明）。本分支在保留上游 MIT 许可的基础上，新增了若干自研模块（许可边界详见 [NOTICE](./NOTICE)）。

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

本分支基于上游 opencode 构建，**新增**或**显著增强**了以下能力（详情见各节）：

| 特性 | 简述 | 许可 |
|------|------|------|
| 🧩 DAG HARNESS 编排任务系统 | 让 LLM agent 在单次会话中编排多节点并行工作流 | AGPL-3.0 |
| 🪝 HOOKS API 超集实现 | 22 种运行时事件 × 5 种执行类型的完整 Hooks 体系 | MIT + 本分支增强 |
| 🛡️ 轻量级 CODING 隔离空间 | Sandbox + Worktree 双轨隔离执行环境 | MIT + 本分支增强 |
| 🔧 中文特性 DEBUG | CJK 分词 / 全角标点 / IME 兼容 / 中文路径 | MIT |
| 🔬 其他小型 DEBUG | 复制粘贴、东亚语言宽度、中文输出截断等 | MIT |

### 🧩 DAG HARNESS 编排任务系统（自研模块 · AGPL-3.0）

前身为 Harness-DAG-Workflow。一套生产级的 **有向无环图（DAG）工作流引擎**，让 LLM agent 能够在单个会话中编排复杂的并行任务。核心能力：

- **自动调度**：根据节点依赖关系自动 spawn 子 agent，并行执行
- **动态重规划**：运行中可实时 replan 工作流（增删改节点、调整并发上限）
- **铁律合规**：状态机不可绕过、终态不可逆、事件必广播、持久化优先
- **Slash 命令集成**：`/dag-ctl` 控制运行、`/dag-worker` 配置工作流
- **持久化审计**：SQLite 6 表 schema，所有状态变更可追溯

完整架构设计见 [Harness-DAG-Workflow 文档](./docs/harness-dag.md)，开发指南见 [AGENTS.md](./packages/opencode/src/dag/AGENTS.md)。

> **许可**：该模块（[`packages/opencode/src/dag/`](./packages/opencode/src/dag/)、[`packages/opencode/src/tool/dag-worker.ts`](./packages/opencode/src/tool/dag-worker.ts)、[`packages/opencode/src/tool/node_complete.ts`](./packages/opencode/src/tool/node_complete.ts) 及相关模板与文档）采用 **GNU AGPL v3** 许可发布——使用本模块需开源所有修改。详见 [NOTICE](./NOTICE) 与 [packages/opencode/src/dag/LICENSE](./packages/opencode/src/dag/LICENSE)

### 🪝 HOOKS API 超集实现

本分支完整保留并增强了上游的 Hooks API 体系：

- **22 种运行时触发事件**：`PreToolUse` / `PostToolUse` / `FileChanged` / `UserPromptSubmit` / `Stop` / `SessionStart` / `SessionEnd` / `PermissionRequest` / `PermissionDenied` / `SubagentStart` / `SubagentStop` / `TaskCreated` / `TaskCompleted` / `TeammateIdle` / `PreCompact` / `PostCompact` / `WorktreeCreate` / `WorktreeRemove` / `ConfigChange` / `InstructionsLoaded` / `StopFailure` / `PostToolUseFailure`
- **5 种执行类型**：`command`（shell）/ `mcp`（MCP 工具）/ `http`（REST）/ `prompt`（单轮 LLM）/ `agent`（多轮 LLM）
- **stdin/stdout JSON 信封通信协议**：完整协议文档见 [`hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md)
- **本分支增强**：DAG 工作流事件总线集成（`workflow.*` / `node.*` 事件）+ TUI 订阅 + HTTP API 转发

### 🛡️ 轻量级 CODING 隔离空间

本分支提供双轨隔离执行环境，让 agent / 用户在安全沙箱中试跑代码而不污染真实仓库：

| 隔离层级 | 机制 | 用途 |
|---------|------|------|
| **Sandbox**（轻量） | 临时目录 + LSP 诊断 + 多语言工具链（Python/Node/TS/Go/Rust/C/C++） | 单文件 / 小实验的代码试运行 |
| **Worktree**（重量） | `git worktree` 独立分支 + 独立文件系统视图 | 多 agent 并行编辑、大规模重构 |

- 📦 **Sandbox 工具**：`packages/opencode/src/tool/sandbox.ts`，每个 sandbox 有独立依赖缓存（venv / node_modules），支持 `ephemeral` 一次性模式与 `background` 异步长任务
- 🌳 **DAG Worktree 管理器**：在 DAG 工作流中，每个并行节点可自动分配到独立 worktree 分支，节点完成后通过 `git merge` 合入主线

### 🔧 中文特性 DEBUG（已修复的上游问题）

针对上游版本在中文使用场景下发现的若干兼容性 / 体验问题进行了 DEBUG 与优化，覆盖：

- **中文分词与 token 计数**：CJK 字符在部分 tokenizer 下的异常处理
- **全角标点兼容**：全角冒号、引号、括号在配置解析中的容错
- **中文路径处理**：含空格与 CJK 字符的文件路径在 hook / sandbox 中的正确传递
- **中文输入法（IME）兼容**：TUI 在 IME 候选窗下的输入延迟与光标抖动

 具体修复记录与回归测试见 [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md)。

> 💡 如果你在使用中发现其他中文特性问题，请在 [issue 区](./issues) 提交复现步骤，我会持续 DEBUG。

### 🔬 其他小型 DEBUG（已集成的上游修复）

本分支完整保留了上游若干小型体验问题的修复，并经过回归测试验证：

| 问题 | 上游修复 commit | 影响范围 |
|------|-----------------|----------|
| 📋 **复制粘贴内容损坏** — 用户粘贴的 prompt 内容在 TUI 中被错误截断或丢失字符 | `564cde393e` [#28156](https://github.com/anomalyco/opencode/pull/28156) | TUI 输入体验 |
| 📐 **粘贴后布局未刷新** — 粘贴长文本后 prompt 框高度未自动撑开，出现截断视觉效果 | `1124315267` [#28164](https://github.com/anomalyco/opencode/pull/28164) | TUI 输入体验 |
| 📎 **剪贴板写入失败时无回退** — 当 `navigator.clipboard` API 失败时（HTTP 环境等），复制操作直接报错 | `fe143df151` [#27993](https://github.com/anomalyco/opencode/pull/27993) | 跨浏览器兼容 |
| 🎨 **粘贴徽章前景色对比度不足** — 粘贴操作摘要徽章在某些主题下文字难以辨认 | `e94aecaa08` [#27969](https://github.com/anomalyco/opencode/pull/27969) | TUI 视觉体验 |
| 📏 **CJK / 东亚字符宽度估算** — emoji、全角字符、汉字等东亚宽度字符的显示宽度与实际占用不匹配，导致光标错位 | 已纳入 CJK 分词修复体系 | TUI 字符对齐 |
| ⌨️ **IME 候选窗抖动** — 中文 / 日文输入法激活时，光标抖动 + 字符插入延迟 | 本地 workaround 补丁 | TUI 输入体验 |

> 本分支不重复造轮子：上游已修复的问题会随 `stable` 分支合流更新同步；本分支主要 DEBUG 上游尚未处理的中文特性 / DAG 工作流相关问题。

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

### 🔒 AGPL v3 强制许可声明（本分支硬约束）

**本项目作者对本仓库的二次开发政策：**

1. **自研代码必须采用 GNU AGPL v3** — 任何由本分支作者新增、重写或显著修改的代码 **必须** 采用 GNU Affero General Public License v3 或更高版本（AGPL-3.0-or-later）
2. **AGPL 的传染性要求** — 任何使用、修改、衍生自 AGPL-3.0 模块（DAG 工作流引擎等）的项目，**必须以 AGPL-3.0 开源其完整源码**，且必须提供对最终用户的访问
3. **SaaS 强制开源** — 如果你将本项目或其衍生作品部署为网络服务（SaaS / 云平台），你**必须向所有使用该服务的用户提供完整源码下载链接**（这是 AGPL 区别于 GPL 的核心条款，§13）
4. **署名保留** — 必须保留原作者声明、版权标注、NOTICE 文件中的归属信息

> ⚖️ **为什么选择 AGPL？** 作者认为开源软件的价值在于持续协作。AGPL 阻止了"闭源 SaaS 化"对开源社区的侵害——任何受益于本项目的商业使用方都必须回馈社区。

**MIT 许可部分不受此条款约束**，仅由上游 opencode 团队控制。

### 与原 opencode 团队的关系

- ✅ 本项目**基于** [opencode](https://github.com/sst/opencode) 上游代码构建
- ❌ 本项目与 opencode 官方团队（sst / anomalyco）**无任何隶属或授权关系**
- ❌ 本项目不是 opencode 官方发布版本，也不对官方上游提供支持承诺
- ❌ **OpenCode 官方团队不对本分支提供任何技术支持、担保或背书**（按上游 README 明确归属要求）
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
- **🪝 Hooks API 超集**：在 Claude Code 原有 22 种触发事件 × 5 种执行类型的基础上，本分支**完整兼容 Claude Code Hooks 协议**，并新增了 DAG 工作流事件总线集成（`workflow.*` / `node.*` 事件）、TUI 订阅与 HTTP API 转发。完整协议规范见 [`hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md)
- **🎯 Goal 指令系统**：`todowrite` 工具 + 结构化目标追踪，让 agent 在长时间多步骤任务中持久化工作队列，避免上下文窗口丢失任务状态
- **🪝 TODO PreHook**：支持在 `PreToolUse` 钩子中注入 TODO 列表到上下文，hooks 驱动的目标重入机制确保 agent 始终能看到当前进度
- **🛡️ Sandbox Coding 工作区**：每个 sandbox 拥有独立临时目录 + LSP 诊断 + 多语言工具链（Python/Node/TS/Go/Rust/C/C++），agent 可在隔离沙箱中试跑代码、调试编译、运行测试，验证通过后再通过 edit/write 工具合并到项目文件

### 这和 opencode 官方版本有什么不同？

- **🪝 Hooks API 超集 + Goal 指令 + TODO PreHook + Sandbox 工作区**：在保留上游全部 Hooks 能力的基础上，新增 DAG 事件集成、结构化任务追踪、Hook 驱动的目标重入、多语言隔离 Coding 沙箱（详见上方差异对比）
- **🧩 DAG WorkFlow 模式（开发中 · 进度约 90%）**：自研 [Harness-DAG-Workflow](./docs/harness-dag.md) 工作流引擎，让 LLM agent 能在单次会话中编排多节点并行任务。核心功能已落地（调度 / 生命周期 / pause-resume-cancel-replan-step / 子 DAG / 条件分支 / 数据流 / crash recovery / 探针），TUI 面板已贯通，剩余能力正在收尾（详见 [DAG AGENTS.md](./packages/opencode/src/dag/AGENTS.md)）
- **🔧 中文特性 DEBUG**：持续 DEBUG 中文分词、CJK 字符、全角标点、中文路径与 IME 兼容等上游遗留问题
- 长期独立维护，与上游节奏解耦

## 社区

- 📖 [上游 opencode 社区](https://opencode.ai)
- 📝 [本分支 issue 区](./issues)（反馈问题与新特性建议）
