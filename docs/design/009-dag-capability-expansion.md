# DAG 表达力扩展与引擎持久化 — 开发路线图

> **文档状态**: 已批准（执行顺序 A→B→C→D 经用户确认）
> **创建时间**: 2026-06-09
> **作者**: Main Agent
> **依赖**: 002-dag-control-mutations.md（ADR）、007-dag-session-integration.md、008-tui-dag-integration.md
> **性质**: 规划文档（需求→约束转换层）。仅承载架构约束、模块边界、WP 拆解与设计决策；不含实现代码。各特性落地后本文对应章节退化为稳态简述，最终约束由地基代码承载。

---

## 0. 背景与目的

DAG-Worker-Flow 当前是**纯静态依赖编排器**：节点按 `dependencies` 顺序执行，无条件分支、无节点间数据传递、无嵌套子图、进程重启后运行中工作流被标记 failed（不可恢复）。

本文规划四个能力扩展（A 引擎持久化、B 条件分支、C 数据流、D sub-DAG），基于一次**代码事实审理**（3 路只读侦察）给出每个特性的真实工作量、WP 拆解、依赖顺序与关键设计决策。

### 0.1 审理的关键修正（promptOps 翻案）

此前判断"引擎持久化无法实现，因 promptOps 强绑 session turn"——**经代码核实为误判**。

| 论断 | 证据 |
|---|---|
| `promptOps` 可 headless 化 | `tool/task.ts:227 / 265 / 282` 已有脱离主对话轮的后台 fiber 调用 `ops.prompt(...)` / `ops.loop(...)` 的生产代码 |
| `prompt()` 不绑当前 turn | `session/prompt.ts:1808` 的 `sessionID` 是显式入参；依赖的 Service 全为进程级 layer 单例（sessions/agents/provider/processor）|
| turn 绑定仅在注入路径 | `ctx.extra.promptOps`（prompt.ts:561/972/2110 注入）是唯一 turn 耦合点，非能力限制 |
| headless 获取方式 | 在 `dag/layer.ts:57` recovery 上下文 `yield* SessionPrompt.Service` 即可 |

### 0.2 Capability Reservoir 的真实覆盖

core 储备池（`state-machine/` `group-manager/` `scheduler/` `worktree-manager/`）是**完整实现 + 290 测试**，但提供的是**正交基础设施**（铁律框架 / worktree 隔离 / 组依赖拓扑），**不包含**条件分支求值、节点间数据流、sub-DAG 调度的现成算法。

| 储备池模块 | 可复用于本路线图 | 不覆盖 |
|---|---|---|
| `state-machine`（NodeStateMachine.skipNode 等） | 特性 B 的 skip 状态转移 | 条件求值（仅静态转移表校验） |
| `group-manager` + `DependencyGraph` | 特性 D 的嵌套组结构 + 拓扑排序 | sub-DAG 调度与父子生命周期 |
| `worktree-manager` | （已生产装配）节点隔离 | — |
| `scheduler` | 无（职责是并发执行已知任务，非就绪计算） | 条件/数据流/就绪判定 |

---

## 1. 现状能力基线（事实锚点）

> 以下 file:line 为审理时的证据锚点，供各 WP 启动时 archgate 复核。地基代码演进后以代码为准。

### 1.1 配置结构（无扩展字段）
- `DAGConfig`：`types.ts:116`（name/description?/nodes/max_concurrency/timeout_ms?）
- `DAGNodeConfig`：`types.ts:86`（id/name/description?/dependencies/required/timeout_ms?/retry?/worker_type/worker_config）
- 无 condition / when / branch / edge / input_mapping / output_binding / sub_dag 任何字段
- `DAGNodeSession.output`：`types.ts:180`（已持久化但无消费者）；无 input 字段

### 1.2 调度语义（纯顺序依赖）
- 就绪判定 `getReadyNodes`：`workflow-engine.ts:443`（`!running && !completed && !failed && depsSatisfied`，无条件求值挂点）
- 依赖满足 `areDependenciesSatisfied`：`workflow-engine.ts:433`（`dependencies.every(∈ completed)`）
- prompt 构造 `spawnReadyNode`：`workflow-engine.ts:627`（仅注入 `worker_config.prompt`，不读上游 output）
- worker_type 消费：`workflow-engine.ts:500`（`agentService.get(worker_type)` 当 agent 名，无 dispatch by type）
- 失败级联 `cascadeSkipDownstream`：`workflow-engine.ts:789`（唯一 skip 触发源 = 上游 failed）

