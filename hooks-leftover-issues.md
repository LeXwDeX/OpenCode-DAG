# Hooks 体系遗留问题（FABLE5 Review 发现）

> 来源：`hooks-dynamic-context-and-create-command` change 的 FABLE5 code review
> 日期：2026-07-03
> 状态：待决策

## 背景

`hooks-dynamic-context-and-create-command` change 实现完成后，FABLE5 模型做了一次 code review。Review 确认了核心实现正确，但标记了 3 个**前置提交遗留问题**（不属于该 change 的范围，来自 hooks 迁移系列 PR）。本文档汇总这 3 个问题供进一步研究。

---

## 问题 ①：内置 skill description 硬编码重复

### 现象

两个注册路径各硬编码了一份完全相同的长 description 字符串：

| 文件 | 位置 | 注册路径 |
|------|------|---------|
| `packages/core/src/plugin/skill.ts:36-37` | `Plugin.define` 内联 | V2 plugin system（`ctx.skill.transform`） |
| `packages/opencode/src/skill/index.ts:43-44` | `CONFIGURE_HOOKS_SKILL_DESCRIPTION` 常量 | Legacy Skill layer（直接写入 `state.skills`） |

涉及两个 skill：`configure-hooks` 和 `customize-opencode`，各有完全相同的重复。

### 细节

有趣的是 **skill body 已经通过 import 共享了**：

```ts
// opencode/src/skill/index.ts
import { SkillPlugin } from "@opencode-ai/core/plugin/skill"
const CONFIGURE_HOOKS_SKILL_BODY = SkillPlugin.ConfigureHooksContent  // ✅ 已共享
const CONFIGURE_HOOKS_SKILL_DESCRIPTION = "Use when the user wants to..."  // ❌ 硬编码副本
```

只有 description 是各写一份。`core/src/plugin/skill.ts` 已经导出了 body（`ConfigureHooksContent` / `CustomizeOpencodeContent`），但没有导出 description 常量。

### 风险

改了一边忘另一边 → 两条注册路径注册的 description 不一致 → agent 对同一个 skill 看到不同的触发条件描述。

### 待研究问题

1. 这两条注册路径（V2 plugin vs legacy Skill layer）是什么关系？是同一套 skill 注册两次（后者覆盖前者），还是两个独立系统并存？
2. 如果是重复注册，更根本的修法是消除重复注册；如果独立并存，共享常量就够。
3. 注册顺序：opencode 的 `state.skills[name] = ...` 在 `loadSkills()` 之前执行，注释写 "BEFORE disk discovery so a user-disk skill with the same name can override it"。V2 plugin 的注册时机是什么？

### 初步修法方向

`core/src/plugin/skill.ts` 导出 description 常量，`opencode/src/skill/index.ts` import 使用。约 10 行改动，2 个文件。

---

## 问题 ②：hot-reload mtime 检测遗漏 `m < prev` 场景

### 现象

`packages/opencode/src/hook/extensions/hot-reload.ts:144`：

```ts
if (m > prev || (prev > 0 && m === 0)) {
//   ^^^^^^^^                ^^^^^^^^^^
//   只检测 mtime 增大        检测删除（>0 → 0）
```

### 遗漏的场景

| 操作 | mtime 变化 | 当前检测 | 应该触发 reload？ |
|------|-----------|---------|------------------|
| 正常编辑（vim / echo >） | `100 → 200` | ✅ `m > prev` | 是 |
| 删除文件 | `200 → 0` | ✅ `prev>0 && m===0` | 是 |
| `cp -p` 从备份恢复（保留时间戳） | `200 → 100` | ❌ 漏了 | 是 |
| `touch -t` 设置旧时间 | `200 → 50` | ❌ 漏了 | 是 |

### 影响

极低频率。正常编辑工具（vim / echo / tee / sed -i）都增大 mtime。只有 `cp -p` 或 `touch -t` 显式保留/设置旧时间戳才会触发。但一旦触发，用户改了 hooks.json 却不生效，排查困难。

### 修法

