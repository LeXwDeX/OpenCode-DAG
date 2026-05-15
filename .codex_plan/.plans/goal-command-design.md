# `/goal` 持久化目标命令 — opencode 移植设计文档

> **状态**：定稿（可据此启动 WP-1）
> **源参考**：
> - hermes-agent 源码：`hermes_cli/goals.py`（722 行）+ `cli.py`（8154-8444）+ `gateway/run.py`
> - hermes-agent 官方文档：<https://hermes-agent.nousresearch.com/docs/zh-Hans/user-guide/features/goals>
>
> **目标平台**：opencode（TypeScript / Effect v4 / Drizzle / Bun）
> **目的**：把 Ralph-loop 风格的「跨轮持久目标 + 自动续跑 + 评判模型 + 预算保险丝」复刻进 opencode，作为内建 slash 命令 `/goal`（以及姊妹命令 `/subgoal`）。

---

## 目录

1. [概述与适用场景](#1-概述与适用场景)
2. [用户命令表](#2-用户命令表)
3. [核心控制循环（Ralph loop）](#3-核心控制循环ralph-loop)
4. [七条不变量](#4-七条不变量)
5. [opencode 基础设施映射](#5-opencode-基础设施映射)
6. [模块拆分与目录布局](#6-模块拆分与目录布局)
7. [数据契约](#7-数据契约)
8. [控制流详解](#8-控制流详解)
9. [用户可见文案](#9-用户可见文案)
10. [配置](#10-配置)
11. [典型使用示例](#11-典型使用示例)
12. [Judge 失误处理](#12-judge-失误处理)
13. [测试矩阵](#13-测试矩阵)
14. [工作包拆分](#14-工作包拆分)
15. [风险与开放问题](#15-风险与开放问题)
16. [迁移顺序](#16-迁移顺序)
17. [归属声明](#17-归属声明)

---

## 1. 概述与适用场景

`/goal` 赋予 opencode 一个**跨轮持久目标**：每轮结束后，一个轻量 judge 模型检查助手最后一条回复是否满足目标；若未满足，自动注入 continuation prompt 继续工作——直到目标达成、用户暂停/清除、或轮次预算耗尽。

这是 **Ralph loop** 模式的实现，直接受 [Codex CLI 0.128.0 `/goal`](https://github.com/openai/codex)（Eric Traut, OpenAI）启发。

### 适用场景

适合需要 agent 自主迭代、你不想每轮都说"继续"的任务：

- "修掉 `src/` 下所有 lint 错误，确认 `bun lint` 通过"
- "把 repo Y 的功能 X 移植过来，包含测试，让 CI 变绿"
- "调查 session ID 在压缩时偶尔漂移的原因，写一份报告"
- "写一个小 CLI 按 EXIF 日期重命名文件，然后在 photos/ 文件夹上跑通"

做一轮就停的任务不需要 `/goal`；**你本来要说三次"继续"的任务**才是它发光的地方。

---

## 2. 用户命令表

### `/goal` 命令

| 命令 | 功能 |
|---|---|
| `/goal <text>` | 设定持久目标，并立刻把 `<text>` 作为首轮 user message 发出，启动执行 |
| `/goal` 或 `/goal status` | 显示当前目标、状态、已用轮数 |
| `/goal pause` | 暂停自动续跑循环，保留目标状态 |
| `/goal resume` | 恢复循环，**重置轮次计数为 0**（语义：再给一段预算） |
| `/goal clear` | 彻底清除目标 |

### `/subgoal` 命令

| 命令 | 功能 |
|---|---|
| `/subgoal <text>` | 给当前 active 目标追加一条附加判定标准；下一轮 judge prompt + continuation prompt 都会带上 |
| `/subgoal` | 列出当前所有 subgoals |
| `/subgoal remove <n>` | 按 1-based 索引删除 |
| `/subgoal clear` | 清空全部 subgoals |

CLI / TUI / serve / ACP 各端行为一致。

---

## 3. 核心控制循环（Ralph loop）

每一**会话轮**结束后触发以下流程：

```
                ┌─────────────────────────────────────────────────┐
                │            session.idle 触发                      │
                └─────────┬───────────────────────────────────────┘
                          │
                    ┌─────▼─────┐
                    │ 有 active  │─── 否 ──→ 结束
                    │   goal?   │
                    └─────┬─────┘
                          │ 是
                    ┌─────▼─────┐
                    │ cause =   │─── abort ──→ 自动 pause("中断")
                    │  abort?   │
                    └─────┬─────┘
                          │ 否
                    ┌─────▼──────────┐
                    │ 取 assistant   │─── 空 ──→ 跳过本轮（防抖）
                    │ 最后回复文本    │
                    └─────┬──────────┘
                          │ 非空
                    ┌─────▼─────────────┐
                    │ 调用 Judge 模型    │
                    │ (goal + response   │
                    │  + subgoals)       │
                    └─────┬─────────────┘
                          │
                ┌─────────▼──────────┐
                │ verdict = done?    │─── 是 ──→ ✓ 目标达成 → 结束
                └─────────┬──────────┘
                          │ 否
                ┌─────────▼──────────────┐
                │ 连续解析失败 ≥ 3?       │─── 是 ──→ ⏸ pause + judge 诊断提示
                └─────────┬──────────────┘
                          │ 否
                ┌─────────▼──────────────┐
                │ turns_used ≥ max_turns? │─── 是 ──→ ⏸ pause + 预算提示
                └─────────┬──────────────┘
                          │ 否
                ┌─────────▼──────────────┐
                │ 用户是否已插入新消息?    │─── 是 ──→ 放弃入队（用户抢占）
                └─────────┬──────────────┘
                          │ 否
                ┌─────────▼──────────────┐
                │ 注入 continuation      │
                │ prompt 到 session      │
                └────────────────────────┘
```

### Judge 调用细节

- **System prompt**：严格 JSON 输出契约 `{"done": <bool>, "reason": "<一句话理由>"}`
- **DONE 三大充分条件**：① 回复明确确认完成 ② 交付物显然已产出 ③ 目标不可达/受阻（视为 DONE，避免烧预算）
- **User prompt**：goal 文本 + (可选) subgoals 编号列表 + 截断到 4 KB 的最近 response
- **参数**：`temperature=0`, `max_tokens=200`, `timeout=30s`

### Fail-open 语义

judge 出错时**永远不阻塞主循环**，verdict 默认为 `continue`：

| 错误类型 | verdict | 计入 parse_failures? |
|---|---|---|
| 网络 / transport 错误 | `continue` | ❌（瞬态错误） |
| 空响应 / 非 JSON / 解析失败 | `continue` | ✅ |
| 连续 ≥3 次 parse failure | 自动 pause | — |

**Turn budget（默认 20）才是真正的保险丝**，不是 judge。

### Continuation Prompt 模板

```
[Continuing toward your standing goal]
Goal: {goal}

Continue working toward this goal. Take the next concrete step.
If you believe the goal is complete, state so explicitly and stop.
If you are blocked and need input from the user, say so clearly and stop.
```

如果存在 subgoals，使用扩展模板：

```
[Continuing toward your standing goal]
Goal: {goal}

Additional criteria the user added mid-loop:
1. {subgoal_1}
2. {subgoal_2}
...

Continue working toward this goal. Take the next concrete step.
If you believe the goal is complete, state so explicitly and stop.
If you are blocked and need input from the user, say so clearly and stop.
```

扩展模板的 judge 版本要求**逐条给出 subgoal 完成的具体证据**，拒绝"all requirements met"式空话。

---

## 4. 七条不变量

从 hermes 源码和官方文档提取，opencode 实现必须逐条对齐。

| # | 不变量 | 原因 | opencode 映射 |
|---|---|---|---|
| **I1** | Continuation prompt 是**普通 user-role 消息**，不动 system prompt、不换 toolset | 保护 prompt cache 命中率 | `Session.prompt(input)` 默认行为即满足 |
| **I2** | Judge 出错 → fail-open 为 `continue` | judge 不能阻塞主循环；turn budget 是真正的保险丝 | `Effect.catchAll` 兜底 |
| **I3** | 真实用户消息**永远抢占** continuation | 用户输入插队 | idle → judge 之间检查 `SessionStatus`；busy 则放弃入队 |
| **I4** | 状态持久化在会话存储里，按 `goal:<sessionID>` 寻址 | `/resume` 重开后能继续 | Drizzle `goal_state` 表，`session_id` PK |
| **I5** | 运行中只允许 status/pause/clear；新 goal 必须先 `/stop` | 避免新旧 continuation 竞态 | 命令派发处检查 `SessionStatus.busy` |
| **I6** | 用户中断（Ctrl+C）→ 自动 pause，**不评判**部分输出 | 中断必须可观察、可恢复 | `session.idle` 事件增加 `cause` 字段；`abort` → pause |
| **I7** | Pause/clear 时必须**清掉**已排队的 continuation | 用户体验：pause 立刻生效 | opencode 不走队列（直接 `prompt`），I7 天然成立；但需取消正在跑的 judge fiber |

---

## 5. opencode 基础设施映射

### 5.1 可复用既有件

| opencode 既有件 | 复用方式 |
|---|---|
| `src/command/index.ts` `Info` Schema + `Service.list/get` | `/goal` / `/subgoal` 注册为 `Default.GOAL` / `Default.SUBGOAL`；命中后走特殊分支而非 template 渲染 |
| `src/session/status.ts` `Event.Idle`（`session.idle`） | **后轮 hook**：订阅此事件 → 跑 judge → 决定是否 enqueue continuation。所有前端（TUI / serve / ACP）共用一个 bus |
| `src/session/session.ts` + `prompt.ts` | Continuation prompt 通过 `Session.prompt(input)` 投入（满足 I1） |
| `src/bus` | 发布 `goal.*` 事件，TUI 订阅后渲染顶栏徽标 |
| `src/effect/instance-state.ts` | `GoalManager` per-instance（每个 project 各自一份） |
| `src/storage` + Drizzle `*.sql.ts` | 持久化 `goal_state` 表 |
| `src/config/config.ts` | 新增 `goals.maxTurns`、`auxiliary.goalJudge` 配置项 |
| `src/provider` | Judge 模型调用走 `Provider.Service.chatCompletion` |

### 5.2 关键适配点

#### ① 用户抢占（无 `_pending_input` 队列）

hermes 用 `_pending_input` 队列 + peek 实现抢占；opencode 没有此队列。

**适配方案**：在 `session.idle` 触发到 `Session.prompt` 之间，加 per-session `SynchronizedRef` 互斥锁，保证 judge → enqueue 是原子段。若互斥段内发现 `SessionStatus` 已变为 `busy`（用户插入了消息），直接放弃入队。

#### ② 辅助模型路由（新增 Auxiliary 服务）

opencode 目前没有「auxiliary task → model」命名映射。

**适配方案**：新增 `src/auxiliary/auxiliary.ts` 极小服务，对外暴露 `getClient(taskName: "goal_judge"): Effect<{ provider, model }>`。从 `config.auxiliary` 解析路由，fallback 到当前主 model。真正调用走 `Provider.Service.chatCompletion`。

#### ③ 中断识别（`session.idle` cause 字段）

opencode 当前 `Event.Idle` 没有 cause 字段。

**适配方案**：给 `status.ts` 的 Idle 事件增加 `cause?: "complete" | "abort" | "error"`（非破坏性扩展，旧订阅者忽略即可）。abort 路径从 `prompt.ts` 的取消 token 推导。

#### ④ Judge fiber 清理

`/goal pause` 和 `/goal clear` 时，如果 judge 正在运行，需要取消该 fiber（`Effect.interrupt`），避免 judge 完成后又推一次 continuation。

#### ⑤ 多端一致性优势

hermes 在 CLI + gateway 两条路径各写一遍循环逻辑。opencode 的 bus 架构天然支持多端——命令注册一次（`Command.Service`），事件一次（`Bus`），所有前端订阅渲染。

---

## 6. 模块拆分与目录布局

按 AGENTS.md 的「multi-sibling no-barrel」+「self-reexport」+「snake_case schema」规范：

```
src/goal/
  goal.ts            # GoalManager Service / Layer / defaultLayer
                     # export * as Goal from "./goal"
  state.ts           # GoalState Schema.Class + 类型
                     # export * as GoalState from "./state"
  goal.sql.ts        # Drizzle 表定义
  judge.ts           # judge_goal Effect.fn — 调 Auxiliary，prompt 模板，解析
                     # export * as GoalJudge from "./judge"
  events.ts          # Bus 事件定义
                     # export * as GoalEvent from "./events"
  prompts.ts         # 常量：CONTINUATION_PROMPT_TEMPLATE / JUDGE_SYSTEM_PROMPT 等

src/auxiliary/
  auxiliary.ts       # taskName → { provider, model }，config 解析 + fallback main
                     # export * as Auxiliary from "./auxiliary"

src/config/
  goals.ts           # ConfigGoals 子模块
                     # export * as ConfigGoals from "./goals"

src/command/
  index.ts           # Default 加 GOAL / SUBGOAL
```

---

## 7. 数据契约

### 7.1 GoalState Schema

```ts
// src/goal/state.ts
export class GoalState extends Schema.Class<GoalState>("GoalState")({
  goal: Schema.String,
  status: Schema.Literal("active", "paused", "done", "cleared"),
  turns_used: NonNegativeInt,
  max_turns: NonNegativeInt,
  created_at: Schema.Number,
  last_turn_at: Schema.Number,
  last_verdict: Schema.optional(Schema.Literal("done", "continue", "skipped")),
  last_reason: Schema.optional(Schema.String),
  paused_reason: Schema.optional(Schema.String),
  consecutive_parse_failures: NonNegativeInt,
  subgoals: Schema.Array(Schema.String),
}) {}
```

**向后兼容**：`from_json` 对缺少 `subgoals` 字段的旧 payload 默认 `[]`。

### 7.2 Drizzle 表

```ts
// src/goal/goal.sql.ts
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

export const goal_state = sqliteTable(
  "goal_state",
  {
    session_id: text().primaryKey(),
    payload: text().notNull(),        // JSON-encoded GoalState
    updated_at: integer().notNull(),
  },
  (t) => [index("goal_state_updated_at_idx").on(t.updated_at)],
)
```

迁移：`bun run db generate --name goal_state` → `migration/<ts>_goal_state/`。

### 7.3 Bus 事件

| event 名 | payload |
|---|---|
| `goal.set` | `{ sessionID, goal, maxTurns }` |
| `goal.updated` | `{ sessionID, state: GoalState }` |
| `goal.continued` | `{ sessionID, turnsUsed, maxTurns, reason }` |
| `goal.achieved` | `{ sessionID, reason }` |
| `goal.paused` | `{ sessionID, reason }` |
| `goal.cleared` | `{ sessionID }` |

---

## 8. 控制流详解

### 8.1 `/goal <text>` 派发

```
Command.handle("goal", args, ctx)
  └─ SessionStatus.get(ctx.sessionID)
       ├─ busy 且 args 是新 goal text → 拒绝："请先 /stop 再设定新目标"（I5）
       └─ idle 或控制子命令 → Goal.Service.dispatch(ctx.sessionID, args)
            ├─ "" | "status"     → 返回状态行 + publish goal.updated
            ├─ "pause"           → Goal.pause(reason="user-paused") + 取消 judge fiber
            ├─ "resume"          → Goal.resume()（turns_used := 0）
            ├─ "clear|stop|done" → Goal.clear() + 取消 judge fiber
            └─ <free text>       → Goal.set(text) → 立刻 Session.prompt({ text })
```

### 8.2 后轮 hook（Ralph 循环主体）

```
Bus.subscribe("session.idle"):
  on { sessionID, cause } => Goal.afterIdle(sessionID, cause)

Goal.afterIdle = SynchronizedRef.updateEffect(lock, () => {
  state = yield* GoalManager.load(sessionID)
  if !state || state.status != "active": return

  // I6：中断 → pause
  if cause == "abort":
    yield* state.pause("用户中断 (Ctrl+C)")
    yield* Bus.publish(goal.paused)
    return

  lastResponse = yield* Session.lastAssistantText(sessionID)
  if !lastResponse.trim(): return                               // 防抖

  // 调用 Judge
  { verdict, reason, parseFailed } = yield* GoalJudge.run(
    state.goal, lastResponse, state.subgoals
  )

  state.turns_used++
  state.last_turn_at = Date.now()
  state.last_verdict = verdict
  state.last_reason = reason
  state.consecutive_parse_failures = parseFailed
    ? state.consecutive_parse_failures + 1
    : 0

  // 三条终止规则（按优先级）
  if verdict == "done":
    state.status = "done"; save; publish goal.achieved; return

  if state.consecutive_parse_failures >= 3:
    state.pause("judge 模型未返回有效 JSON"); save; publish goal.paused; return

  if state.turns_used >= state.max_turns:
    state.pause("轮次预算耗尽"); save; publish goal.paused; return

  // 继续
  yield* Bus.publish(goal.continued)
  yield* save(state)

  // I3：抢占检查
  if (yield* SessionStatus.get(sessionID)).type != "idle": return

  yield* Session.prompt({ sessionID, text: renderContinuation(state) })
})
```

### 8.3 Judge 实现要点

```ts
// src/goal/judge.ts
export const run = Effect.fn("Goal.Judge.run")(function* (
  goal: string,
  response: string,
  subgoals: ReadonlyArray<string>,
) {
  const aux = yield* Auxiliary.Service
  const { provider, model } = yield* aux.getClient("goal_judge")
  const messages = buildMessages(goal, response, subgoals)

  // fail-open：transport 错误不计 parseFailed
  const raw = yield* provider.chatCompletion({
    model,
    messages,
    temperature: 0,
    maxTokens: 200,
    timeout: 30_000,
  }).pipe(
    Effect.catchAll(() =>
      Effect.succeed({ verdict: "continue", reason: "judge transport error", parseFailed: false })
    ),
  )

  return parseJudgeResponse(raw.text)  // 两步策略：JSON.parse 整段 → 正则 {.*?}
})
```

`parseJudgeResponse` 完整移植 hermes 的两步解析：

1. 去掉 Markdown 围栏（` ```json ... ``` `）
2. `JSON.parse` 整段
3. 失败 → 正则提取首个 `{...}` JSON 对象
4. 仍失败 → `{ verdict: "continue", reason: "无法解析 judge 输出", parseFailed: true }`

---

## 9. 用户可见文案

| 触发 | 文案 |
|---|---|
| 设定目标 | `⊙ 目标已设定（{maxTurns} 轮预算）：{goal}` |
| 状态（active） | `⊙ 目标（进行中，{n}/{N} 轮[，{K} 个子目标]）：{goal}` |
| 状态（paused） | `⏸ 目标（已暂停，{n}/{N} 轮[ — {reason}]）：{goal}` |
| 状态（done） | `✓ 目标已完成（{n}/{N} 轮）：{goal}` |
| 继续 | `↻ 继续推进目标（{n}/{N}）：{reason}` |
| 达成 | `✓ 目标已达成：{reason}` |
| 预算暂停 | `⏸ 目标已暂停 — 已用 {n}/{N} 轮。使用 /goal resume 继续，或 /goal clear 停止。` |
| Judge 异常暂停 | `⏸ 目标已暂停 — judge 模型未返回有效 JSON 判定。请配置 auxiliary.goalJudge 指向更可靠的模型，然后 /goal resume。` |
| 中断暂停 | `⏸ 目标已暂停 — 当前轮被中断。/goal resume 继续。` |

---

## 10. 配置

### opencode.json / config.yaml

```yaml
goals:
  max_turns: 20           # 每段循环最大续跑轮数（默认 20）

auxiliary:
  goal_judge:             # judge 模型路由（默认 fallback 到主 model）
    provider: openrouter
    model: google/gemini-3-flash-preview
```

### ConfigGoals Schema

```ts
// src/config/goals.ts
export const ConfigGoals = Schema.Struct({
  maxTurns: Schema.optional(NonNegativeInt),    // default 20
})

export * as ConfigGoals from "./goals"
```

Judge 调用很小（~200 output tokens / 轮），选便宜快模型通常是正确选择。

---

## 11. 典型使用示例

```
You: /goal 创建四个文件 /tmp/note_{1..4}.txt，每轮创建一个，内容为其编号

  ⊙ 目标已设定（20 轮预算）：创建四个文件 /tmp/note_{1..4}.txt，每轮创建一个，内容为其编号

Agent: 现在创建 /tmp/note_1.txt。
  💻 echo "1" > /tmp/note_1.txt   (0.1s)
  已创建 /tmp/note_1.txt，内容为"1"。下一轮继续。

  ↻ 继续推进目标（1/20）：4 个文件中仅创建了 1 个，还剩 3 个。

Agent: [继续推进你的持久目标]
  💻 echo "2" > /tmp/note_2.txt   (0.1s)
  已创建 /tmp/note_2.txt。还剩两个。

  ↻ 继续推进目标（2/20）：已创建 2/4 个，还剩 2 个。

Agent: [继续推进你的持久目标]
  💻 echo "3" > /tmp/note_3.txt   (0.1s)
  已创建 /tmp/note_3.txt。

  ↻ 继续推进目标（3/20）：已创建 3/4 个，还剩 1 个。

Agent: [继续推进你的持久目标]
  💻 echo "4" > /tmp/note_4.txt   (0.1s)
  四个文件全部创建完成：/tmp/note_1.txt 到 /tmp/note_4.txt。

  ✓ 目标已达成：四个文件已按要求创建，内容正确。

You: _
```

四轮执行，一条 `/goal`，零次"继续"提示。

---

## 12. Judge 失误处理

没有 judge 是完美的。两种失误模式：

**假阴性 — judge 说 continue 但目标实际已完成。** Turn budget 兜底。你会看到 `⏸ 目标已暂停`，可以 `/goal clear` 或直接发新消息。

**假阳性 — judge 说 done 但工作未完。** 你会看到 `✓ 目标已达成` 但你知道还没完。发一条后续消息继续，或重新设定更精确的目标：`/goal <更具体的文本>`。

judge 的 system prompt 刻意偏保守——**假阳性比假阴性更少见**。如果你觉得判定不合理，`↻ 继续推进目标` 或 `✓ 目标已达成` 行里的 reason 文本会告诉你 judge 看到了什么。通常足以判断是目标文本含糊还是模型回复有误。

---

## 13. 测试矩阵

| 测试文件 | 覆盖点 |
|---|---|
| `test/goal/state.test.ts` | Schema 序列化 / 反序列化 / 旧 payload 兼容（缺少 `subgoals` 字段 → 默认 `[]`） |
| `test/goal/judge.test.ts` | DONE / CONTINUE / 空响应 / 非 JSON / Markdown 围栏 / API 异常 fail-open / parseFailed 标记 |
| `test/goal/loop.test.ts` | 完整 idle hook → judge → enqueue 链路；预算耗尽 pause；连续 3 次 parse fail pause；中断 pause |
| `test/goal/preempt.test.ts` | 用户在 idle → judge 之间 prompt → continuation 不入队（I3） |
| `test/goal/midrun.test.ts` | busy 期间 `/goal status` 允许；`/goal <new>` 拒绝（I5） |
| `test/goal/subgoal.test.ts` | add / remove / clear / 与 judge prompt 集成 |
| `test/goal/persistence.test.ts` | 写入 → 进程重启 → load 还原（I4） |

**测试规范**：在 `packages/opencode/` 下运行（不在 repo root）；不 mock 真实 LLM，judge 客户端用 fake provider 注入。

---

## 14. 工作包拆分

按可独立 PR 的颗粒度拆分，每个 WP 完成后必跑 `bun typecheck`（在 `packages/opencode` 下）。

| WP | 范围 | 验收标准 |
|---|---|---|
| **WP-1** | `src/goal/state.ts` + `goal.sql.ts` + 迁移 + 序列化测试 | 单元测试通过；`bun run db generate` 干净 |
| **WP-2** | `src/auxiliary/auxiliary.ts`（taskName → provider/model，fallback main） | 单元测试 + provider mock 通过 |
| **WP-3** | `src/goal/judge.ts` + `prompts.ts`（两套模板） | judge 单测全过（含 markdown 围栏 / 非 JSON / API 错） |
| **WP-4** | `src/goal/goal.ts` GoalManager + `events.ts` + 持久化 | 状态机单测 + 抢占测试通过 |
| **WP-5** | `session.idle` 订阅 + per-session 互斥 + abort cause 字段 | loop 集成测试 + 中断测试通过 |
| **WP-6** | `Command` 注册 goal / subgoal + busy 路由限制 + 文案 | 命令分发测试 + 文案 snapshot |
| **WP-7** | TUI 顶栏徽标订阅 `goal.*` 事件 | 手动 e2e + 截图 |
| **WP-8** | 用户文档 `docs/reference/goal.md` + AGENTS.md 微调 | 文档 lint |

---

## 15. 风险与开放问题

| # | 问题 | 状态 | 建议 |
|---|---|---|---|
| R1 | `session.idle` 是否在 abort / error 路径也会触发？ | **待验证**（5 min grep） | 若不触发，需订阅额外终止态或扩展 Idle 事件 cause 字段 |
| R2 | Auxiliary 服务层级：新增一层 vs 直接用 Provider | **设计决策** | 建议 Auxiliary 仅做薄 config 解析器，调用走 `Provider.Service.chatCompletion` |
| R3 | Prompt cache 影响：`Session.prompt(input)` 是否触发 system 重渲染 | **待验证** | 检查 `compaction.ts` 长会话行为；理论上不会但需确认 |
| R4 | 多端体验差异 | **低风险** | 命令 + 事件架构天然多端一致；TUI 徽标渲染需单独 WP |

---

## 16. 迁移顺序

```
WP-1  GoalState + 持久化打底
  │
  ├─ WP-2  Auxiliary 辅助模型路由（可并行）
  │
  └─ WP-3  Judge + Prompt 模板（可并行）
       │
       WP-4  GoalManager 状态机 + 事件
         │
         WP-5  session.idle 接入闭环
           │
           WP-6  命令注册 + 文案
             │
             ├─ WP-7  TUI 徽标（可并行）
             └─ WP-8  文档（可并行）
```

每步对照 §4 七条不变量逐项打勾。

---

## 16.5 P2 实现差异澄清（与设计正文的扩展）

实现过程中沉淀的 4 项行为细节，未影响七条不变量但与正文略有出入；以本节为准。

### P2-1 `/goal` 控制子命令的 stop / done 别名

正文 §2 仅列 `clear`。实现为更贴近用户直觉，把 `stop` 与 `done` 作为 `clear` 的别名（`goal/goal.ts` dispatch L395）。三者语义一致：删除 GoalState 行 + publish `goal.cleared`，TUI 徽标随即消失。`done` 不会触发 `goal.achieved`（成就事件仅由 judge `verdict=done` 路径发出）；用户主动 `done` 表达"我手动收尾"，事件语义按 cleared 走更准确。

### P2-2 `/subgoal` 默认 add 语义

正文 §2 表格写 `/subgoal <text>` 为追加。实现支持两种等价写法（`goal/goal.ts` dispatchSubgoal L449-464）：

- `/subgoal add <text>` — 显式 add 关键字
- `/subgoal <text>` — 裸文本，自动按 add 处理（前提：text 不是 `list` / `clear` / `remove N` / `rm N` 这些保留词）

保留词不会被误解析为子目标文本——若用户真想加一个名为 "list" 的子目标，必须 `/subgoal add list`。

### P2-3 `/goal resume` 重置语义

正文 §2 仅说"重置轮次计数为 0"。实际实现额外重置 `consecutive_parse_failures` 为 0（`goal/goal.ts` resume L132-138）。理由：当 judge 模型连续 ≥ 3 次返回非 JSON 触发 paused 时，用户若已切换更可靠的辅助模型并 `/goal resume`，旧的解析失败计数不应继续累加，否则恢复后立刻又会被卡住。重置 parse_failures 让 resume 在 judge 故障场景下真正"清白重启"。

`paused_reason` 也会清空（同 L137）。

### P2-4 Continuation prompt 的 subgoals 段

正文 §3 流程图与 §7 数据契约都暗示 continuation 模板会带上 subgoals，但未给出格式。实际行为（`goal/loop.ts` L99 + `goal/prompts.ts` `renderContinuation`）：

- 当 `goalState.subgoals` 非空时，continuation prompt 会在主目标块下追加一段 "**附加判定标准（subgoals）**"，逐条列出
- judge prompt 同样会拼接 subgoals 段（用于判定时综合考量）
- subgoals 为空时这一段完全省略，不留空白行

这保证了 subgoal 的存在不会造成 prompt 噪声，而活跃 subgoal 则会同时影响 judge 判定与续跑提示——两条路径文案一致。

---

## 17. 归属声明

`/goal` 是 opencode 对 **Ralph loop** 模式的实现。用户侧设计——跨轮保持目标活跃、不达目标不停止、提供 create/pause/resume/clear 控制——由 Eric Traut（OpenAI Codex 团队）在 [Codex CLI 0.128.0](https://github.com/openai/codex) 中提出并发布。hermes-agent 做了独立实现并扩展了 subgoal 机制。opencode 的实现亦为独立编写，适配了 Effect v4 + Bus + Drizzle 架构。核心创意归功于原作者。
