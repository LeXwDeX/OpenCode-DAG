# replan/v1.14.30-fork.1 发布说明

**发布日期**：2026-05-01
**上游基线**：opencode v1.14.30（commit `eb4219304`）
**Fork 分支**：`replan/v1.14.30`
**Tag**：`replan/v1.14.30-fork.1`

## 概述

本 fork 在官方 opencode v1.14.30 基线上重建关键能力，遵循 `docs/replan/` 三阶段规划：

- **Phase 1（bugfix-merge）**：从历史 fork 移植已验证的稳定性补丁；
- **Phase 2-3（hook 系统重建）**：1:1 兼容 Claude Code 的 8 类 hook 事件（fork 不实现 CC 的 `Notification`，权限提示走内部 bus）；
- **Phase 4（github-proxy + TUI quota）**：内网 Copilot 代理 provider + 配额状态栏。

## 关键变更（按提交时序）

### 稳定性补丁（Phase 1）

- `7790a4b94` **修复** MCP 调用超时与孤儿 `tool_use` 自愈：避免单个 MCP 工具卡死阻塞会话；自动配对游离的 `tool_use` 请求与 `tool_result` 响应。
- `1908fbf1d` **修复** `question` 工具校验失败时的报错可读性：`formatValidationError` 在 Effect Schema 校验失败时输出带路径、字段提示与正确示例的引导信息，模型可一次自纠。
- `5a63eaef7` **修复** 三项稳定性问题：会话进程崩溃恢复 / Anthropic thinking-block 触发 400 / `auth.metadata` 字段在序列化中丢失。

### Hook 系统（Phase 2-3）

- `30a5f7dbc` **功能** Phase 3-Step1：落地 Claude Code 兼容 hook 骨架（事件分发器、`SettingsHook.Service`、配置 schema）。
- `85609c5b9` **功能** Phase 3-Step2：完成 8 类事件 1:1 兼容 — `PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop` / `SubagentStop` / `PreCompact` / `SessionStart` / `SessionEnd`（fork 删除 CC 的 `Notification`，由 `Permission.Service` + 内部 bus 兜底）。
- `5bdf76454` **修复** `SettingsHook.Service` 在 `ToolRegistry` 与测试 `defaultLayer` 中的 Layer 注入缺口（避免 `R = SettingsHook.Service` 残留在公共 API 上）。
- `d3b2e1868` **测试** `prompt.test.ts` 接入 `SettingsHook.defaultLayer` 并完成 bug 收敛盘点。
- `b007682f0` **维护** 归档 hook 重建期间的架构决策与典型错误到 `.memory/`。

### github-proxy + TUI quota（Phase 4）

- `f32284cf8` **功能** Phase 4 落地：
  - 新增 `github-proxy` provider，支持通过内网代理转发到 GitHub Copilot；
  - Claude 系模型路由到 `@ai-sdk/anthropic /v1/messages`，其他模型走 `@ai-sdk/github-copilot /chat/completions`；
  - fetch 拦截器自动注入 `x-initiator`、`Copilot-Vision-Request`、`Authorization Bearer`；
  - `auth.json` 认证流支持 `proxyUrl + apiKey` 两步交互；
  - 内置 TUI 插件 `SessionQuota`：60s 轮询 `/copilot/quota` 或 `/copilot_internal/user`，渲染到 `session_prompt_right` 槽位；
  - `packages/plugin/src/index.ts` 的 `AuthHook.methods` `type:"api" authorize` 返回类型补 `metadata?: Record<string, string>` 字段。
- `3ca3791e2` **测试** 修复 Phase 4 基线测试 5 处环境/陈旧失败（registry 注入 + root chmod 跳过 + Effect Schema 期望串更新）。
- `649653ecf` **测试** 新增 `github-proxy` 单元测试 11 例，覆盖路由 / fetch 拦截 / authorize 全路径。

### 文档与素材

- `1aa8f7060` **维护** 保存 fork 关键素材到 `.upstream-merge/reference/`，便于后续上游对照。
- `72686899b` **文档** `docs/replan/` 三阶段重新规划。

## 验收基线

- `bun test` 全量：**2230 pass / 20 skip / 2 todo / 0 fail**（182 文件）
- `bun turbo typecheck`：**13 包全绿**
- 子仓 `replan/v1.14.30` HEAD：`649653ecf`
- 父仓 `main` HEAD：`4c55678f`

## 与上游 opencode 的差异说明

- 默认与官方 opencode 上游断开，不主动追踪、合并或 cherry-pick；
- 仅在用户明确要求新模型 / 严重 BUG / 协议兼容性排查时才进行只读上游探查；
- 项目特定 skill 全部位于 `.opencode/skills/`，不污染公共模板。

