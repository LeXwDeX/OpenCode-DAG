<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
-->

# DAG 工作流引擎 — 架构与二次开发约束

> 本文件是 DAG 引擎的**唯一稳态文档**：只保留代码无法承载的内容（宏观架构、铁律、设计模式、模块边界、二次开发规约）。
> 实现细节、字段定义、状态转移表、配置 schema、算法 —— 全部以**地基代码为单一真相源**，本文档不复制。
> 后续可执行代码工作（退役/补能力/清债）见 `.task_state/dag_backlog.md`；架构决策史见 `.task_state/task_plan_dag_integration.md`。

---

## 1. 架构描述（宏观分层与选型原因）

DAG 引擎把任务编排建模为有向无环图：节点 = 任务单元，边 = `dependencies` 依赖。引擎负责调度、并发、状态管理、错误恢复、持久化。

### 1.1 目标三层架构（D-PLAN-RETIRE 方向，2026-06-09 用户拍板）

```
C. 观察/控制面：事件流(EventBus→bridge) + 状态快照查询(query) + 命令集(pause/resume/cancel/replan) + 诊断探针(预留)
B. Session 运行时：SQLite 投影 + agent 子会话绑定 + Effect/fiber 调度
A. 执行核(纯逻辑·单一真相源·无DB可独立测)：状态转移表 + 依赖图算法 + 调度决策
```

**为什么这样分层**：执行核逻辑（状态转移/依赖就绪/并发预算）必须单一真相源且可脱离 DB 独立测试 → 抽到 A 层纯函数（`session/execution-core.ts`，零 Effect/DB 依赖）。运行时副作用（DB 持久化 + fiber 调度）归 B 层。可观察/可控制能力复用聚合，不新建并行路径 → C 层。

### 1.2 双路径历史与退役方向

DAG 早期存在 **Core 路径**（state-machine/scheduler/group-manager 的实现类，内存/工具设想）与 **Session 路径**（生产 DB 路径）双套并存。实证确认 Core 实现类与 Session 范式级错配（Promise vs Effect/fiber、Group/Branch 两级 vs 扁平 node），且生产已用更成熟方式实现 Core 设想的全部能力。

**决策（D-PLAN-RETIRE）**：Session 路径为唯一生产真相源；Core 三组实现类退役。退役**尚未执行完**（详见 §6 退/留判定表 + backlog WP-6）。

### 1.3 模块依赖方向（无循环）

```
execution-core(A,纯函数) ← session(B) ← query(C) ← bridge(C)
                              ↑
                    persistence(schema) / worktree-manager(opt-in)
state-machine/{EventBus,IStateMachine,types}(类型/事件真相源) ← session / bridge
```

---

## 2. 四条铁律（不可违反）

DAG 所有状态变更模块必须遵守：

1. **状态机不可绕过** — 所有状态变更经状态机 API（Session 层 `getValidNextSession*` 验证），禁止直改状态变量。
2. **终态不可逆** — `completed` / `failed` / `cancelled` 不可回退。
3. **事件必须广播** — 每次状态变更发出 dot notation 事件（`workflow.*` / `node.*`），含完整上下文。
4. **状态持久化优先** — 先写 SQLite 再更新内存，失败时回滚（B 层 persist-first；A 层纯逻辑无状态不涉此条）。

---

## 3. 跨模块设计模式（统一，禁止混用）

| 规则 | 要点 |
|------|------|
| 构造函数依赖注入 | 必需依赖在前，可选依赖在后（`eventBus?: IEventBus`）；Session 层 Effect.gen 工厂用模块级 `setEventBus()` setter（合理变通） |
| 事件广播统一 | 全引擎共享同一 `IEventBus` 实例，禁止自建事件通道 |
| 持久化 rollback | 先持久化 → 后内存 → 最后广播；失败自动回滚 |
| 类型桥接 | 跨模块事件用 `as unknown as WorkflowEvent \| NodeEvent`，禁止 `as any` |
| 双路径隔离 | Core/Session 共享 EventBus 时按 `workflow_id` 字段过滤，**非**事件类型前缀 |

---

## 4. 模块简述（职责 + 约束承载证据）

> 实现与字段细节在地基代码；下表只锚定职责边界与承载位置。

