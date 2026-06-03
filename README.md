



## 简介

本项目是opencode官方版本的改版，内部有 ClaudeCode Hooks API的超集实现，Goal指令支持。

### 安装

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

#### 安装目录

安装脚本按照以下优先级决定安装路径：

1. `$OPENCODE_INSTALL_DIR` - 自定义安装目录
2. `$XDG_BIN_DIR` - 符合 XDG 基础目录规范的路径
3. `$HOME/bin` - 如果存在或可创建的用户二进制目录
4. `$HOME/.opencode/bin` - 默认备用路径

```bash
# 示例
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
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

### Hooks API

本项目实现了 ClaudeCode Hooks API 的超集，共支持 **27 个 Hook 事件**。其中 **22 个**在运行时存在具体的触发点，**5 个**仅在类型系统/配置解析层面被定义（已注册的 Hook 会被加载，但当前不会被触发）。

Hook 在配置文件的 `hooks` 字段中按事件名注册，支持 `command`、`mcp`、`http`、`prompt`、`agent` 五种执行类型，并通过 stdin/stdout 的 JSON 信封进行通信。完整协议（信封字段、stdout 控制 JSON、退出码语义、环境变量、聚合规则等）参见 [`packages/opencode/src/session/prompt/hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md)。

#### 运行时触发的事件（22 个）

这些事件在运行时存在具体的 `settingsHook.trigger()` 调用点：

| 事件 | 触发时机 | 负载字段 |
| --- | --- | --- |
| `PreToolUse` | 任意工具执行之前 | `toolName`、`toolInput`、`toolUseID?` |
| `PostToolUse` | 工具成功执行之后 | `toolName`、`toolInput`、`toolResponse`、`toolUseID?` |
| `PostToolUseFailure` | 工具执行失败之后 | `toolName`、`toolInput`、`error`、`isInterrupt?` |
| `FileChanged` | 文件被 edit/write 创建或修改 | `path`、`changeType` |
| `UserPromptSubmit` | 用户提交提示词 | `prompt` |
| `Stop` | Agent 完成一轮回合 | `stopHookActive`、`lastAssistantMessage?` |
| `StopFailure` | Agent 循环失败 | `stopHookActive`、`error`、`lastAssistantMessage?` |
| `InstructionsLoaded` | 加载 AGENTS.md/CLAUDE.md | `path`、`content` |
| `SessionStart` | 会话开始 | `source`（`startup`\|`resume`\|`clear`\|`compact`）、`model?`、`agentType?` |
| `SessionEnd` | 会话结束 | `reason`（`clear`\|`logout`\|`prompt_input_exit`\|`other`） |
| `PermissionRequest` | 请求工具权限 | `toolName`、`toolInput`、`permissionSuggestions?` |
| `PermissionDenied` | 工具权限被拒绝 | `toolName`、`toolInput`、`reason` |
| `SubagentStart` | 子 Agent 启动 | `agentID`、`agentType` |
| `SubagentStop` | 子 Agent 结束 | `stopHookActive`、`agentID?`、`agentTranscriptPath?`、`agentType?`、`lastAssistantMessage?` |
| `TaskCreated` | Task 工具创建子任务 | `taskID?`、`taskTitle?`、`taskDescription?` |
| `TaskCompleted` | Task 工具完成 | `taskID?`、`taskTitle?`、`result?` |
| `TeammateIdle` | 队友进入空闲状态 | `teammateID?`、`teammateName?` |
| `PreCompact` | 上下文压缩之前 | `trigger`（`auto`\|`manual`）、`customInstructions?` |
| `PostCompact` | 上下文压缩之后 | `trigger?`、`compactSummary?`、`customInstructions?` |
| `WorktreeCreate` | 创建 Git worktree | `path`、`branch` |
| `WorktreeRemove` | 移除 Git worktree | `path`、`branch` |
| `ConfigChange` | 配置文件变更 | `configPath`、`changes` |

#### 仅在 Schema 中定义的事件（5 个）

这些事件已在类型系统中定义并被设置解析器接受，但当前没有运行时触发点；为其注册的 Hook 会被加载但不会触发：

| 事件 | 说明 |
| --- | --- |
| `Notification` | 通知事件（预留） |
| `Setup` | 初始化/安装阶段（预留） |
| `Elicitation` | 信息征询（预留） |
| `ElicitationResult` | 信息征询结果（预留） |
| `CwdChanged` | 工作目录变更（预留） |

#### Hook 执行类型

| 类型 | 说明 | 关键字段 |
| --- | --- | --- |
| `command` | 通过 stdin/stdout JSON 信封执行 shell 命令 | `command`、`timeout?` |
| `mcp` | 调用 MCP 工具（`mcp__<server>__<tool>`） | `command`（MCP 工具名） |
| `http` | 向 URL POST JSON 信封 | `url`（或旧版回退 `command`）、`headers?`、`timeout?` |
| `prompt` | 单轮、带结构化输出的 LLM 调用 | `prompt`（系统提示词）、`timeout?` |
| `agent` | 多轮、具备只读工具的 LLM Agent | `prompt`（系统提示词）、`timeout?` |

### 文档

更多配置说明请查看我们的 [**官方文档**](https://opencode.ai/docs)。

### 参与贡献

如有兴趣贡献代码，请在提交 PR 前阅读 [贡献指南 (Contributing Docs)](./CONTRIBUTING.md)。

### 基于 OpenCode 进行开发

如果你在项目名中使用了 “opencode”（如 “opencode-dashboard” 或 “opencode-mobile”），请在 README 里注明该项目不是 OpenCode 团队官方开发，且不存在隶属关系。

### 常见问题 (FAQ)

#### 这和 Claude Code 有什么不同？

功能上很相似，关键差异：

- 100% 开源。
- 不绑定特定提供商。推荐使用 [OpenCode Zen](https://opencode.ai/zen) 的模型，但也可搭配 Claude、OpenAI、Google 甚至本地模型。模型迭代会缩小差异、降低成本，因此保持 provider-agnostic 很重要。
- 内置 LSP 支持。
- 聚焦终端界面 (TUI)。OpenCode 由 Neovim 爱好者和 [terminal.shop](https://terminal.shop) 的创建者打造，会持续探索终端的极限。
- 客户端/服务器架构。可在本机运行，同时用移动设备远程驱动。TUI 只是众多潜在客户端之一。

---

**加入我们的社区** [飞书](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [X.com](https://x.com/opencode)
