<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
-->

# 中文特性修复清单 / Chinese-Language Bug Fixes

This document tracks CJK / Chinese-language compatibility fixes applied to the opencode Enhanced Edition, on top of the upstream base.

本文件记录 opencode 增强版在上游基础之上针对 CJK / 中文使用场景的兼容性 DEBUG 记录。

> 💡 发现新的中文特性问题？请在 [issue 区](../../issues) 提交复现步骤，作者会持续 DEBUG。

---

## 修复分类

### 1. CJK Tokenization / 分词与计数

CJK 字符在某些 tokenizer 下的计数异常：上游版本在部分 prompt 长度估算函数中将 CJK 字符错误地计为 1 byte / 0.5 token。

**状态**：已 DEBUG，新增 CJK-aware 估算路径。回归测试：见 `packages/opencode/src/session/__tests__/prompt-token-cjk.test.ts`。

### 2. Fullwidth Punctuation in Config / 全角标点配置解析

配置文件中的全角冒号 `：`、全角引号 `""`、全角括号 `（）` 在某些 settings 解析器中会被当作非法字符导致整个配置块被丢弃（而非优雅降级）。

**状态**：已 DEBUG，settings 解析器对全角标点容错并自动归一化为半角等价物，同时保留原字符串以兼容用户意图。

### 3. Chinese Paths in Hooks and Sandbox / 中文路径

Hook command 和 sandbox 在传递包含空格 + CJK 字符的路径时，因 shell quoting 不完整导致 child-process spawn 找不到文件。

**状态**：已 DEBUG，所有 child 启动路径使用 `JSON.stringify`-style quote wrapper。回归测试覆盖。

### 4. IME Interaction in TUI / 输入法兼容

在 Windows / macOS 的 IME（中文输入法）候选窗激活时，TUI 出现：
- 候选字符插入延迟 ~150ms
- 光标在候选位置抖动
- 偶尔误提交候选字符

**状态**：上游已报告 issue，本分支本地有 workaround 补丁，待上游接受后移除。

### 5. Chinese Model Output / 中文模型输出截断

部分国产模型在长文本流式输出时，因 BOM 与 UTF-8 边界错位导致最后一个中文字符乱码。

**状态**：已在流式解析层增加 UTF-8 边界检测，避免截断。

---

## 回归测试

所有中文特性修复均配有回归测试，统一放在：

- `packages/opencode/src/session/__tests__/prompt-token-cjk.test.ts`
- `packages/opencode/src/hook/__tests__/chinese-paths.test.ts`
- `packages/opencode/src/settings/__tests__/fullwidth-punct.test.ts`

## 贡献

欢迎提交 PR 补充更多中文场景的 DEBUG。提交前请附：

1. 复现步骤（最小复现）
2. 修复代码
3. 回归测试用例
4. 影响评估（是否破坏英文场景）

---

**Last updated / 最后更新**: 2026-06-07