| 模块 | 职责（边界） | 约束承载（地基代码） |
|------|------|------|
| **session（B 层核心）** | DB 运行时：Workflow/Node CRUD + 铁律验证 + 调度编排 + 违规检测 | `session/session-service.ts`（DAGSessionService）、`workflow-engine.ts`（WorkflowEngine：调度/pause/resume/cancel/replan）、`required-nodes-monitor.ts` |
| **execution-core（A 层）** | 纯逻辑单一真相源：状态转移表 + 依赖就绪/环检测 + 并发预算 + replan 纯函数 | `session/execution-core.ts`（零 Effect/DB；测试 `__tests__/execution-core.test.ts`） |
| **query（C 层只读）** | 只读查询 API：列表/详情/时间线/统计/依赖/历史/日志 | `query/dag-query.ts`（DAGQuery）、`query/query-types.ts`（IDAGQuery） |
| **bridge（C 层）** | DAG 内部事件 → 平台 Bus **单向只读**桥接（`dag.workflow.*` / `dag.node.*`），禁反向回写 | `bridge/dag-bus-bridge.ts`、`bridge/dag-events.ts` |
| **persistence** | SQLite schema（Drizzle，6 表：dag_workflow/node/violation/workflow_history/node_log/schema_version） | `persistence/schema.ts` |
| **worktree-manager** | Git worktree 文件隔离，节点 `worker_config.use_worktree===true` 时 opt-in（默认关闭） | `worktree-manager/*`（已装配 `layer.ts`；生产**必留**） |
| **state-machine（类型/事件源）** | `WorkflowStatus`/`NodeStatus`/事件 union/`IEventBus` 定义 + `EventBus` 实现 | `state-machine/{types,IStateMachine,EventBus}.ts`（生产**必留**） |
| state-machine 实现类 | NodeStateMachine/WorkflowStateMachine（Core 设想） | **退役进行中**（零生产引用，见 §6 + backlog WP-6） |
| scheduler | Worker 调度（Core 设想，Promise 范式） | **退役进行中**（整目录零生产引用） |
| group-manager 实现类 | Group→Branch 层级 + 依赖图（Core 设想） | **退役进行中**（保留 `types.ts` 传递必留） |

### 4.1 控制命令现状

`pause`/`resume`/`cancel`/`replan`/`step` 已全栈贯通：`dagworker` tool（LLM 入口）→ HTTP Mutation API（`server/.../dag-mutation`）→ `WorkflowEngine` → `session-service`。TUI 控制台（`cli/.../dag-workflow/`）提供按钮 + create 多字段对话 + replan 节点编辑 + paused 态 step 单步。step 语义：paused 状态下单步触发 1 个 ready node 至完成/失败（workflow 始终保持 paused，通过 `stepMode` token 阻断自动调度链）。`inspect` 仅作为 TUI/HTTP 只读诊断面进入实现范围；不新增 `dagworker inspect`。

---

## 5. 诊断探针（运行时已激活，TUI 只读暴露）

`query/probe-types.ts`（`IDAGProbe`）+ `query/dag-probe.ts`（`DAGProbe`）是**只读诊断探针**，用于回答"节点为何阻塞 / 拓扑分层 / 运行快照 / 级联影响"。运行时逻辑于 2026-06-10 用户显式激活，复用 A 层纯函数（`execution-core.ts`）实现全部 4 个方法（`explainBlock` / `getTopology` / `getExecutionSnapshot` / `predictCascade`）。

**激活后可被 import 调用**（如 TUI 内部、内部诊断工具）。2026-06-11 用户授权后，探针允许通过 HTTP read API 暴露给 TUI inspect 面板；这不是 agent tool 暴露。

**刻意约束（不可违反）**：
- 探针**只读**（经 sessionService 取数，绝不写状态、不 emit、不绕状态机）。
- 探针**代码层可见**（被 `query-types.ts` type re-export 锚定，非孤儿；禁止当 unused 删除）。
- 探针**只允许只读 UI 暴露**：可新增 `dag` read-only HTTP 路由供 TUI inspect panel 调用；不得放入 `dag-mutation`。
- 探针**不暴露给 AGENT**：不进 `dagworker` action 枚举、不进 MCP 工具清单、不作为 LLM 可调用工具出现。
- 若为 HTTP/TUI 装配需要引入服务层，只能装配只读 probe 服务；禁止新增写路径或事件广播。

---

## 6. 二次开发指引

### 6.1 配置 schema（唯一真相源）

DAG 工作流配置形状的**唯一权威定义** = `session/types.ts` 的 `DAGConfig` / `DAGNodeConfig`。任何示例/模板/工具文档必须与之一致，本文档不复制字段表。最小示例：