### 1.3 持久化与恢复（重启即 failed）
- `recoverOrphanedWorkflows`：`recovery.ts:23`（running 孤儿 → 标记 failed + 级联 skip，无续跑）
- engine 注册表 `engineRegistry`：`workflow-engine.ts:105`（进程内存，重启清零）
- executor daemon：`workflow-executor.ts:46`（轮询 `getWorkflowStatus` + `scheduleReadyNodes`，无进程内状态）
- 唯一创建/启动入口 `startWorkflowFromConfig`：`tool/dagworker.ts:182`（强绑 `Tool.Context`）

---

## 2. 特性规划

每个特性触架构治理面（types schema + 调度逻辑 + 状态机），**所有 WP 启动前必经 archgate**。工作量口径：小 = 加字段/装配；中 = 新增调度逻辑；大 = 零基础机制。

### 特性 A — 引擎持久化 / 自动续跑（工作量：中）

**目标**：进程重启后，DB 中处于 running 的工作流能恢复执行，而非一律标记 failed。

**核心约束**：
- 写路径必须穿透状态机（铁律 #1）；续跑不得绕过 `updateWorkflowStatus`/`updateNodeStatus`
- promptOps 经 headless 注入（`dag/layer` 引入 `SessionPrompt.Service` 依赖），不复制 turn 注入逻辑
- 恢复在 HTTP-server-scoped 触发（`dag/layer.ts:57`），CLI-only 模式不续跑（维持现状语义）

**WP 拆解**：

| WP | 内容 | 工作量 | 关键约束 |
|---|---|---|---|
| A1 | `dag/layer` 注入 `SessionPrompt.Service`（前置依赖） | 小 | 不引入循环依赖；layer 边界注入 |
| A2 | recovery 续跑装配：engine 重建（`WorkflowEngine.make`）+ promptOps 重注入 + daemon 重启（`forkDetach`）+ concurrencyRegistry 重填 | 小 | 全为进程级依赖重建，机械 |
| A3 | running 节点续跑语义（**需设计决策，见 §3.1**） | 中 | 节点状态归位必须经状态机；不得丢失审计 |

**依赖**：A1 → A2 → A3。A3 阻塞于 §3.1 决策。

---

### 特性 B — 条件分支（工作量：中）

**目标**：节点可声明执行条件，条件不满足时主动跳过（区别于"上游失败级联跳过"）。

**核心约束**：
- 条件求值是**纯函数**（输入：依赖节点状态/output；输出：bool），不得有副作用
- 条件不满足 → 走状态机 skip 转移（复用 `NodeStateMachine.skipNode` 语义），不得直接改状态变量
- 条件语义必须可序列化（存 config，replan 可改），不得是闭包/代码注入
- required 节点的条件跳过需明确语义（required + 条件不满足 是否违反"required 不可跳过"铁律 → **见 §3.2 决策**）

**WP 拆解**：

| WP | 内容 | 工作量 | 关键约束 |
|---|---|---|---|
| B1 | `DAGNodeConfig.condition` 字段 + schema 校验 + canonical 文档更新 | 小 | 声明式条件语法，禁代码注入 |
| B2 | 条件求值挂到就绪判定（依赖满足后求值，决定 ready vs skip） | 中 | 求值纯函数，挂点在 `getReadyNodes` 后 |
| B3 | 条件不满足 → 主动 skip + 下游级联（扩展 `cascadeSkipDownstream` 触发源） | 中 | 复用 skip 状态转移；下游语义与失败级联一致 |

**依赖**：B1 → B2 → B3。独立于 A。

---

### 特性 C — 数据流（工作量：中偏大）

**目标**：节点可声明从上游节点 output 取值作为自身输入（注入 prompt 或结构化 input）。

**核心约束**：
- 数据引用声明式（存 config），引用语法可序列化、可校验（引用的上游节点必须是声明依赖）
- output 收集按依赖图聚合 completed 节点，不得跨依赖边界取值（防止隐式依赖）
- 注入点在 `spawnReadyNode` prompt 构造处，不破坏现有 `worker_config.prompt` 语义（叠加而非替换）
- 数据流不引入新的 ready 阻塞（依赖已保证上游完成）

**WP 拆解**：

| WP | 内容 | 工作量 | 关键约束 |
|---|---|---|---|
| C1 | `DAGNodeConfig.input_mapping` 字段（output 引用语法）+ schema | 小 | 引用必须 ⊆ dependencies；声明式 |
| C2 | 上游 output 收集（按依赖聚合 completed 节点 output） | 中 | 只读 DB；不跨依赖取值 |
| C3 | prompt/input 注入（改 `spawnReadyNode` 构造，叠加上游数据） | 中 | 不替换现有 prompt；注入可审计 |

**依赖**：C1 → C2 → C3。建议在 B 之后（复用 B 的声明式字段扩展模式）。

---

### 特性 D — sub-DAG（工作量：中偏大）

**目标**：节点可声明 `worker_type="dag"` + 子 DAGConfig，spawn 时递归启动子工作流，父节点完成当且仅当子工作流终态收敛。

