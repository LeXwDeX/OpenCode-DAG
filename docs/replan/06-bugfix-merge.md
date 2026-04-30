# 06 — 必做 Bugfix 合并计划

> 分支：`replan/v1.14.30`
> 来源：dev 分支 fork-only commits，逐个适配到 upstream v1.14.30 基线
> 原则：每个 Fix 独立提交，提交后 typecheck 验证

---

## Fix-A：防止工具失败 / MCP 超时导致主进程退出

**来源 commit**：`0f3017f33a`（+29/-5，3 files）
**问题**：工具偶发失败 → Effect defect → stream 中断 → 进程退出

### A1：task.ts — 移除 Effect.orDie，子 agent 失败转为错误文本

**文件**：`packages/opencode/src/tool/task.ts`
**当前代码**（第 172-173 行）：
```ts
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
```

**改为**：
```ts
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(
          Effect.catch((e: unknown) =>
            Effect.succeed({
              title: params.description,
              metadata: {} as any,
              output: `Task failed: ${e instanceof Error ? e.message : String(e)}`,
            }),
          ),
        ),
```

**verify**：`bun typecheck` from `packages/opencode`

---

### A2：prompt.ts — MCP 工具 execute 从 Effect.promise 改为 Effect.tryPromise + 外层 catch

**文件**：`packages/opencode/src/session/prompt.ts`
**当前代码**（第 466-468 行）：
```ts
              const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.promise(() =>
                execute(args, opts),
              )
```

**改为**：
```ts
              const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.tryPromise({
                try: () => execute(args, opts),
                catch: (e) => new Error(`MCP tool "${key}" failed: ${e instanceof Error ? e.message : String(e)}`),
              })
```

**以及** 第 521-522 行，原始 `return output` 后 `}),` 闭合处加外层 catch：
```ts
              // 原始：
              return output
            }),
          )

              // 改为：
              return output
            }).pipe(
              Effect.catch((e: unknown) =>
                Effect.succeed({
                  title: "",
                  metadata: {} as Record<string, unknown>,
                  output: `MCP tool error: ${e instanceof Error ? e.message : String(e)}`,
                  content: [{ type: "text" as const, text: `MCP tool error: ${e instanceof Error ? e.message : String(e)}` }],
                }),
              ),
            ),
          )
```

**verify**：`bun typecheck` from `packages/opencode`

---

### A3：hook/settings.ts — EPIPE 监听 ⏸️ 推迟到 Phase 3

> hook/settings.ts 在 upstream 基线上不存在。此修复将在 Phase 3 Hook 系统实现时一并加入。

---

## Fix-B：Thinking 末尾字符导致 Anthropic 400 报错

**来源 commit**：`85a70a945d`（+60/-4，4 files）
**问题**：流式中断后 assistant 消息末尾剩 thinking block → Anthropic 拒绝 → 整个 session 废掉

### B1：transform.ts — 重排 assistant 消息末尾的 thinking/redacted_thinking block

**文件**：`packages/opencode/src/provider/transform.ts`
**插入位置**：第 93 行 `.filter(...)` 之后，第 94 行 `}` 之前

插入以下代码：
```ts
    // Anthropic 硬规定：assistant 消息的最后一个 content block 不能是 thinking / redacted_thinking。
    // 流式响应被中断（Esc 取消、网络断、超时）时，session 里可能只剩 reasoning 块，
    // 重放时会触发 400: "The final block in an assistant message cannot be 'thinking'."
    //
    // 策略：
    //   1. 若消息只有 reasoning → 追加一个空 text 兜底（保留 signature 链路）
    //   2. 若末尾有 reasoning 但前面有 text/tool-call/... → 把末尾的 reasoning 重排到非末尾位置
    //   3. 末尾已合法 → 不动
    msgs = msgs.map((msg) => {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg
      const parts = msg.content
      if (parts.length === 0) return msg

      let lastValidIdx = -1
      for (let i = parts.length - 1; i >= 0; i--) {
        const t = (parts[i] as { type: string }).type
        if (t !== "reasoning" && t !== "redacted_thinking") {
          lastValidIdx = i
          break
        }
      }

      if (lastValidIdx === -1) {
        return { ...msg, content: [...parts, { type: "text", text: " " } as (typeof parts)[number]] }
      }
      if (lastValidIdx === parts.length - 1) return msg
      const head = parts.slice(0, lastValidIdx)
      const anchor = parts[lastValidIdx]
      const trailing = parts.slice(lastValidIdx + 1)
      return { ...msg, content: [...head, ...trailing, anchor] }
    })
```

**verify**：`bun typecheck` from `packages/opencode`

---

### B2：bash.ts — reader fiber 超时中断防僵尸进程

**文件**：`packages/opencode/src/tool/bash.ts`

