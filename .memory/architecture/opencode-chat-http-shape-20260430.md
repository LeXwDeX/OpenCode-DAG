# opencode chat 执行的真实 HTTP 形态（v1.14.30 调研结论）

## 核心结论

**一次用户回车（一个 turn）= N+1 次独立 streaming HTTP 请求**，无论 Anthropic 还是 OpenAI 兼容协议。这是协议 + ai-sdk + opencode 三层共同决定的，**不可消除**。

| 层 | 限制 | 是否可绕过 |
|---|---|---|
| 协议层 | Anthropic /v1/messages 与 OpenAI /chat/completions 都是单向 SSE，client 无法在同一 stream 里回写 tool_result | 否（除非改用 OpenAI Responses API + server-side tools） |
| ai-sdk 层 | `streamText` 默认 `stopWhen: stepCountIs(1)`，每 step 一次独立 HTTP | 即使传 `stopWhen: stepCountIs(N)` 让 ai-sdk 内部多 step，每个 step 仍是独立 HTTP，HTTP 总数不变 |
| opencode 层 | `packages/opencode/src/session/prompt.ts:1370-1496` 自己写了外层 step 循环（默认 `agent.steps ?? Infinity`），未传 `stopWhen` 给 streamText | 改了反而失去 step 间的 compaction/insertReminders/permission/doom-loop 检查 |

## 关键代码路径

- chat 入口：`packages/opencode/src/session/prompt.ts` 的 `runLoop`（`for (let step = 1; ...; step++)`）
- streamText 调用：`packages/opencode/src/session/llm.ts:333-412`（唯一一处，未传 `stopWhen`/`prepareStep`）
- step 循环延续条件：`prompt.ts:1471` `finished = handle.message.finish && !["tool-calls","unknown"].includes(...)`，`tool-calls` finish → `return "continue"` → 外层 while 进下一步
- 现有 header 注入：`llm.ts:369-385` 已注入 `x-opencode-session` / `x-opencode-request`（自营 provider）和 `x-session-affinity` / `x-parent-session-id`（其他 provider）
- 已有 plugin hook：`chat.params` / `chat.headers` / `experimental.chat.messages.transform` / `experimental.chat.system.transform` 每个 step 重新构造请求时都触发

## 计费策略（Copilot Proxy plugin 必须落地）

**plugin 端**（`chat.headers` hook 追加）：
- `x-opencode-turn-id`：取 `lastUser.id`（user message id），同一回合恒定不变，天然 turn key
- `x-opencode-step`：当前 step 序号，调试用

**后端 proxy**：按 `(sessionID, turnID)` 把 N+1 条 usage 累加为 1 条计费记录。

## 不要做的事

- ❌ 不要尝试改 `llm.ts` 加 `stopWhen` 把 N+1 压成 1 —— HTTP 数不变，反而失去关键检查
- ❌ 不要依赖 ai-sdk 的 `experimental_telemetry` 做计费聚合（那是 OTel 链路追踪，无跨 step 聚合语义）
- ❌ 不要在 plugin 内做"看到 tool_call 就拒绝"之类硬扣 —— 会破坏 agent 能力

## 衍生事实

- ai v6.0.168 已废弃 `maxSteps`，改用 `stopWhen`
- opencode 没用 `stopWhen`/`prepareStep`，自己写外层循环
- `agent.steps` 配置在 `config/agent.ts:48,66,96`（旧名 `maxSteps` deprecated），默认 `Infinity`
- Schema 字段：`agent.steps`（每个 agent 单独配）

## 触发场景

任何讨论 "Copilot 计费"/"opencode HTTP 请求次数"/"tool call 是否独立请求"/"plugin 怎么聚合 usage" 时，先读这份。
