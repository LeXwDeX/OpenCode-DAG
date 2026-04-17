# 上游合并日志

本文件记录所有上游合并会话，每次合并后追加。

---

## Session 2026-04-17 — Debug (Safe Fix) Batch

**策略**: 安全 debug cherry-pick（只选不涉及 fork 保护文件的 fix 提交）
**范围**: `3729fd57..upstream/dev` (330 总提交)
**处理**: 49 个安全 fix 候选，1 个排除（依赖 shared package）

### 结果

| 状态 | 数量 |
|---|---|
| 成功应用 | 28 |
| 冲突解决后应用 | 1 (ae17b416b8 — providers.ts key fallback) |
| 跳过（冲突） | 21 |

### 成功应用的提交 (28)

- `8b9b9ad31e` fix: ensure images read by agent dont count against quota
- `113304a058` fix(snapshot): respect gitignore for previously tracked files
- `fa2c69f09c` fix(opencode): remove spurious scripts and randomField from package.json
- `264418c0cd` fix(snapshot): complete gitignore respect for previously tracked files
- `ae17b416b8` fix(cli): auth login now asks for api key in handlePluginAuth (**冲突已解决**)
- `0b4fe14b0a` fix: forgot to put alibaba case in last commit
- `cb1a50055c` fix(electron): wait until ready before showing the main window
- `c2403d0f15` fix(provider): guard reasoningSummary injection
- `a8f9f6b705` fix(acp): stop emitting user_message_chunk during session/prompt turn
- `9a5178e4ac` fix(cli): handlePluginAuth asks for api key only if authorize method exists
- `4626458175` fix(mcp): persist immediate oauth connections
- `a53fae1511` Fix diff line number contrast for built-in themes
- `2c36bf9490` fix(app): avoid bootstrap error popups during global sync init
- `1ca9804604` fix(desktop): start tauri shell commands from home directory
- `f44aa02e26` fix(desktop): chdir to homedir on macOS to fix ripgrep issues
- `66de7bef89` fix: add left padding to session title input
- `e24d104e94` fix: update prompt input submit handler
- `8d89c3417b` fix: prevent tooltip reopen on trigger click
- `a992d8b733` fix(snapshot): avoid ENAMETOOLONG and improve staging perf
- `5069cd9798` fix(ui): disable accordion items for binary files
- `348a84969d` fix: ensure tool_use is always followed by tool_result
- `a554fad232` fix(tui): Don't overwrite the agent that was specified on the command line
- `4ca809ef4e` fix(session): retry 5xx server errors even when isRetryable is unset
- `e2c0803962` Fix desktop download asset names for beta channel
- `8c0205a84a` fix: align stale bot message with actual 60-day threshold
- `6c3b28db64` fix: ensure that double pasting doesnt happen after tui perf commit was merged
- `5e650fd9e2` fix(opencode): drop max_tokens for OpenAI reasoning models on Cloudflare AI Gateway
- `9db40996cc` fix build script

### 跳过的提交 (21) — 原因：与 fork 重构后的代码结构冲突

provider/transform.ts 相关 (5): `c5deeee8c7` `2fe9d94470` `610c036ef1` `cb18f2ef40` `bf4c107829`
bootstrap/project 相关 (3): `ff60859e36` `4246368a88` `6d42f97644`
已删文件冲突 (5): `be3be32bf1` `305460b25f` `b28956f0db` `26af77cd1e` `dbe2ff52b2`
config 相关 (2): `672ee28635` `ef90b93205`
其他 (6): `5b60e51c9f` `3cf7c7536b` `d2ea6700aa` `9afbdc102c` `ae584332b3` `86c54c5acc`

### 构建验证

- `bun typecheck`：64 个错误（全在 `src/provider/sdk/copilot/` ai-sdk 类型不兼容，合并前基线一致，零回归）

---

## Session 2026-04-17 — Round 2: 逐条审查跳过的 21 个提交

**策略**: 逐条检查每个跳过的提交，能合则合，不能合则记录原因

### 结果

| 状态 | 数量 |
|---|---|
| 手动合并 | 4 |
| 确认跳过 | 17 |

### 手动合并的提交 (4)

- `d2ea6700aa` refactor: remove deprecated list tool（删除 `ls.ts` + 60 文件文档清理）
- `c5deeee8c7` fix(provider): azure store=true by default（手动应用到 `transform.ts` + 新增测试）
- `610c036ef1` fix(provider): gpt-5-mini uses low reasoning effort（手动应用到 `transform.ts`）
- `cb18f2ef40` fix(provider): azure default promptCacheKey（手动应用到 `transform.ts`）

### 确认跳过的提交 (17) — 逐条审查记录

