# Findings — /goal 命令实现探索发现

> 本文件是**不可信内容隔离区**。

## 任务上下文
- 目标摘要：在 src/goal/ 下实现独立的 /goal + /subgoal 命令模块（Ralph-loop）
- 关键约束：独立模块、Effect v4、Drizzle、multi-sibling no-barrel

## 代码探索发现

### 8 大代码模式（2026-05-15 @explore 提取）

#### P1: Effect Service
- 文件：`src/session/status.ts`
- `Interface` 独立导出 → `Context.Service<Service, Interface>()("@opencode/Xxx")` → `Layer.effect(Service, Effect.gen(...))` → `Service.of({...})` → `defaultLayer = layer.pipe(Layer.provide(...))`
- Tag 格式：`"@opencode/<ServiceName>"`
- 底部 self-reexport：`export * as Xxx from "./xxx"`

#### P2: Schema.Class
- 文件：`src/session/message-v2.ts:65-77`
- 格式：`Schema.Class<ClassName>("Identifier")({...})` + `static readonly zod = zod(this)`
- 可选字段：`Schema.optional(Schema.String)` 或 `.pipe(Schema.optional, Schema.withDecodingDefault(...))`

#### P3: Bus Event
- 定义：`BusEvent.define("domain.action", Schema.Struct({...}))`
- 分组：`const Event = { Xxx: BusEvent.define(...) }`
- 发布：`yield* bus.publish(Event.Xxx, payload)`
- 导入：`import { BusEvent } from "@/bus/bus-event"`

#### P4: Command Registration
- `Default` 常量对象 `{ INIT: "init", REVIEW: "review" } as const` → 加 GOAL/SUBGOAL
- Info schema 含 name/description/template/subtask/hints
- `commands[Default.INIT] = { name, description, source: "command", get template() {...}, hints }`

#### P5: Drizzle Table
- `import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"`
- `import { Timestamps } from "../storage/schema.sql"` → 提供 time_created/time_updated
- 列名 = 字段名（snake_case，无字符串参数）
- `.$type<BrandedID>()` 打品牌
- 索引命名：`<table>_<column>_idx`

#### P6: Session Idle
- 定义：`BusEvent.define("session.idle", Schema.Struct({ sessionID: SessionID }))`
- 触发：`status.set(ctx.sessionID, { type: "idle" })` → publish Event.Idle → delete from map
- 也在 `run-state.ts:59,81` 的 error/cancel 路径触发

#### P7: Config Module
- self-reexport **在文件顶部第1行**：`export * as ConfigGoals from "./goals"`
- 导入惯例：`import { ConfigXxx } from "@/config/xxx"`

#### P8: Provider
- `Provider.Service` 提供 `getModel(providerID, modelID)` → `getLanguage(model)` → LanguageModelV3
- `getSmallModel(providerID)` 适用于 judge 轻量调用
- `defaultModel()` 获取默认 providerID + modelID

### 关键符号
| 文件:行 | 符号 | 角色 | 备注 |
|------|------|------|------|
| src/session/status.ts:51 | SessionStatus.Service | Effect Service 范例 | 含 get/list/set |
| src/bus/bus-event.ts:12 | BusEvent.define | 事件定义工厂 | type + Schema.Struct |
| src/command/index.ts:59 | Command.Default | 内建命令枚举 | 加 GOAL/SUBGOAL |
| src/session/session.sql.ts:15 | SessionTable | Drizzle 表范例 | 含 Timestamps/index |
| src/provider/provider.ts:944 | Provider.Service | 模型调用入口 | getModel/getLanguage |
| src/config/agent.ts:1 | ConfigAgent | 配置模块范例 | self-reexport 在顶部 |

### 关键适配发现
- session.idle **在 error/cancel 路径也会触发**（run-state.ts:59,81） → R1 风险已排除
- Idle 事件当前**无 cause 字段** → 需要扩展来区分 complete vs abort
- Provider.getSmallModel() 可用于 judge → Auxiliary 可简化为配置解析器

## 技术决策候选
| 方案 | 优势 | 劣势 | 估算改动量 |
|------|------|------|------|
| A: 新建 src/auxiliary/ 服务层 | 通用、可扩展 | 过度设计（目前只有 judge 一个任务） | +1 目录 +1 文件 |
| B: judge 配置直接在 src/goal/judge.ts 内解析 | 简单、自包含 | 未来如有第二个 auxiliary task 需重构 | 0 额外文件 |
| **→ 选 B** | 用户要求"独立模块"，judge 配置内嵌更符合 | | |

## 外部资料
- 设计文档：`.plans/goal-command-design.md`（600 行，17 节）

## 审计 A — /goal 端到端可用性（2026-05-15）

### 现象
`/goal foo` 在 TUI 输入后**不会**设定目标，而是把 `foo` 作为普通用户消息发给 LLM。`/subgoal foo` 同样失效。

### 根因
- `src/command/index.ts:104-117` 把 GOAL/SUBGOAL 注册成"模板命令"，template 留空，hint 用 `$ARGUMENTS`。
- 命令最终走到 `src/session/prompt.ts:1837 SessionPrompt.command`，该函数只会做模板替换 → 当模板为空且没有占位符时，把 `input.arguments` 作为文本拼接（line 1870-1872），然后走正常 prompt 流程。
- `Goal.dispatch` / `Goal.dispatchSubgoal` 在 goal/goal.ts 定义齐全，但**全局没有任何调用方**（grep `goal.dispatch` 仅 `Goal.Service` 一处出现于 loop.ts）。

### 与设计文档的偏差
设计文档 §8.1 明确写出 `Command.handle("goal", args, ctx) → Goal.Service.dispatch(...)`，要求命令派发层早期拦截 goal/subgoal。当前实现缺这一拦截。

### 缺口清单
1. `SessionPrompt.command` 入口需要在 `commands.get(input.command)` 之前判断 `input.command === "goal" | "subgoal"`，命中即调用 `Goal.dispatch / dispatchSubgoal`，根据返回类型分两路：
   - `type:"message"` → 不调 LLM，直接发 assistant 消息（或 system 通知）
   - `type:"kick"` → 把 text 作为用户首轮消息走正常 prompt 流程
2. `dispatch` 当前 message 文案的"投递通道"未定（设计文档 §9 给文案，未给传输方式）：候选方案
   - A) 注入一条 `info` part 到当前会话（最贴近 TUI 用户感知）
   - B) 走 bus event `goal.message`，TUI 渲染 toast（更轻，但需要 SDK 类型再生）
   - C) 直接 throw 一个非错误 NamedError 让 SessionPrompt 把 message 通过 `Session.Event.Error` 派发（hack）
3. `/subgoal foo` 未定义 `add` 关键字时直接 append（dispatchSubgoal 已实现），但当前命令 description 写 `add <text>` 误导用户。
4. 命令注册的 description 与设计文档 §2 命令表用语应统一。

### 影响
- SC-6（"Command 注册"）字面上完成、实际不可用。SC-2（typecheck）通过不代表功能可用。
- 整个 Ralph loop 无法被用户触发，loop 模块在生产环境形同死代码。

### 风险评级
HIGH — 用户感知层面整个特性不可用。
