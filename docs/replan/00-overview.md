# 重新规划：基于上游 OpenCode v1.14.30 重建 fork 模块

> 起草日期：2026-04-30
> 当前分支：`reset/upstream-1.14.30`
> 上游基线：`anomalyco/opencode` tag `v1.14.30`（2026-04-29 release）

## 1. 目标

1. 抛弃 fork 历史代码沉淀，从干净的上游 v1.14.30 基线重新组织 fork 特性。
2. **历史 BUG**：识别 fork 自有的 fix-only 提交，在新基线上验证哪些仍需复刻。
3. **Hook 系统**：在 OpenCode 内实现 Claude Code 协议兼容的 Hook 机制，使 CC hook 脚本零改动可用。
4. **Copilot 集成**：保留现有 github-copilot-proxy 代理模式，作为内置 plugin 重新落地。
5. **TUI 配额条**：在 opentui status bar 显示 Copilot premium request 剩余用量。

## 2. 当前基线现状

### 2.1 已完成
- ✅ 上游覆盖：HEAD = `eb42193043 release: v1.14.30`，已是上游官方 tag；
- ✅ Fork 关键素材保存：`.upstream-merge/reference/`（4 个模块 + README）；
- ✅ 上游缺陷文档化：见 `reference/README.md` 列出的 2 个 v1.14.30 仍在的 BUG；
- ✅ 计费铁律文档化：见 `.memory/architecture/opencode-chat-http-shape-20260430.md`。

### 2.2 与用户问题"覆盖"的对应关系
用户要求"重新拉取 OpenCode 源码覆盖"——**该动作实际已在 1aa8f7060c 完成**。
当前需要做的是把 `reset/upstream-1.14.30` 推进/合并为主开发分支，并在其上重新落地特性。

### 2.3 待落地工作
- ❌ Claude Code 风格 Hook 系统（上游不存在，需从零设计）
- ❌ github-copilot 内置 plugin（reference 有源码，需按当前 plugin/auth 接口重写）
- ❌ github-proxy 内置 plugin（同上）
- ❌ TUI 配额 feature-plugin（reference 有源码，需按当前 opentui Slot API 适配）
- ❌ auth.json metadata 持久化补丁（上游 BUG，每次重写都要带上）
- ❌ 25+ 条 fork-only fix 在新基线上的回归验证（清单见 01-bug-inventory.md）

## 3. 顺序决策（已与用户确认）

```
阶段 0 文档落地
   ↓
阶段 1 基线推进（reset/upstream-1.14.30 → dev 工作分支）
   ↓
阶段 2 BUG 回归（按 P0/P1 优先级，逐条复验是否仍存在）
   ↓
阶段 3 Hook 系统（独立模块，与 plugin 系统并存）
   ↓
阶段 4 Copilot Proxy（依赖阶段 2 的 auth 修复）
   ↓
阶段 5 TUI 配额条（依赖阶段 4 的 auth.json 形态）
   ↓
阶段 6 经验归档
```

## 4. 边界与约束

### 4.1 覆盖范围
- **只覆盖** `packages/opencode/` 核心；
- **不动** `.opencode/`、`.memory/`、`.codex_plan/`、`AGENTS.md`、`docs/`、根 README、`.upstream-merge/reference/`；
- 其他 packages（sdk/web/console/desktop/app）按需跟进上游，不主动改造。

### 4.2 实现纪律
- **手术式修改**：fork 特性优先以 plugin 形态落地，不修改上游核心文件；
- **可追溯性**：每条 fix 都对应一个已识别的 fork-only commit hash 或新发现的回归；
- **协议优先**：Hook 系统按 Claude Code 协议实现，不发明新格式；
- **计费铁律**：Copilot 一次回车 ≤ 1 次 upstream 请求，禁止隐式重试 / fanout / 静默 fallback。

### 4.3 上游策略
- 本 fork 与上游开发节奏断开，**不主动追踪**上游新提交；
- 仅当用户明确要求新特性 / 严重 BUG / 协议兼容性时才探查上游。

## 5. 文档结构

| 文档 | 内容 |
|---|---|
| `00-overview.md` | 本文件 |
| `01-bug-inventory.md` | 25+ 条 fork-only fix 清单 + 优先级 + 回归验证策略 |
| `02-hook-system.md` | Claude Code 兼容 Hook 设计（事件/schema/加载链/注入点） |
| `03-copilot-proxy.md` | github-copilot + github-proxy 双 plugin 重建方案 |
| `04-tui-quota-status.md` | TUI 配额 feature-plugin 设计 |
| `05-execution-order.md` | 阶段化推进计划与验收命令 |
