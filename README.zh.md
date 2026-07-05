<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
-->

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh.md"><b>简体中文</b></a>
</p>

# OpenCode-DAG

> **[opencode](https://github.com/anomalyco/opencode) 的增强版 fork，内置生产级 DAG 工作流引擎，用于多智能体编排。**

基于 MIT 许可的 [opencode](https://github.com/anomalyco/opencode) 终端 AI 智能体构建。**与 OpenCode 团队无任何隶属或背书关系。**

---

## 分支状态

| 分支 | 基线 | 内容 | 状态 |
|--------|------|---------|--------|
| **`main`** | v1.17.11 | Hooks + Goal + 工具优化 | ✅ **稳定** |
| **`dag-branch`** | main + DAG | DAG 工作流引擎（114 files） | 🔧 **开发中** —— 适配 v1.17.11 API 中 |

> [!IMPORTANT]
> **DAG 工作流引擎正在从 v1.15.10 移植**到 v1.17.11 代码库。
> 它位于 `dag-branch` 上，**目前尚不可用**。`main` 分支已完全可用，
> 包含 Hooks、Goal 自动循环和工具异常暴露——全部为生产就绪状态。

---

## 本 fork 的独特之处

### 📌 `main` 上的稳定功能

#### Hooks API（26 events × 5 execution types）

完整的 Claude Code hooks 协议兼容性：`command`、`mcp`、`http`、`prompt`、`agent` 五种 hook 类型，共 26 个 hook 事件，涵盖 `PreToolUse`、`PostToolUse`、`SessionStart`、`PermissionRequest`、`WorktreeCreate` 等。Hooks 从全局 / 项目 / worktree 的 `hooks.json` 链中加载，也可在运行时通过 HTTP API 按会话注册；可选的工作区信任门控（`requireTrust` + `/trust` 命令）将 hook 执行限制在你已批准的目录内。

详见 [hooks 参考](./packages/core/src/plugin/skill/configure-hooks.md)。

#### Goal 自动循环

一个自主智能体循环，持续驱动智能体朝用户定义的目标推进。LLM 评判器在每个回合后判断目标是否已达成或是否需要更多回合，整个过程在可配置的回合预算内运行。`/goal <target>` 设置目标，`/subgoal` 添加子目标，`/goal resume` 继续一个暂停的目标。

#### 工具异常暴露

- **JSON 修复**：`safeParseJson` + `fixJsonUnicodeEscapes` —— 修复 LLM 生成的 JSON 中损坏的多字节 Unicode 转义
- **Question 工具校验**：结构化的错误格式化，带字段级提示和正确调用示例
- **工具描述**：扩展了 `question`、`task`、`skill`、`webfetch`、`websearch` 的 `.txt` 文档，新增 Parameters + Returns 章节
- **Shell 管道修复**：所有 `ChildProcess.make` 调用使用 `stdout/stderr: "pipe"` + reader fiber 优雅排空

### 🔧 `dag-branch` 上的开发中功能

#### DAG 工作流引擎（AGPL-3.0）

一个**有向无环图（DAG）工作流引擎**，让 LLM 智能体在单个会话内编排复杂的多节点并行任务。

> ⚠️ **状态**：从 v1.15.10 fork 原样复制（114 files）。217 个类型错误待 API 适配（将同步 `Database.use` → 基于 Effect 的 `Database.Service`、`Bus` → `EventV2Bridge` 等）。尚不可编译。

| 能力 | 描述 |
|---|---|
| **自动调度** | 按依赖顺序生成子智能体，尽可能并行 |
| **动态重规划** | 运行中添加/删除/更新节点并调整并发度 |
| **状态机完整性** | 四条铁律：禁止绕过状态机、终态不可逆、事件必须广播、先持久化再变更 |
| **终端 TUI** | 完整的 DAG 控制面板，带块字符拓扑图、树视图、节点对话框、实时更新 |
| **崩溃恢复** | 重启时检测并恢复孤立的运行中工作流 |
| **条件分支** | 节点可根据上游输出有条件地执行或跳过 |
| **子 DAG 嵌套** | `dag` worker 类型生成递归子工作流（max depth 3） |
| **持久化审计** | 6-table SQLite schema，所有状态转换可追溯 |

### CJK 与本地化修复

针对中文/日文/韩文文本处理的全面修复：分词、全角标点、文件路径、终端 UI 中的 IME 输入。详见[修复列表](./docs/localization/zh-hans-fixes.md)。

### 双重隔离：Sandbox + Worktree

- **Sandbox** —— 带 LSP 诊断的临时目录，用于安全的代码实验
- **Worktree** —— 每个工作流一个 `git worktree`，实现并行多智能体编辑隔离

---

## 安装

```bash
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest
brew install anomalyco/tap/opencode
scoop install opencode
# ...and more — see upstream docs
```

> [!TIP]
> 安装前请移除低于 0.1.x 的旧版本。

---

## 保留上游全部能力 —— 并提供更多

所有上游 MIT 许可的能力均完整保留：

- **桌面应用**（macOS / Windows / Linux）—— 从 [releases](https://github.com/anomalyco/opencode/releases) 下载
- **Build 与 Plan 智能体** —— 用 `Tab` 在完全访问和只读模式间切换
- **多 Provider** —— Claude、OpenAI、Google、本地模型，通过 [OpenCode Zen](https://opencode.ai/zen)
- **内置 LSP** —— 来自语言服务器的实时诊断
- **客户端/服务器架构** —— 本地运行，从移动端远程驱动

本 fork 在此基础上新增了 DAG 引擎、CJK 修复、sandbox 编码工作区和目标跟踪——且不破坏任何现有功能。

---

## 许可证

本仓库采用**混合许可证模型**：

| 内容 | 许可证 | 位置 |
|---------|---------|----------|
| 上游 opencode 代码（绝大多数） | **MIT** | [`LICENSE`](./LICENSE) |
| 自研 DAG 工作流引擎 | **GNU AGPL v3** | [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

完整的边界详情见 [`NOTICE`](./NOTICE)。

> ⚖️ **为何用 AGPL？** DAG 引擎是核心差异化成果。AGPL 确保任何衍生品——包括 SaaS 部署——都必须回馈开源。

---

## 文档

- [`docs/harness-dag.md`](./docs/harness-dag.md) —— DAG 引擎架构与用法
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) —— CJK 修复目录
- [`NOTICE`](./NOTICE) —— 许可证边界与归属
- [`AGENTS.md`](./AGENTS.md) —— 贡献与开发指南

## 社区

- 📖 [上游 opencode 社区](https://opencode.ai)
- 📝 [Fork issue 跟踪](./issues)
- 🔗 [GitHub](https://github.com/LeXwDeX/OpenCode-DAG)