**核心约束**：
- 子工作流同样受四铁律约束（节点≤20、并发≤10、required 不可跳过、状态机不可绕过）
- 子工作流的节点≤20 上限独立计（嵌套不绕过单图上限）
- 父子生命周期通过**显式桥**关联（子终态 → 父节点 `handleNodeCompletion/handleNodeFailure`），不得轮询泄漏 fiber 或静默挂起
- `startWorkflowFromConfig` 去 `Tool.Context` 化后，工具路径与递归路径共用同一核心函数（消除重复，单一来源）
- 递归深度需有上限（防无限嵌套），上限语义见 §3.3

**WP 拆解**：

| WP | 内容 | 工作量 | 关键约束 |
|---|---|---|---|
| D1 | `startWorkflowFromConfig` 去 `Tool.Context` 化（提取核心函数，参数化 promptOps/chatSessionId/abortSignal） | 中 | 工具路径回归测试不破；单一来源 |
| D2 | `worker_type="dag"` 分发（`validateWorkerTypes` 跳过保留字 + `spawnReadyNode` 加递归分支） | 小 | "dag" 成保留字；分发不影响现有 agent 解析 |
| D3 | 父子生命周期桥（子工作流终态 → 父节点完成回调/事件，**零基础，见 §3.3**） | 大 | 子终态必经事件/回调通知父；递归深度上限 |

**依赖**：D1 → D2 → D3。建议最后（D3 是独立大头）。

> **每个中/大型 WP（A2/A3、B1/B2/B3、C1/C2/C3、D1/D2/D3）的详细要求规格见 §7** —— 含输入/输出契约、验收标准、边界条件、测试覆盖要求、archgate 关注点、完成定义（DoD）。下发 implement/archgate 时以 §7 对应小节为准。

---

## 3. 关键设计决策（开发前需锁定）

### 3.1 [特性 A] running 节点续跑语义 — **待决策**

进程重启时，处于 running 的节点其子 session 对话中断在半途。续跑有两种路径：

| 方案 | 含义 | 代价 | 复杂度 |
|---|---|---|---|
| **重跑** | 节点状态归位 pending，重新 spawn（丢弃半截对话） | 浪费已完成的部分算力 | 简单 |
| **resume 子 session** | `ops.loop({sessionID: childSessionId})` 接续子 session loop | 省算力 | 需判断子 session 能否仍产出 `node_complete` |

**决策建议**：首版用**重跑**（简单、确定性强、不依赖子 session 可恢复性）；resume 作为后续优化。最终决策在 WP-A3 启动前由用户确认。

### 3.2 [特性 B] required 节点 + 条件不满足 — **待决策**

"required 不可跳过"是四铁律之一。但若 required 节点声明了条件且条件不满足，存在语义冲突：

- **方案 1**：required 节点禁止声明 condition（schema 校验拒绝）——铁律优先，最清晰
- **方案 2**：required + 条件不满足 → 工作流失败（required 必达，条件不满足即视为不可达）
- **方案 3**：条件跳过的 required 节点不计入"必达"集（弱化 required 语义）——**不推荐**（破坏铁律）

**决策建议**：方案 1（required 与 condition 互斥，schema 层拒绝）。最终决策在 WP-B1 启动前确认。

### 3.3 [特性 D] sub-DAG 递归深度上限 + 父子桥机制 — **待决策**

- **递归深度上限**：防无限嵌套。建议硬上限（如深度 ≤ 3），超限 schema 拒绝。
- **父子桥机制**：
  - **轮询**：父节点 fiber 启动子工作流后轮询子 `getWorkflowStatus` 至终态（侵入小，占 fiber）
  - **事件桥**：`maybeFinalizeWorkflow` 收敛时发事件，父节点订阅（解耦，需新事件类型 + 订阅注册）

**决策建议**：事件桥（与现有 EventBus 架构一致，不占 fiber）。最终决策在 WP-D3 启动前确认。

---

## 4. 执行顺序与依赖

```
特性 A（引擎持久化）   ← 价值最高，工作量已证实为中，promptOps 障碍已破
   ↓（独立）
特性 B（条件分支）     ← DAG 表达力基础，建立声明式字段扩展模式
   ↓（C 复用 B 的字段扩展模式）
特性 C（数据流）
   ↓（D 最后，父子桥是独立大头）
特性 D（sub-DAG）
```

**短期项**（可随时插入，各 2-3 小时）：
- create 多字段 UI（DialogPrompt 串联 goal→scope→context）
- replan 节点编辑器 TUI（后端 add/remove/update_nodes 已支持，仅缺录入入口）

---

## 5. 每特性的标准开发流程（硬约束）

每个 WP 遵循统一流程，不跳步：