| # | SHA | 原因 |
|---|-----|------|
| 1 | `5b60e51c9f` | fork 无 ripgrep worker 模式，改动无适用目标 |
| 2 | `ff60859e36` | fork 已用更简洁的 `Project.fromDirectory()` 直调 |
| 3 | `3cf7c7536b` | 涉及 fork 已删的 httpapi 文件 |
| 4 | `4246368a88` | fork 已有等效 `await Plugin.init()` |
| 5 | `be3be32bf1` | `observability.ts` 在 fork 中不存在 |
| 6 | `672ee28635` | `config.ts` 结构差异过大，无法局部 cherry-pick |
| 7 | `6d42f97644` | fork 已有等效实现 |
| 8 | `ef90b93205` | 依赖 shared package（fork 没有） |
| 9 | `305460b25f` | `sync.ts` 在 fork 中已删 |
| 10 | `b28956f0db` | `sync-event.ts` 在 fork 中不存在 |
| 11 | `9afbdc102c` | 测试 API 调用方式不兼容 |
| 12 | `bf4c107829` | `json-migration.ts` 已被 fork 重写 |
| 13 | `2fe9d94470` | 多文件已删/重写 |
| 14 | `26af77cd1e` | `installation/version.ts` 不存在 |
| 15 | `ae584332b3` | fork 已有此修改 |
| 16 | `86c54c5acc` | fork 已无 console.log |
| 17 | `dbe2ff52b2` | `cli/effect/runtime.ts` 不存在 |

### 修改的文件

- `packages/opencode/src/provider/transform.ts` — azure store、promptCacheKey、gpt-5-mini effort
- `packages/opencode/test/provider/transform.test.ts` — azure store 测试
- `packages/opencode/src/tool/ls.ts` — 已删除

### 总结

- **本次上游合并共成功合并 32 个提交**（28 批量 + 4 逐条手动）
- **typecheck**：64 错误（基线不变，零回归）
- **merge point 未更新**（仍为 `3729fd57`），因跳过了大量中间提交
- **建议下次采用整体 merge 策略**（`git merge upstream/dev`）以解决结构性差异
- 剩余 302 个上游提交（feature/ui/other 类别）待后续处理

---

## Session 2026-04-17 — Round 3: Fork 重建（Rebase on upstream/dev）

**策略**: 废弃断开历史的旧 fork，基于 upstream/dev 最新 HEAD 重建，仅保留 fork 专属功能

**原因**: 旧 fork 与上游 git 历史完全断开（unrelated histories），`git merge upstream/dev` 产生 823 个 add/add 冲突，cherry-pick 效率极低（330 提交中仅成功 32 个）。重建一劳永逸解决历史断开问题。

### 重建过程

1. 基于 `upstream/dev` (HEAD: `c026e25088`) 创建 `dev-rebased` 分支
2. 从旧 fork 备份 3 个核心文件 + 2 个接线文件
3. 适配上游 API 变更后重新应用
4. 验证所有 32 个 cherry-pick 的 fix 已包含在 upstream/dev 中（无需重新应用）
5. 替换 dev 分支

### Fork 专属文件（全部保留）

**新增文件：**
- `src/hook/settings.ts` — SettingsHook (PreToolUse/PostToolUse hook 系统)
- `src/plugin/github-proxy/proxy.ts` — GitHub Copilot 代理 provider
- `src/cli/cmd/tui/feature-plugins/github-proxy/quota-status.tsx` — 配额状态 TUI 插件

**修改文件：**
- `src/plugin/index.ts` — 注册 GithubProxyAuthPlugin 到 INTERNAL_PLUGINS
- `src/cli/cmd/tui/plugin/internal.ts` — 注册 GithubProxyQuota 到 INTERNAL_TUI_PLUGINS
- `src/session/prompt.ts` — 集成 SettingsHook 到内置工具和 MCP 工具执行路径

### 上游 API 适配

| 旧 fork 写法 | 新写法 | 原因 |
|---|---|---|
| `import { Log } from "@/util/log"` | `import * as Log from "@/util/log"` | 上游取消了 namespace export |
| `import { InstanceState } from "@/effect/instance-state"` | `import * as InstanceState from "@/effect/instance-state"` | 同上 |
| `Installation.VERSION` | `InstallationVersion` (from `@/installation/version`) | 上游拆分了 version 导出 |

### Typecheck 结果

- **fork 专属文件**：0 个错误 ✅
- **总错误数**：484 个（全部为上游预存错误：`@opencode-ai/shared/*` 模块缺失、Effect 类型推导等）
- **零回归**

### Merge point 更新

- **旧值**：`3729fd57068445104ea464a952d41798ed30ea20`
- **新值**：`c026e25088bcd8668fba7333f97be03b70971f30`（upstream/dev HEAD）
- **状态**：✅ 完全同步，后续可正常 `git merge upstream/dev`

---