`m > prev` → `m !== prev`。reload 是幂等的（重新 loadChain，结果相同就无副作用），多触发一次无代价。

```ts
// 修后
if (m !== prev) {  // 涵盖增大、减小、删除（>0→0 也是 !==）
```

注意：`prev > 0 && m === 0` 这条单独的删除检测可以合并进去（`m !== prev` 已覆盖），但保留也无害——只是冗余。

### 范围

1 行改动，1 个文件。太小不值得单独开 OpenSpec change。

---

## 问题 ③：系统提示词中 "Claude Code Hooks API" 段落描述过时的 hooks 体系

### 现象

当前 opencode session 的系统提示词中包含一个 `# Claude Code Hooks API` 段落，描述了**旧的 6 层 settings 链和 22 个事件**：

```
# Claude Code Hooks API

OpenCode is **fully compatible with the Claude Code hooks protocol**...

**Settings paths** (6-layer chain, merged in order):
1. `~/.claude/settings.json` (global)
2. `<project>/.claude/settings.json` (project)
3. `<project>/.claude/settings.local.json` (project-local)
4. `~/.config/opencode/settings.json` (global)
5. `<project>/.opencode/settings.json` (project)
6. `<project>/.opencode/settings.local.json` (project-local)

**22 actively triggered events**: PreToolUse, PostToolUse, PostToolUseFailure, FileChanged, ...
```

而当前实现已经是 **3 层 hooks.json 链 + 27 个事件**。这段文字与实现矛盾。

### 调查结果

| 搜索范围 | 结果 |
|---------|------|
| repo 内所有 `.ts` / `.txt` / `.md` / `.js` 文件 | ❌ 找不到 |
| `~/.config/opencode/` 全局配置 | ❌ 找不到 |
| `~/.config/opencode/docs/hooks-reference.md`（文中引用的文件） | ❌ 文件不存在 |
| git 全历史 `-S` 搜索 | 超时未完成 |
| `/usr/local/bin/opencode`（全局二进制）`strings` 搜索 | 未直接命中（Bun 编译可能压缩了 JS bundle） |

### 根因推断

当前 session 跑的是 `/usr/local/bin/opencode`（全局安装的**旧版编译二进制**），不是 `bun dev` 的源码。这段文字很可能在旧版源码中存在（hooks 迁移前），迁移时已从源码删除，但全局二进制还是旧的。

**一旦 hooks 迁移系列 PR 合入 main 并重新发版安装，此问题自动消失。**

### 验证方式

hooks 迁移合入 main 后，重新编译安装全局二进制（或 `bun install -g`），启动新 session 检查系统提示词是否还有这段过时文字。

### 待研究问题

1. 这段文字在旧版源码中的确切位置是什么？（git log 搜索超时，可以缩小搜索范围重试）
2. 它是硬编码在某个 `.ts` 文件里，还是从某个 `.md` / `.txt` 模板加载的？
3. 确认它已经从当前源码中删除（而非仍然存在只是我们搜错了关键词）。

---

## 汇总决策矩阵

| 问题 | 源码改动？ | 改动量 | 风险 | 建议 |
|------|-----------|--------|------|------|
| ① description 重复 | 是 | ~10 行 / 2 文件 | 极低 | 值得做：消除漂移风险 + 搞清注册路径关系 |
| ② m > prev 边界 | 是 | 1 行 | 极低 | 太小，搭便车修（放在 ① 的 change 里或下个 hooks PR） |
| ③ 系统提示词过时文字 | 否（部署问题） | 0 行 | 中（agent 拿到错误指引） | 重新发版安装即自动修复；可选：追查旧文字的确切来源以确认已删 |

---

## 建议

- **① + ② 合并为一个 change**：都是 skill/hook 注册体系的小修，scope 内聚。① 是主菜，② 是搭便车的一行修。
- **③ 不需要代码改动**：确认 hooks 迁移合入后重新安装即可。如果想在合入前彻底确认旧文字已从源码删除，可以缩窄 git log 搜索范围（限定 `--since` 日期或 `-- packages/` 路径）。