```
archgate（架构校验，触治理面强制）
  → 约束（schema/字段先于实现）
  → 接口/骨架设计
  → TDD（单元测试先于实现）
  → implement（最小创伤）
  → verify（测试三态）
  → review（PASS/BLOCKING 门禁）
  → 集成测试（与已完成模块交互）
  → 文档退化（本文对应章节退化为稳态简述）
  → commit
```

**铁律守恒**：任一 WP 不得绕过状态机、不得破坏四铁律（节点≤20 / 并发≤10 / required 不可跳过 / 状态机不可绕过 / 终态不可逆）、不得引入循环依赖。

---

## 6. 风险登记

| 风险 | 特性 | 缓解 |
|---|---|---|
| 续跑语义选错导致重复执行/数据不一致 | A | §3.1 首版用重跑（确定性），充分集成测试 |
| 条件求值引入副作用破坏纯函数性 | B | 求值强制纯函数，schema 拒绝代码注入 |
| 数据流引入隐式依赖（跨依赖取值） | C | 引用必须 ⊆ dependencies，schema 校验 |
| sub-DAG 父子桥静默挂起（父节点永不完成） | D | §3.3 事件桥 + 超时兜底；递归深度上限 |
| 嵌套绕过节点≤20 上限 | D | 每图独立计上限，schema 校验 |

---

## 7. WP 详细要求规格

> 本章是对 §2 各中/大型 WP 的展开。每个 WP 给出 7 段标准要求：**前置/输入契约、输出契约（意图非代码）、验收标准、边界条件、测试覆盖要求、archgate 关注点、完成定义（DoD）**。下发 implement 时附对应小节；archgate 校验时以"archgate 关注点"为焦点。所有规格不含实现代码——契约描述"要满足什么"，实现归地基代码。

### 通用 DoD（所有 WP 适用，不重复列出）

- `bun typecheck` 0 errors（从 package 目录跑）
- 受影响测试全绿 + 新增测试覆盖本 WP 验收标准
- 0 `as any`（生产代码）/ 0 `console.log` / 0 `TODO`
- 四铁律守恒（节点≤20 / 并发≤10 / required 不可跳过 / 状态机不可绕过 / 终态不可逆）
- 不引入循环依赖（新增模块依赖方向单向）
- verify PASS + review PASS（0 blocking）+ 集成测试 PASS 后方可 commit

---

### 特性 A — 引擎持久化 / 自动续跑

#### WP-A1 — dag/layer 注入 SessionPrompt.Service

- **前置/输入契约**：无前置 WP。依赖 `SessionPrompt.Service`（`session/prompt.ts`）已是进程级 layer Service。
- **输出契约**：`dag/layer` 的 recovery 装配上下文可 `yield* SessionPrompt.Service` 取得，进而 `.ops()` 得到 headless promptOps。不改变 `dag/layer` 对外暴露的 Tag 形状。
- **验收标准**：recovery 上下文能拿到一个可调用 `prompt({sessionID,...})` 的 promptOps 实例；现有 `dag/layer` 初始化路径（含 `recoverOrphanedWorkflows` 触发）行为不变。
- **边界条件**：(a) CLI-only 模式（无 HTTP server）不得因此变更而崩溃——recovery 仅 HTTP-server-scoped 触发的语义保持；(b) 注入不得在 layer 构建期 eager 调用 prompt（仅取得能力，不执行）。
- **测试覆盖要求**：layer 装配 smoke（recovery 上下文可解析 SessionPrompt.Service）；现有 recovery.test.ts 不回归。
- **archgate 关注点**：依赖方向（dag → session 是否合理、是否成环）；layer 边界注入是否符合既有 layer 组织（不在 request handler 内 provide）。
- **DoD**：通用 DoD + recovery 上下文可取 headless promptOps，现有 recovery 行为不变。

#### WP-A2 — recovery 续跑装配

- **前置/输入契约**：WP-A1 完成（headless promptOps 可得）。输入 = DB 中 `status='running' && engine===undefined` 的孤儿工作流集（现 recovery.ts:23 已能识别）。
- **输出契约**：对每个可续跑的孤儿工作流，重建 `WorkflowEngine` 实例 → 重注入 promptOps → 重填 `concurrencyRegistry`（从 `config.max_concurrency`）→ `registerEngine` → 重启 executor daemon（`forkDetach`）。工作流状态保持 running（不再无条件标 failed）。
- **验收标准**：重启后孤儿工作流的 pending/ready 节点能被重新调度执行（经状态机）；engine 经 `WorkflowEngine.get(id)` 可查到；daemon 轮询恢复。
- **边界条件**：(a) 续跑装配本身失败（如 promptOps 不可得）→ 回退到现状语义（标 failed），不得使工作流卡在不可恢复中间态；(b) 节点续跑语义（running 节点如何处理）属 WP-A3，A2 仅负责 pending/ready 节点恢复调度；(c) 幂等——recovery 重复触发不得重复 registerEngine / 重复 fork daemon。
- **测试覆盖要求**：DB 级集成测试——构造 running 孤儿工作流（含 pending 节点）→ 触发 recovery → 断言 engine 重建 + pending 节点被调度 + 状态经状态机。装配失败回退路径测试。幂等测试（二次 recovery 不重复装配）。
- **archgate 关注点**：续跑写路径是否穿透状态机（不得直接改 status 变量）；engine 重建依赖是否全为进程级（无 turn 级泄漏）；与现有"标 failed"语义的边界划分。
- **DoD**：通用 DoD + 孤儿工作流 pending 节点可恢复调度 + 装配失败有回退 + 幂等。

