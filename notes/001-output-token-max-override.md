# Output Token Limit: 硬编码天花板覆盖用户配置

## 现象

用户在 `opencode.json` 中设置 `limit.output = 65536`，期望模型输出上限为 65536 tokens，但实际发送的 `maxOutputTokens` 被无声截断为 32000。

## 根因

`packages/opencode/src/provider/transform.ts` 中存在隐式硬编码天花板 + 环境变量 escape hatch 的组合设计：

```typescript
// transform.ts:21
/** @deprecated Retained only for backward-compatible re-export from llm.ts; not used as a default. */
export const OUTPUT_TOKEN_MAX = 32_000  // ← 注释说 not used as default，但实际用作函数默认参数

// transform.ts:1352-1355
export function maxOutputTokens(model: Provider.Model, outputTokenMax = OUTPUT_TOKEN_MAX): number {
  if (outputTokenMax && outputTokenMax > 0) return Math.min(model.limit.output, outputTokenMax) || model.limit.output
  return model.limit.output
}
```

当环境变量未设时，`outputTokenMax` 参数为 `undefined` → 函数默认值 `32_000` 生效 → `Math.min(用户值, 32000)` 强制截断。

## 影响面

### 调用链路

```
opencode.json (limit.output)
  → provider.ts 合并到 model.limit.output（用户值优先 ✅）
  → request.ts:120 调用 maxOutputTokens(model, flags.outputTokenMax)
  → Math.min(model.limit.output, 32_000)  ← 无声截断 ⚠️
```

### 涉及文件

| 文件 | 行号 | 角色 |
|---|---|---|
| `src/provider/transform.ts` | 21 | `OUTPUT_TOKEN_MAX = 32_000` 硬编码常量 |
| `src/provider/transform.ts` | 1352-1355 | `maxOutputTokens()` 核心计算函数 |
| `src/session/llm/request.ts` | 120 | 请求准备时调用 `maxOutputTokens(model, flags.outputTokenMax)` |
| `src/session/overflow.ts` | 8, 14, 17, 24 | `usable()` / `isOverflow()` 中透传 `outputTokenMax` |
| `src/session/compaction.ts` | 248 | 传递 `outputTokenMax: flags.outputTokenMax` |
| `src/effect/runtime-flags.ts` | 52 | `outputTokenMax: positiveInteger("OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX")` |
| `packages/core/src/flag/flag.ts` | 68 | `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` 定义 |
| `src/session/llm.ts` | 32 | re-export `OUTPUT_TOKEN_MAX` |
| `test/effect/runtime-flags.test.ts` | 113, 285-305, 343 | `outputTokenMax` 相关测试 |

### Plugin 覆盖点（额外风险）

以下 plugin 会强制将 `maxOutputTokens` 清为 `undefined`，用户配置完全失效：
- `src/plugin/codex.ts:646` — OpenAI Codex 模式
- `src/plugin/github-copilot/copilot.ts:367` — GitHub Copilot GPT 模型
- `src/plugin/cloudflare.ts:73` — Cloudflare AI Gateway + OpenAI reasoning 模型

## 设计方案

### 设计意图

1. **忽略环境变量** — `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` 不方便配置，移除
2. **硬编码不做限制，从 schema 读取** — `model.limit.output` 来自 `models.dev` / `opencode.json` 用户配置，这是唯一驱动源
3. **128_000 仅作防越界上限，取 min** — `Math.min(model.limit.output, 128_000)` 防止用户/上游配置不合理导致 API 报错

### 目标函数签名

```typescript
export const OUTPUT_TOKEN_MAX = 128_000  // 防越界安全上限

export function maxOutputTokens(model: Provider.Model): number {
  return Math.min(model.limit.output, OUTPUT_TOKEN_MAX)
}
```

### 变更清单

| 文件 | 变更 |
|---|---|
| `src/provider/transform.ts:21` | `32_000` → `128_000`，注释改为"防越界安全上限" |
| `src/provider/transform.ts:1352-1355` | 移除第二参数，简化为 `Math.min(model.limit.output, OUTPUT_TOKEN_MAX)` |
| `src/session/llm/request.ts:120` | 移除 `input.flags.outputTokenMax` 参数 |
| `src/session/overflow.ts` | `usable()` / `isOverflow()` 签名移除 `outputTokenMax?`，调用移除第二参数 |
| `src/session/compaction.ts:248` | 移除 `outputTokenMax: flags.outputTokenMax,` |
| `src/effect/runtime-flags.ts:52` | 移除 `outputTokenMax` 字段 |
| `packages/core/src/flag/flag.ts:68` | 移除 `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` 定义 |
| `src/session/llm.ts:32` | 保留 re-export（值自动变为 128_000）|
| `test/effect/runtime-flags.test.ts` | 移除 `outputTokenMax` 相关测试（lines 113, 281-308, 343）|