```json
{ "name": "wf", "max_concurrency": 3, "nodes": [
  { "id": "a", "name": "A", "dependencies": [], "required": true,
    "worker_type": "implement", "worker_config": { "prompt": "..." } }
] }
```

约束上限（`limits.ts`）：节点 ≤20、并发 1-10、子 DAG 深度 ≤3。声明式 `condition`（节点级 skip/ready）与 `input_mapping`（上游数据注入）的 schema 与校验规则以 `session/types.ts` + schema 校验代码为准。

### 6.2 扩展点

- 新增节点行为：扩 `worker_type` 路由（经 `Agent.Service.get`）或 `worker_config` 透传键。
- 新增查询：加 `IDAGQuery` 方法（只读，经 sessionService）。
- 新增控制命令：`dagworker` action + HTTP Mutation 路由 + `WorkflowEngine` 方法，三处对齐，**必经状态机落地**。
- 新增观察：优先复用 query/bridge，或实现 §5 探针；probe 只能按 §5 的 TUI/HTTP 只读边界暴露。

### 6.3 禁止项（硬约束）

- ❌ TUI / 外部进程直连 DAG SQLite（必经 server）。
- ❌ 绕过状态机直接 `DB.insert/update` 状态（破坏铁律 #1/#4）。
- ❌ bridge 反向回写 `WorkflowEngine` / `session-service`。
- ❌ 重新引入 Core 实现类（NodeStateMachine/Scheduler/GroupManager）—— 已退役（D-PLAN-RETIRE），代码承载删除。
- ❌ 删除**必留/传递必留**资产（见退/留判定表）。
- ❌ 把 `worker_type === "dag"` 注册为 agent 名（保留字，触发子 DAG 派发）。

### 6.4 必留资产判定表（WP-6 已完成，Core 实现类已退役）

| 资产 | 判定 | 生产引用证据 |
|------|------|---|
| `state-machine/{EventBus,IStateMachine,types}.ts` | **必留** | layer.ts / session-service.ts / workflow-engine.ts / bridge |
| `group-manager/types.ts` | **传递必留** | EventBus.ts + IStateMachine.ts（GroupEvent union） |
| `worktree-manager/*` | **必留** | layer.ts + workflow-engine.ts（已装配生产） |
| `query/{probe-types,dag-probe}.ts` | **必留（预留）** | query-types.ts re-export 锚定（§5，禁删） |

退役细节（已删除的 Core 实现类 + 孤儿测试清单）见 `.task_state/dag_backlog.md` WP-6 DONE 区。

### 6.5 常见陷阱

- `execution-core.detectCycle` 接收 `DAGNodeConfig[]`（**非** `DAGNodeSession[]`）。
- Core 与 Session 状态枚举**独立维护**（Session 6 态，无 ARCHIVED/ABORTED/node-PAUSED），非共享函数。
- pause 是 **workflow 级**操作：running 节点不中断、pending 节点经 `spawnReadyNode` 入口 guard 暂缓，node 状态不变（不存在 node-PAUSED）。

---

## 7. 开发规范

- **测试**：按铁律组织（`describe('铁律 #N: ...')`），命名清晰；运行 `cd packages/opencode && bun test src/dag`。新增模块需独立测试锚点。
- **类型**：无 `any`、无硬编码依赖、无循环依赖；`bun typecheck` 须 0 error。
- **循环依赖斩断变通**：当一个 Effect Service tag 引发跨模块循环（如 `worktree-manager/tags.ts:WorktreeManagerTag`），可提取到无运行时依赖的叶子文件，由装配层（`layer.ts`）import + use。优先尝试 `Layer.suspend` 延迟求值（`provider.ts:1852` 先例）；仅当延迟无效（tag 在装配时点被急切访问）才提取叶文件。
- **代码风格**：遵循仓库根 `AGENTS.md`（snake_case schema 字段、Bun API、early return、避免单用 helper）。
- **提交**：conventional commits（`feat(dag): ...` / `fix(dag): ...` / `refactor(dag): ...`）。
- **文档纪律**：本文件是唯一稳态文档；新功能完成（verify+review PASS）后退化对应条款至此表，禁止重新膨胀字段级细节（实现归地基代码）。

---

*单一文档化于 2026-06-10（6 文档 + 3 子 README 退化合并）。架构决策史见 `.task_state/task_plan_dag_integration.md`。*