#### WP-A3 — running 节点续跑语义（依赖 §3.1 决策）

- **前置/输入契约**：WP-A2 完成；**§3.1 决策已锁定**（重跑 vs resume）。输入 = 孤儿工作流中 `status='running'` 的节点（子 session 中断在半途）。
- **输出契约**：按 §3.1 决策处理 running 节点。若决策=重跑：节点状态经状态机归位到可重新调度态（running→pending 的合法转移，或等价路径），随后被 WP-A2 的调度恢复重新 spawn。若决策=resume：接续子 session loop。
- **验收标准**：重启后 running 节点不永久卡死；按决策语义被重跑或接续；最终能产出 `node_complete` 推进工作流。
- **边界条件**：(a) running→pending 若非状态机合法转移，需明确转移路径（可能需经中间态或新增合法转移，此处触状态机治理面，archgate 重点）；(b) 重跑不得丢失审计（原 running 记录/violation 保留）；(c) 节点已实际完成但状态未及持久化的竞态（重启窗口）——避免重复执行副作用，或明确"至少一次"语义。
- **测试覆盖要求**：DB 级集成测试——running 节点经重启后按决策语义恢复 + 最终完成。状态机转移合法性测试（running 节点归位路径）。竞态边界测试（已完成未持久化）。
- **archgate 关注点**：running→可调度态的状态机转移是否合法/是否需扩展转移表（治理面）；重跑的"至少一次"副作用语义是否可接受；审计完整性。
- **DoD**：通用 DoD + running 节点按 §3.1 语义恢复 + 状态机转移合法 + 审计保留。

---

### 特性 B — 条件分支

#### WP-B1 — DAGNodeConfig.condition 字段 + schema

- **前置/输入契约**：无前置 WP；**§3.2 决策已锁定**（required 与 condition 是否互斥）。
- **输出契约**：`DAGNodeConfig` 新增 `condition?` 字段，承载**声明式、可序列化**的条件表达（禁代码注入/闭包）。条件引用的上游节点必须 ⊆ `dependencies`。canonical schema 文档同步更新。
- **验收标准**：合法 condition 通过 schema 校验；非法（引用非依赖节点 / 非声明式 / required 节点带 condition 若 §3.2=方案1）被拒绝并给清晰 reason。
- **边界条件**：(a) condition 引用了不在 dependencies 的节点 → schema 拒绝；(b) condition 语法非法 → 拒绝；(c) §3.2=方案1 时 required+condition → 拒绝；(d) 空/缺省 condition → 节点无条件执行（向后兼容，现有 config 不受影响）。
- **测试覆盖要求**：schema 校验单元测试（合法 / 引用越界 / 非声明式 / required 冲突 / 缺省兼容）。canonical 文档示例与 schema 一致性。
- **archgate 关注点**：condition 语法是否真声明式（不可图灵完备/不可注入）；引用 ⊆ dependencies 的约束是否 schema 强制；required 铁律与 condition 的边界（§3.2）。
- **DoD**：通用 DoD + condition 字段 schema 完整 + 非法形态全拒绝 + 缺省向后兼容。

#### WP-B2 — 条件求值挂到就绪判定

- **前置/输入契约**：WP-B1 完成。输入 = 一个依赖已满足的节点 + 其依赖节点的状态/output。
- **输出契约**：在依赖满足判定之后，对声明了 condition 的节点求值条件，输出"应执行 / 应跳过"的决策。求值是**纯函数**（无副作用、无 DB 写、无状态变更）。
- **验收标准**：条件为真 → 节点照常进入就绪；条件为假 → 节点标记为"待跳过"（实际 skip 由 WP-B3 执行）；无 condition 的节点行为不变。
- **边界条件**：(a) 条件引用的上游 output 为空/缺失 → 求值需有确定语义（不得抛异常中断调度，应有默认决策并可审计）；(b) 求值不得阻塞调度（同步纯函数）；(c) 多个条件节点并存时求值相互独立。
- **测试覆盖要求**：求值纯函数单元测试（真/假/上游 output 缺失/多节点独立）；就绪判定集成测试（条件真→ready，条件假→待跳过，无 condition→不变）。
- **archgate 关注点**：求值是否真纯函数（无副作用）；挂点是否在依赖满足之后（不破坏依赖语义）；上游 output 缺失的确定性语义。
- **DoD**：通用 DoD + 条件求值纯函数 + 就绪判定正确分流 + 缺失 output 有确定语义。