**改动 1** — 第 22 行 import 增加 `Fiber`：
```ts
// 原始：
import { Effect, Stream } from "effect"
// 改为：
import { Effect, Fiber, Stream } from "effect"
```

**改动 2** — 第 443 行 `yield* Effect.forkScoped(` 改为赋值：
```ts
// 原始：
          yield* Effect.forkScoped(
// 改为：
          const reader = yield* Effect.forkScoped(
```

**改动 3** — 第 514 行 `}` （timeout kill 块结尾）之后，`return exit.kind...` 之前插入：
```ts
          // When aborted/timed out, the child may leave grandchildren holding
          // the stdout pipe fd (e.g. detached background jobs, Popen without
          // close_fds). The merged output stream would then never EOF, and
          // Effect.scoped would block forever waiting for the reader fiber.
          // Give the reader a short grace window to drain, then force-interrupt.
          if (exit.kind !== "exit") {
            yield* Fiber.await(reader).pipe(
              Effect.timeout("2 seconds"),
              Effect.catch(() => Fiber.interrupt(reader)),
            )
          }
```

**verify**：`bun typecheck` from `packages/opencode`

---

## Fix-C：auth 路由冲突 + metadata 持久化丢失

**来源 commit**：`4b00e5996f`（+65/-19，3 files）
**问题**：providers.ts 的 `put()` 漏传 metadata → github-proxy 的 proxyUrl 被丢弃 → provider 完全失效

### C1：providers.ts — put() 透传 plugin authorize 返回的 metadata

**文件**：`packages/opencode/src/cli/cmd/providers.ts`

三处 `"key" in result` 分支的 `put()` 调用需要增加 metadata 透传。

**位置 1**（第 113-116 行，callback 分支）：
```ts
          // 原始：
          await put(saveProvider, {
            type: "api",
            key: result.key,
          })

          // 改为：
          await put(saveProvider, {
            type: "api",
            key: result.key,
            ...("metadata" in result && result.metadata ? { metadata: result.metadata as Record<string, string> } : {}),
          })
```

**位置 2**（第 145-148 行，code 分支）：
```ts
          // 原始：
          await put(saveProvider, {
            type: "api",
            key: result.key,
          })

          // 改为：
          await put(saveProvider, {
            type: "api",
            key: result.key,
            ...("metadata" in result && result.metadata ? { metadata: result.metadata as Record<string, string> } : {}),
          })
```

**位置 3**（第 172-174 行，api-authorize 分支）：
```ts
          // 原始：
          await put(saveProvider, {
            type: "api",
            key: result.key ?? key,
          })

          // 改为：
          await put(saveProvider, {
            type: "api",
            key: result.key ?? key,
            ...("metadata" in result && result.metadata ? { metadata: result.metadata as Record<string, string> } : {}),
          })
```

**verify**：`bun typecheck` from `packages/opencode`

---

### C2：providers.ts — plugin 已通过 prompts 收集字段时跳过通用 password 提示

**文件**：`packages/opencode/src/cli/cmd/providers.ts`
**当前代码**（第 159-164 行）：
```ts
  if (method.type === "api") {
    if (method.authorize) {
      const key = await prompts.password({
        message: "Enter your API key",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })
      if (prompts.isCancel(key)) throw new UI.CancelledError()
```

**改为**：
```ts
  if (method.type === "api") {
    if (method.authorize) {
      // Plugin prompts 已在上方收集了所需字段（如 apiKey）；
      // 仅当 plugin 未定义 prompts 时才回退到通用 password 提示。
      let key = ""
      if (!method.prompts?.length) {
        const entered = await prompts.password({
          message: "Enter your API key",
          validate: (x) => (x && x.length > 0 ? undefined : "Required"),
        })
        if (prompts.isCancel(entered)) throw new UI.CancelledError()
        key = entered
      }
```

**verify**：`bun typecheck` from `packages/opencode`

---

### C3：index.ts — auth 命令改名 ⏸️ 不适用

> upstream v1.14.30 的 index.ts 没有 `auth` 命令（也没有 `lazyCmd`），结构完全不同。
> 此改动不适用于当前基线。

### C4：quota-status.tsx — copilot 直连模式 ⏸️ 推迟到 Phase 5

> quota-status.tsx 是 fork-only 文件，在 upstream 基线上不存在。
> 此改动将在 Phase 5 TUI 配额状态栏功能实现时一并加入。

---

## 执行顺序

| 序号 | Fix | 文件 | 提交消息 |
|------|-----|------|----------|
| 1 | A1 + A2 | task.ts + prompt.ts | `修复：工具失败/MCP超时不再导致进程退出` |
| 2 | B1 + B2 | transform.ts + bash.ts | `修复：Thinking末尾block导致Anthropic 400` |
| 3 | C1 + C2 | providers.ts | `修复：auth metadata透传 + 跳过重复password` |

每步完成后执行 `bun typecheck`（在 `packages/opencode` 下）。
