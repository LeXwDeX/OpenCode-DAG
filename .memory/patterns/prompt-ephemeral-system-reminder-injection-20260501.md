# 模式：Prompt 层 ephemeral system-reminder 注入

**问题域**：长会话 + 多次 compaction 后，模型容易丢失 todo list 注意力，导致 plan drift。

**核心洞察**：
- `session/prompt.ts` 内的 `insertReminders` 在每一步 LLM 请求前被调用（loop step 内 1461 行附近），是「每次请求前运行一次」的天然 hook 点。
- 用 `synthetic: true` 的 part 推入最后一条 user message，**只影响本次请求的内存对象**，**不会被持久化到 session_message 表**（不污染历史，不被 compaction 算入压缩对象）。
- 现有 plan-mode 注入（PROMPT_PLAN / BUILD_SWITCH）已是这一模式的范例，新增 todo reminder 是同模式复用。

**实施关键点**：
1. **Agent.Info ≠ ConfigAgent.Info**：runtime 的 `Agent.Info`（`src/agent/agent.ts`）和 config 层的 `ConfigAgent.Info`（`src/config/agent.ts`）是两个独立 schema。新增字段必须**两边都加**，并在 config→runtime 映射处显式拷贝（`agent/agent.ts` 第 252-258 行附近的 `item.foo = value.foo ?? item.foo` 序列）。
2. **`Layer.suspend` 内 pipe 操作数上限 20**：当 SessionPrompt.defaultLayer 已接近上限时，新依赖必须合并到末尾的 `Layer.mergeAll(...)` 块，不能再追加独立 `Layer.provide()`。
3. **拆分 helper 比改写早 return 更简洁**：原 `insertReminders` 多个早 return，最干净的扩展方式不是改成 fall-through，而是把原逻辑整体抽成 `insertPlanReminders`（内部用 `return` 控制流），再串行调用 `insertTodoReminder`。

**纯函数化便于测试**：`renderTodoReminder(todos): string` 抽为 module 级 export 纯函数，单元测试覆盖排序、状态标记、未知状态容错、空数组短路等，避免 e2e harness（prompt.test.ts 1982 行）的高维护成本。

**风险与边界**：
- 注入是 ephemeral 的内存修改，**不能依赖** `userMessage.parts` 在持久化层看到 todo reminder（它不会出现在数据库或 SDK 历史里）。
- 默认开启的设计选择：todo 通常几十 token，开销可忽略；用户可通过 `agent.todo_reminder = false` 关闭，符合 fork「内置但可选」风格。
- 渲染顺序按 `in_progress > pending > completed > cancelled`，让活动项视觉优先。

**验证命令**：
```bash
cd packages/opencode
bun test test/session/todo-reminder.test.ts   # 6 case
bun test test/session/prompt.test.ts          # 不应回归（loop / insertReminders）
bun typecheck
```

**反例（不要这样做）**：
- ❌ 不要改用 SettingsHook 的 PreToolUse 通道注入 — 那是给外部用户写的子进程协议，每次工具调用 fork 子进程开销大，且需绕回 SDK 跨进程读 Todo。
- ❌ 不要在工具执行入口拦截注入 — 决策已经做完了，注入太晚。
- ❌ 不要 `sessions.updatePart()` 写入数据库 — todo reminder 必须 ephemeral，否则会被 compaction 当作历史压缩，定期失效。