#### WP-B3 — 条件不满足主动 skip + 下游级联

- **前置/输入契约**：WP-B2 完成（已能判定"待跳过"）。
- **输出契约**：对"待跳过"节点执行 skip（经状态机 skip 转移，复用 `NodeStateMachine.skipNode` 语义），并级联跳过其下游 pending 节点（扩展 `cascadeSkipDownstream` 的触发源：原仅"上游失败"，新增"条件不满足"）。
- **验收标准**：条件不满足的节点状态=skipped（经状态机）；其下游 pending 节点级联 skipped；工作流终态收敛正确（skip 不阻塞 finalize）。
- **边界条件**：(a) 条件跳过的节点与失败级联跳过的节点在审计上可区分（skip reason 不同）；(b) 下游若有其他路径（多依赖）仍可达 → 不应被误级联跳过（级联语义与失败级联一致）；(c) required 节点的处理依 §3.2 决策。
- **测试覆盖要求**：DB 级集成测试——条件跳过单节点 + 下游级联 + 终态收敛；多依赖节点不误跳；skip reason 区分（条件 vs 失败）。
- **archgate 关注点**：skip 是否经状态机（不绕过）；级联语义是否与失败级联一致；终态收敛正确性；required 铁律守恒。
- **DoD**：通用 DoD + 条件 skip 经状态机 + 下游级联正确 + 审计可区分 + 终态收敛。

---

### 特性 C — 数据流

#### WP-C1 — DAGNodeConfig.input_mapping 字段 + schema

- **前置/输入契约**：无前置 WP（建议 B 之后，复用声明式字段扩展模式）。
- **输出契约**：`DAGNodeConfig` 新增 `input_mapping?` 字段，声明"从哪个上游节点的 output 的哪个路径取值，绑定到本节点的哪个输入键"。引用的上游节点必须 ⊆ `dependencies`。可序列化、可校验。
- **验收标准**：合法 input_mapping 通过校验；引用非依赖节点 / 语法非法 → 拒绝并给 reason；缺省 input_mapping → 节点无数据注入（向后兼容）。
- **边界条件**：(a) 引用越界（非 dependencies）→ 拒绝；(b) 引用 output 的路径在运行期可能不存在 → C2/C3 处理运行期缺失，C1 仅做静态结构校验；(c) 循环引用不可能（引用 ⊆ dependencies，依赖图无环已保证）。
- **测试覆盖要求**：schema 校验单元测试（合法 / 越界 / 非法语法 / 缺省兼容）；canonical 文档一致性。
- **archgate 关注点**：引用 ⊆ dependencies 是否 schema 强制（防隐式依赖）；映射语法是否声明式可序列化。
- **DoD**：通用 DoD + input_mapping schema 完整 + 越界拒绝 + 缺省兼容。

#### WP-C2 — 上游 output 收集

- **前置/输入契约**：WP-C1 完成。输入 = 一个声明了 input_mapping 的就绪节点 + 其依赖（均已 completed，output 已持久化）。
- **输出契约**：按 input_mapping 从依赖节点的持久化 output 收集对应值，组装为本节点的输入数据结构。纯读 DB，无写、无副作用。
- **验收标准**：能正确按映射取到上游 output 值；只从声明依赖取值（不跨依赖边界）。
- **边界条件**：(a) 上游 output 为空/路径不存在 → 确定语义（默认值/缺省标记，不抛异常中断 spawn，可审计）；(b) output 类型与预期不符 → 确定处理（不崩溃）；(c) 收集不得引入额外 ready 阻塞（依赖已保证完成）。
- **测试覆盖要求**：收集逻辑单元测试（正常取值 / 路径缺失 / 类型不符 / 不跨依赖）；只读性验证（无 DB 写）。
- **archgate 关注点**：是否只从 dependencies 取值（防隐式依赖）；只读性；运行期缺失的确定语义。
- **DoD**：通用 DoD + 按映射正确收集 + 不跨依赖 + 缺失有确定语义 + 只读。

#### WP-C3 — prompt/input 注入

