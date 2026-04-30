# GitHub Copilot 计费规则与 x-initiator 头一致性

**适用范围**：`packages/opencode/src/plugin/github-copilot/` 与 `packages/opencode/src/plugin/github-proxy/`（fork 出的 proxy 变体）

## 计费规则

GitHub Copilot 按「**用户发起的 prompt 提交次数**」扣，模型自发的工具调用、续聊、tool 返图等不扣。
opencode 通过 `x-initiator` HTTP header 告知上游归属：

- `x-initiator: user` → 计为一次用户 prompt → **扣次**
- `x-initiator: agent` → agent 自发请求 → **不扣**

## fork 易错点：proxy 变体的 isAgent 判定必须与原版同步

`github-proxy` 是 `github-copilot` 的中间层 fork（baseURL/auth 改写）。**两者的 isAgent 检测逻辑必须保持一致**，否则 proxy 用户会被多扣次。

历史曾出现 4 处 proxy 比 copilot 弱的 case（已修复，记录以防回归）：

### 1. fetch hook 三种 API 格式都要检测合成附件
工具返图时，opencode 注入一条 `role: "user"` 的合成消息携带 `MessageV2.SYNTHETIC_ATTACHMENT_PROMPT` 把图片喂回模型。
**必须靠 `imgMsg(last)` 区分**，单看 role 会误判：

```ts
// Completions / Responses / Messages 三种 API 末尾都要：
isAgent: ... || imgMsg(last)
```

`imgMsg()` 处理三种 content 形态：`string`、`[{type:"text"|"input_text", text: PROMPT}, ...]`。

### 2. chat.headers 的 compaction 检测要包含 compaction_continue
auto-compaction 续聊不是 `part.type === "compaction"`，而是一条 `text + synthetic + metadata.compaction_continue=true` 的合成 part：

```ts
parts?.data.parts?.some(
  (part) =>
    part.type === "compaction" ||
    (part.type === "text" && part.synthetic && part.metadata?.compaction_continue === true),
)
```

只检查 `compaction` 会漏掉续聊请求，每次 auto-compaction 多扣 1 次。

### 3. chat.params 必须为 anthropic 关闭 toolStreaming
不属于计费但属于兼容性：Copilot `/v1/messages` shim 拒绝 `@ai-sdk/anthropic` 注入的 GA 字段 `eager_input_streaming`，报 "Extra inputs are not permitted" → **Claude 经 proxy 直接不可用**：

```ts
if (incoming.model.api.npm === "@ai-sdk/anthropic") {
  output.options.toolStreaming = false
}
```

## 角色（system/user/assistant）兼容性结论

plugin 层**不修改消息体**，role 转换由 SDK 适配器（`@ai-sdk/github-copilot` / `@ai-sdk/anthropic`）完成。
plugin 只检查 last message 决定 header，因此 system 角色不会成为 last（在 Anthropic 是 top-level `system`，在 Responses 是 top-level `instructions`，在 Completions 是 messages[0]），无需特别处理。

## 验收命令

```bash
cd packages/opencode
bun test test/plugin/github-proxy/proxy.test.ts   # 覆盖三种 API 合成附件 + compaction_continue + toolStreaming
bun typecheck
```

## 不要同步的有意 fork 演化

- `proxy.ts:fix()` Claude fallback 路由到 anthropic（copilot 的 fix() 全部走 github-copilot，fallback 时 Claude 会丢 thinking signature）
- `proxy.ts:overrideProviderID()` 重打 `github-proxy` 标（因 `models.ts:build()` 硬编码 `github-copilot`）
- auth 类型（oauth refresh vs api key）、baseURL 拼装（`/copilot` 前缀）

历史上下文：见父仓 commit log 与 `.memory/patterns/opencode-plugin-fallback-signature-preservation-20260421.md`。