## 已知局限

- 9 个 hook 事件中目前只有 `UserPromptSubmit` 有独立的集成测试覆盖（`test/session/prompt.test.ts`），其余 8 个事件未来会逐步补齐独立单测；
- `SessionQuota` TUI 插件依赖 `auth.json` 中存在 `github-proxy` 或 `github-copilot` 凭据，未配置时静默不渲染。

## 升级建议

直接拉取 tag：

```bash
git fetch origin
git checkout replan/v1.14.30-fork.1
```

或在父仓库根目录拉取全部子项目快照：

```bash
git pull origin main
```

## Hook 协议补强（阶段 5）

- **SessionStart additionalContexts 真兑现**：hook 在 SessionStart 返回的 `additionalContext` 现在真正注入到首轮 user message（之前 silent drop），封装为 `<hook_additional_context>...</hook_additional_context>`。
- **continue=false 真短路**：hook 返回 `{continue: false}` 现在真正中断后续 hooks 链 + 4 个调用点消费（PreToolUse / PostToolUse / UserPromptSubmit / PreCompact）。
- **suppressOutput**：fork 默认不渲染 hook stdout 到 UI，schema 接受字段但运行时 no-op（兼容 CC 协议）。
- **Session-scoped hook 动态注入（fork 扩展）**：新 `SessionHooks` API 支持运行时添加 session-scoped hooks（`once:true` 自动清理）；`Stop` 事件在 sub-agent 上下文自动翻译为 `SubagentStop`（仅影响 session-hook 查找，上层 dispatcher 语义不变）。

阶段 5 全量回归：**2361 PASS / 0 回归**，净增 9 测试。

## Hook 协议鲁棒性（阶段 6）

- **`hasHookForEvent` O(1) 短路**：`trigger` 入口在 settings 链与 SessionHooks 都没有当前事件条目时跳过 envelope 构建 / matcher 拼接 / regex 匹配热路径，直接返回空 result。无 hook 配置时几乎零开销。
- **`allowUntrusted` schema 字段（接入点预留）**：Settings 接受 `allowUntrusted?: boolean`，trigger 内留 TODO 注释块锁定未来 workspace-trust 系统接入点（fork 当前无 trust 基础设施，仅 schema 兼容；trust gate 失败必须 silent allow，永不 throw/deny）。
- **plugin `__sourceDir` 缺失自动 silent allow**：command handler 在 `spawn` 前对 `entry.__sourceDir` 做 `existsSync` 预检；插件目录已被 GC（卸载 / repo 清理）时返回 `exitCode: 0` + 空 stdout，而非让 shell 把缺失脚本转成 exit 2 误判为 block。

阶段 6 全量回归：**2365 PASS / 0 回归**，净增 3 测试。

## Hook 协议 CC 兼容性总结（阶段 7 验证）

通过 CC 官方文档 verbatim 示例 e2e 验证（8/8 PASS），fork 是 CC hook 协议的**严格超集 + 2 项行为差异**：

**6 项严格超集**（CC 配置在 fork 全部通用，反向不一定）：
1. case-insensitive matcher：fork 用 `i` flag，CC 配置精确匹配仍命中
2. 6 层 settings：CC 三层（user / project / local）完全保留 + fork 追加 `.opencode/` 平行层，覆盖顺序不冲突
3. hasHookForEvent O(1) 短路：纯优化，外部不可观察
4. SessionHooks 动态注入：与 file 链平等 concat 不互斥，CC 仅有 file 链 fork 多了 session 链
5. `__sourceDir` GC 竞态保护：CC 无此字段所以路径走不到；fork command hook 的 plugin 目录被 GC 时 silent allow
6. continue=false 双层 break：fork 此前失效，现补齐 CC spec 协议

**1 项 schema-only**（向前兼容）：
- `allowUntrusted` 字段接受不会 fail-parse；运行时占位待 fork trust 系统接入（WP-6B TODO）

**2 项明确行为差异**（迁移注意）：
- **`suppressOutput` 默认翻转**：CC 默认 `false`（渲染 hook stdout 到 UI），fork 默认 `true`（不渲染）。SessionStart/UserPromptSubmit 直接通过 stdout 注入文本在 fork 不会自动渲染，应改用 `hookSpecificOutput.additionalContext`（fork 阶段 5 已实现真注入）
- **`Notification` event 显式不支持**：CC 通过 hook 推送 permission/idle 通知，fork 走 `Permission.Service` + 内部 bus，配置 `Notification` hook 在 fork 不生效

**e2e 验证基线**：hook 63 PASS / 全量 2365 PASS / typecheck PASS（仅 1 PRE-EXISTING truncation fail 与 hook 无关）