- **前置/输入契约**：WP-C2 完成（已能收集上游数据）。
- **输出契约**：在 `spawnReadyNode` prompt 构造处，将收集到的上游数据**叠加**注入（不替换现有 `worker_config.prompt` 语义）。注入内容可审计（日志/snapshot 可见注入了什么）。
- **验收标准**：声明了 input_mapping 的节点 spawn 时 prompt/input 含上游数据；未声明的节点 prompt 构造不变（向后兼容）；注入可在节点日志/snapshot 观测。
- **边界条件**：(a) 注入数据为空（C2 返回缺省）→ 不破坏 prompt 构造；(b) 注入不得使 prompt 超出合理体积（大 output 需有截断或引用策略）；(c) 注入顺序/格式确定（可复现）。
- **测试覆盖要求**：注入逻辑单元测试（有数据注入 / 空数据不破坏 / 现有 prompt 不变）；可审计性测试（注入内容可观测）；DB 级集成测试（端到端：上游完成→下游 spawn 含数据）。
- **archgate 关注点**：是否叠加而非替换现有 prompt 语义；注入可审计；大 output 体积策略。
- **DoD**：通用 DoD + 数据正确注入 + 现有 prompt 兼容 + 可审计 + 体积可控。

---

### 特性 D — sub-DAG

#### WP-D1 — startWorkflowFromConfig 去 Tool.Context 化

- **前置/输入契约**：无前置 WP。现状 `startWorkflowFromConfig`（dagworker.ts:182）强绑 `Tool.Context`（用 ctx.sessionID / ctx.extra.promptOps / ctx.abort）。
- **输出契约**：提取一个**不依赖 Tool.Context** 的核心启动函数，参数化 `promptOps / chatSessionId / abortSignal`（或等价中止机制）。工具路径（dagworker）与递归路径（sub-DAG spawn）共用此核心函数——**单一来源**，消除重复。
- **验收标准**：dagworker 工具路径经重构后行为不变（现有 dagworker 测试全绿）；核心函数可在非工具上下文（仅持有 promptOps/sessionId/abort）被调用启动工作流。
- **边界条件**：(a) 中止机制——原 `ctx.abort.addEventListener` 需被参数化的 abortSignal 等价替代，保证取消语义不丢；(b) 工具路径回归——所有 ctx 依赖点平移到参数，无遗漏；(c) 单一来源——不得留下两份启动逻辑。
- **测试覆盖要求**：现有 dagworker 启动测试不回归；核心函数单元测试（仅传 promptOps/sessionId/abort 即可启动）；中止语义测试（abortSignal 触发取消）。
- **archgate 关注点**：单一来源（无重复启动逻辑）；中止语义等价保持；参数化是否泄漏 Tool.Context 依赖。
- **DoD**：通用 DoD + 工具路径行为不变 + 核心函数可 headless 启动 + 中止等价 + 单一来源。

#### WP-D2 — worker_type="dag" 分发

- **前置/输入契约**：WP-D1 完成（核心启动函数可 headless 调用）；**§3.3 递归深度上限决策已锁定**。
- **输出契约**：`worker_type="dag"` 成为保留字。`validateWorkerTypes` 对 "dag" 跳过 agent 解析校验。`spawnReadyNode` 在 resolve agent 前分支：`worker_type==="dag"` → 取 `worker_config` 中的子 DAGConfig → 经 WP-D1 核心函数递归启动子工作流（用父节点的子 session）。
- **验收标准**：worker_type="dag" 节点 spawn 时启动子工作流（子工作流 DB 行 + 节点创建）；现有 agent 类型节点分发不受影响；递归深度超限被拒绝。
- **边界条件**：(a) "dag" 节点的 worker_config 缺子 DAGConfig / 子 config 非法 → 节点 failed 并给 reason；(b) 子 config 自身节点≤20/并发≤10 独立校验（嵌套不绕过单图上限）；(c) 递归深度超 §3.3 上限 → 拒绝；(d) "dag" 保留字不得与现有 agent 名冲突。
- **测试覆盖要求**：分发单元测试（dag 走递归 / 其他走 agent 解析）；子 config 非法处理；嵌套上限校验（子图 21 节点拒绝）；递归深度超限拒绝；DB 级集成测试（dag 节点启动子工作流）。
- **archgate 关注点**：子工作流四铁律独立守恒（节点≤20/并发≤10/required）；"dag" 保留字不破坏现有 worker_type 解析；递归深度上限强制。
- **DoD**：通用 DoD + dag 节点启动子工作流 + 现有分发不变 + 嵌套铁律守恒 + 深度上限。

#### WP-D3 — 父子生命周期桥（依赖 §3.3 决策）

