# BUG 盘点与回归策略

> 来源：`git log dev --oneline --not upstream/dev | grep -iE "^[a-f0-9]+ (fix|修复)"`
> 数量：25+ 条 fork-only fix 提交
> 验证方式：在 `reset/upstream-1.14.30` 基线上逐条复验，**仍存在则需重新打补丁**，已被上游修则跳过。

## P0 · 启动 / 协议链路（必须在阶段 2 解决）

| commit | 主题 | 原因 | 上游状态 | 处置 |
|---|---|---|---|---|
| `4f70a50424` | cli: lazyCmd 包装 TuiThreadCommand 漏掉 $0 默认命令，裸 `opencode` 进不了 TUI | 启动路径阻断 | 待验证 | 复现 → 重打 |
| `26cc6c550b` | cli: 顶层 help/version 绕过启动 middleware | 启动慢 / 误初始化 | 待验证 | 复现 → 重打 |
| `4b00e5996f` | auth: auth login 路由冲突 + metadata 持久化丢失 | reference/auth-fix/ 已说明 | **仍在** | 必须打 |
| `2feac36a92` | storage: JsonMigration marker 与 DB 路径不一致，每次启动重跑迁移 | 启动慢 + 数据风险 | 待验证 | 复现 → 重打 |
| `6e470e46b1` | github-proxy: Claude thinking block signature chain 因 models 解析失败断链 | 协议中断 | reference 已带 | 在 plugin 重写时复刻 |
| `e51df12e32` | MCP timeout + orphan tool_use repair | 协议链路断裂 | 待验证 | 复现 → 重打 |
| `0f3017f33a` | 防止工具失败 / MCP 超时 / Hook EPIPE 导致主进程退出 | 进程崩溃 | 待验证 | 复现 → 重打 |
| `85a70a945d` | Thinking 末尾字符导致的异常 | 协议解析 | 待验证 | 复现 → 重打 |
| `b89482bb2c` | github-copilot fallback enterprise URL remap 误拼原 pathname | 路由错误 | reference 已带 | 在 plugin 重写时复刻 |
| `8321e38464` | github-copilot 官方插件 fallback 把 Claude 错路由到 chat/completions | 计费 + 协议错误 | reference 已带 | 在 plugin 重写时复刻 |

## P1 · 用户体验 / 稳定性（阶段 2 末尾或随特性带入）

| commit | 主题 | 处置 |
|---|---|---|
| `6b8fc5d412` | models schema 容错 + quota-status copilot 模式 + 启动超时保护 | 拆分到对应模块（models / quota / 启动）分别重打 |
| `884fb48db8` | tui: 收敛编译产物裸启动诊断 + 修复 linux 构建 | 复现后重打 |
| `767b2b675a` | test: 收敛 prompt cancel 系列 flaky | 测试改造 |
| `b3fecf4e4b` | build: build-local.ts 移除不存在的 ripgrep.worker entry | 复现 → 重打 |
| `c6360783a2` | test/session/prompt.test.ts typecheck 错误 | typecheck 阶段统一处理 |
| `14310e8a5e` | question 工具增加 formatValidationError 友好提示 | 复现 → 重打 |
| `a45d9a9b0a` | app: 项目编辑对话框 icon override 处理改进 | 仅 packages/app，本轮不在覆盖范围 |
| `3b929d8594` | restore custom-elements.d.ts 内容 | 仅 packages/app |
| `64c007ad27` | pre-push hook 添加 bun 到 PATH | 工程脚手架 |
| `66db62be2f` | opencode 包 tsgo typecheck 66 个类型推断错误 | 阶段 1 typecheck 跑完才知是否还存在 |
| `e21e8f0863` | 黏贴字符串 BUG | 复现 → 重打 |
| `d629482dc2` | TUI 粘贴后光标移动导致提交内容错乱（v2） | 复现 → 重打 |
| `e9e2e05835` | TUI 粘贴后继续输入导致提交内容错乱（v1，已被 v2 取代） | 跳过，直接看 v2 |
| `73f52b85d0` | 删除冗余文件 | 跳过 |
| `af2808f32c` | feat: 添加 claude-opus-4.7 到 github-copilot snapshot + Linux 构建脚本 | 模型快照在 plugin 重写时一并带 |

## P2 · 优化类（按需）

| commit | 主题 | 处置 |
|---|---|---|
| `711f6827f8` | mcp: 首次实例化并发限流默认 4 + experimental.mcp_concurrency + MCP.warm() | 阶段 6 之后视性能数据决定 |
| `18b0682be1` | plugin: INTERNAL_PLUGINS 工厂体推迟到首次 trigger | 同上 |
| `f37cae305c` | cli: 命令模块 lazy import，--version -52% 启动 | 同上 |
| `7220a67bd3` | server: SSE 16ms 帧批量化 | 同上 |
| `1253f4e051` | storage: SQLite close(TRUNCATE) + exit 清理闭环 | 同上 |
| `a9c5aa9e06` | tui: 启动路径 stderr 埋点诊断 macOS+tmux 黑屏 | 仅诊断，按需带入 |

## 回归验证策略

每条 P0 + 必要的 P1 在阶段 2 按以下流程：

1. **复现**：根据 commit message 找到原始失败场景（多数是启动 / chat 单 turn / auth login）；
2. **基线测**：在干净的 `reset/upstream-1.14.30` 上执行复现命令；
3. **二选一**：
   - 仍失败 → 取出 fork commit，**只 cherry-pick 相关 hunk**，避免带入无关改动；
   - 已修复（罕见）→ 在本文标记"上游已修"并跳过。
4. 每条修复一个独立 commit，message 引用 fork 原 commit hash 与新基线行为。

## 验证命令

```bash
# 基线 typecheck
cd packages/opencode && bun typecheck

# 基线测试
cd packages/opencode && bun test

# 启动复现：裸 opencode 进 TUI
opencode

# 启动复现：--help/--version 性能
time opencode --version

# auth login 链路
opencode auth login github-copilot
opencode auth login github-proxy

# Copilot chat 计费链路（依赖阶段 4 完成）
# 检查 proxy 后端日志，确认一次用户回车恰好对应 N+1 条 usage、按 turn 聚合为 1 条计费
```

## 写入 .memory/errors/ 触发条件

按 AGENTS.md 协议，每条 P0 修复完成后，在 `.memory/errors/{主题}-{YYYYMMDD}.md` 归档：
- 复现命令
- 失败现象
- 根因（指向具体上游文件 + 行号）
- 补丁要点（不贴完整 diff，只写关键设计决策）