- **前置/输入契约**：WP-D2 完成（子工作流可被 spawn）；**§3.3 父子桥机制决策已锁定**（轮询 vs 事件桥）。
- **输出契约**：建立子工作流终态 → 父节点完成的桥。子工作流收敛（`maybeFinalizeWorkflow`）为 completed → 父节点 `handleNodeCompletion`；子工作流 failed → 父节点 `handleNodeFailure`。父节点完成当且仅当子工作流终态。
- **验收标准**：子工作流成功收敛 → 父节点 completed → 父工作流继续推进；子工作流失败 → 父节点 failed → 失败级联正确；父节点不静默挂起。
- **边界条件**：(a) 子工作流永不收敛（卡死）→ 父节点需有超时兜底（不无限挂起）；(b) 桥机制不得泄漏 fiber（事件桥需正确订阅/退订；轮询需有退出）；(c) 父节点取消 → 子工作流需级联取消；(d) 子工作流 cancelled → 父节点语义明确（failed 或 cancelled）。
- **测试覆盖要求**：DB 级集成测试——子成功→父 completed→父推进；子失败→父 failed→级联；父取消→子级联取消；子卡死→父超时兜底；fiber 不泄漏（订阅退订/轮询退出）。
- **archgate 关注点**：父子完成语义正确性（当且仅当）；fiber 生命周期（无泄漏）；超时兜底存在；取消级联；与现有 `handleNodeCompletion/Failure` 复用（不另起一套完成路径）。
- **DoD**：通用 DoD + 父子完成语义正确 + 超时兜底 + 取消级联 + 无 fiber 泄漏 + 复用现有完成路径。

---

## 8. 跨特性集成测试矩阵

> 各特性的 WP 内部测试覆盖单特性行为（见 §7 各 WP「测试覆盖要求」）。本章定义**特性组合**的集成验收点——这些交互不属于任一单 WP，必须在依赖的两特性都完成后单独验证。组合测试在后置特性的最后一个 WP 集成测试阶段一并补齐。

| # | 组合 | 交互场景 | 验收点 | 前置 |
|---|---|---|---|---|
| X1 | A × B | 续跑恢复一个含「待跳过」条件节点的工作流 | 重启后条件求值结果一致，已跳过节点不被重新求值/执行 | A 全部 + B 全部 |
| X2 | A × C | 续跑恢复一个声明 input_mapping 的节点 | 重启后上游 output 仍可从 DB 收集并注入（持久化 output 不丢） | A 全部 + C 全部 |
| X3 | A × D | 续跑恢复一个含 sub-DAG 节点的父工作流 | 重启后父子桥重建，子工作流终态仍能推进父节点 | A 全部 + D 全部 |
| X4 | B × C | 条件节点的 condition 引用了由 input_mapping 注入数据的上游 | 求值时机晚于数据收集；条件假→节点 skip→其 input_mapping 不执行收集 | B 全部 + C 全部 |
| X5 | B × D | sub-DAG 节点声明 condition；条件假整图跳过 | 条件假→子工作流根本不启动（不空跑子图）；下游级联正确 | B 全部 + D 全部 |
| X6 | C × D | sub-DAG 节点声明 input_mapping，父数据注入子工作流启动 config | 父收集的上游 output 作为子 DAGConfig 的输入；不破坏子图节点≤20 校验 | C 全部 + D 全部 |
| X7 | B × C × D | 条件 sub-DAG + 数据注入三者叠加 | 求值→数据收集→子图启动顺序确定；任一前置缺省有确定语义 | B+C+D 全部 |

**矩阵铁律**：任一组合不得引入新的状态绕过路径；组合下四铁律仍逐图守恒；组合测试失败优先怀疑「时序/顺序」而非单特性逻辑（单特性已在各 WP 验证）。

---

## 9. 测试场景编号预留（与 scenario-NN 体系对齐）

> 现有 DB 级集成测试沿用 `scenario-NN-<topic>.test.ts` 命名（当前最高 `scenario-22-workflow-finalize`）。新特性的集成测试续编号，**避免与历史冲突、保留组合测试段**。下表为预留登记，实际落地时按 WP 推进认领。

| 编号段 | 归属 | 主题（建议文件名） |
|---|---|---|
| 23 | A | `scenario-23-recovery-resume`（孤儿工作流续跑装配 + pending 节点恢复调度） |
| 24 | A | `scenario-24-running-node-resume`（running 节点按 §3.1 语义恢复） |
| 25 | B | `scenario-25-conditional-skip`（条件不满足主动 skip + 下游级联） |
| 26 | C | `scenario-26-data-flow`（上游 output 收集 + prompt 注入端到端） |
| 27 | D | `scenario-27-subdag-lifecycle`（父子桥：子终态推进父节点 + 取消级联 + 超时兜底） |
| 28-30 | 组合 | `scenario-28..30-cross-feature-*`（§8 矩阵 X1-X7 的 DB 级落地，按组合拆分认领） |

**认领规则**：WP 完成其「测试覆盖要求」时认领对应编号；组合段（28-30）在后置特性最后 WP 集成阶段认领；不得跳号或复用历史编号（21/22 已占）。

---

## 10. 文档生命周期
