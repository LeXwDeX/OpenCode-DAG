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

### 特性 A — 引擎持久化 / 自动续跑 ✅ 特性整体已完成（commit `d30b53a0d`）

进程重启后，DB 中处于 running 的工作流能恢复执行。WP-A1（dag/layer 注入 SessionPrompt.Service）+ WP-A2（recovery 续跑装配 engine 重建 + daemon 重启 + 幂等守卫 + 装配失败回退到标 failed）+ WP-A3（running 节点经状态机合法转移到 pending，由现有 scheduleReadyNodes/spawnReadyNode 重新 spawn；子 session 孤儿 DB 记录遗弃，"至少一次"语义可接受）。

**已锁定决策**：§3.1 running 节点续跑语义 = 首版重跑（resume 作为后续优化）。转移表扩展 running→pending 在 `getValidNextSessionNodeStatuses` 内（不绕过 updateNodeStatus，铁律 #1 守恒）；running/pending 均非终态（isNodeTerminalStatus 未修改）。scenario-23/24 DB 级集成测试覆盖三态续跑 + running 归位全链路，全量 DAG 回归 234/234 + 53/53 + session-service 95/95 + typecheck 0 errors。

**INFO 已知限制（后续 WP 评估）**：buildSessionNodeEvent 对 pending 不发射 `node.reset` 事件（archgate INFO 3）；子 session 孤儿 DB 记录遗弃无清理（archgate INFO 4）。

---

### 特性 B — 条件分支 ✅ 特性整体已完成（commit `629a62264`）

节点可声明执行条件，条件不满足时主动跳过（区别于"上游失败级联跳过"）。WP-B1（DAGNodeConfig.condition 字段 structured object + 8 ops 白名单 + schema 校验 required↔condition 互斥 + ref⊆dependencies + canonical 文档 API.md + USER_GUIDE.md 同步，INFO I4 FallbackConfig.condition 语义差异表）+ WP-B2（独立纯函数模块 condition-eval.ts 仅 import type，scheduleReadyNodes 路径分流，8 ops null 语义完整文档化，INFO I1/I2/I3 全处理）+ WP-B3（cascadeSkipDownstream 参数泛化 triggerNodeId + triggerType，scheduleReadyNodes 消费 skipCandidates 状态机 skip + violation + log + cascade，审计双轨 condition_skip vs cascade_skip，INFO I1-I4 全处理；maybeFinalizeWorkflow 幂等守卫保证终态收敛）。

**已锁定决策**：§3.2 required 节点禁止声明 condition（schema 层拒绝，铁律 #1 优先）。条件节点默认 non-required，required 节点无条件执行。

**四铁律守恒**：铁律 #1 转移表扩展在 getValidNextSessionNodeStatuses 内 + 所有 skip 经 sessionService.updateNodeStatus；铁律 #2 skipped 是终态不可回退；铁律 #3 pending→skipped 合法转移在转移表；铁律 #4 required 由 WP-B1 schema 拦截。scenario-25 DB 级集成测试 6 cases 覆盖单节点 skip + 下游级联 + 多依赖不误跳 + 终态收敛 + 共享下游重叠 + 条件 vs 失败对比；全量 DAG 回归 314/314 + DAG core 53/53 + typecheck 0 errors。

**INFO 已知限制（pre-existing latent defects 不在 WP-B3 scope）**：getReadyNodes 不过滤 skipped 节点；updateNodeStatus throw 在 Effect.sync 内变 defect——被 skippedNodeIds 集合 + inFlight filter + 状态机拒绝 skipped→running 三层防护屏障覆盖，不影响功能正确性。

---

### 特性 C — 数据流 ✅ 特性整体已完成（commit `3a8f533f6`）

节点可声明从上游节点 output 取值作为自身输入（注入 prompt 或结构化 input）。WP-C1（`DAGNodeConfig.input_mapping` 字段 Record 形式 `Record<inputKey, DAGInputMappingEntry {ref_node, ref_path?}>` + schema 校验引用 ⊆ dependencies 强制 + 缺省向后兼容 + canonical 文档 API.md + USER_GUIDE.md 同步）+ WP-C2（独立纯函数模块 `input-mapping-collector.ts`，4 类运行期缺失去语义完整：`null_output` / `path_not_found` / `non_object_output` / `beyond_deps`；ref_path 缺省 = 整个 output；workflow-engine.ts 集成 step 5.5 collectedInputData 局部 const）+ WP-C3（独立纯函数模块 `prompt-inject.ts` + spawnReadyNode step 5.6 集成：叠加注入到 prompt 数组 `''` 后 `'Your task:'` 前；4 类 missing 全部 skip + distinct audit reason；体积保护 5000 per-entry + 20000 total cap；appendNodeLog executionPhase: 'input_injected'；scenario-26 DB 级集成测试 3 cases 端到端验证）。

**核心约束守恒**：引用 ⊆ dependencies schema + 运行期双重强制；输出收集按依赖图聚合 completed 节点；叠加注入（worker_config.prompt 原位不动）；数据流不引入新 ready 阻塞（纯同步）；注入可审计（executionPhase + audit details）；体积可控（5000/20000 cap）。scenario-26 DB 级集成测试 PASS；全量 DAG 回归 369/369 + DAG core 53/53 + typecheck 0 errors。

**INFO 已知限制（review P2 级别，不阻塞）**：workflow-engine.ts 的 `injected && injectionBlock.length > 0` 双重判断冗余；prompt-inject.test.ts 2 个 single-use helper 可 inline；`injectResult.audit.filter(...).length` 重复计算 2 次。均为 P2 micro-optimization，可后续补强。

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

### 3.1 [特性 A] running 节点续跑语义 — **已决策：首版重跑**（用户 2026-06-08 确认）

进程重启时，处于 running 的节点其子 session 对话中断在半途。续跑有两种路径：

| 方案 | 含义 | 代价 | 复杂度 |
|---|---|---|---|
| **重跑（已选）** | 节点状态经状态机归位 pending，重新 spawn（丢弃半截对话） | 浪费已完成的部分算力 | 简单 |
| **resume 子 session（保留为后续优化）** | `ops.loop({sessionID: childSessionId})` 接续子 session loop | 省算力 | 需判断子 session 能否仍产出 `node_complete` |

**决策**：首版用**重跑**——节点状态经状态机归位到 pending/queued（合法转移），由现有 scheduleReadyNodes/ spawnReadyNode 重新 spawn。子 session 半截对话丢弃，不做 resume。resume 语义作为后续优化项，不阻塞 WP-A3。

### 3.2 [特性 B] required 节点 + 条件不满足 — **已决策：方案 1，required 禁止 condition**（用户 2026-06-08 确认）

"required 不可跳过"是四铁律之一。但若 required 节点声明了条件且条件不满足，存在语义冲突：

- **方案 1（已选）**：required 节点禁止声明 condition（schema 校验拒绝）——铁律优先，最清晰
- ~~**方案 2**：required + 条件不满足 → 工作流失败（required 必达，条件不满足即视为不可达）~~
- ~~**方案 3**：条件跳过的 required 节点不计入"必达"集（弱化 required 语义）~~——**不推荐**（破坏铁律）

**决策**：方案 1——schema 校验在 createWorkflow / validateWorkflowConfigLimits（`limits.ts`）阶段拒绝 `required && condition` 同时存在的节点配置；非法配置直接返回 clear error 不进入 DB。用户写错了会得清晰错误消息（reason = "required node cannot declare condition" 或等价）。条件节点默认 non-required，required 节点默认无条件执行。

### 3.3 [特性 D] sub-DAG 递归深度上限 + 父子桥机制 — **已决策：事件桥 + 深度 ≤ 3**（用户 2026-06-08 确认）

- **递归深度上限（已选）**：**深度 ≤ 3**（允许父→子→孙三层嵌套，超过 3 层 schema 拒绝）。平衡表达力与复杂度——超过 3 层基本是设计错误；深度 2 表达力受限，深度 5 复杂度显著上升难以调试。schema 校验阶段强制（在 createWorkflow / replan / validateWorkflowConfigLimits 入口）。
- **父子桥机制（已选）**：**事件桥**——子工作流 `maybeFinalizeWorkflow` 收敛时发事件（需新事件类型如 `workflow.completed`/`workflow.failed`/`workflow.cancelled`），父节点订阅。父节点订阅事件 + 状态机转移 + 取消级联（父取消时级联取消子工作流）。

**决策理由**：
- 事件桥与现有 EventBus 架构一致（`IEventBus` / `SharedEventBusTag` 已就绪）
- 不占 fiber（父节点 fiber 启动子工作流后即可释放 fiber，由事件驱动状态转移）
- 解耦父子工作流生命周期（vs 轮询占 fiber + tight coupling）
- 取消级联通过订阅 `workflow.cancelled` 事件实现（子工作流监听父状态事件）

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

#### WP-A1 — dag/layer 注入 SessionPrompt.Service ✅ 已完成

`dagQueryLayer` Effect.gen 中 `yield* SessionPrompt.Service` 取得 headless promptOps 能力引用（无 eager 调用）；`defaultLayer` pipe 末显式 `Layer.provide(SessionPrompt.defaultLayer)` 解析 sibling（非扁平数组，因 server.ts 扁平数组不 cross-wire 兄弟）。依赖方向 dag→session 无循环（prompt.ts 对 dag 模块 0 import）；对外 Tag 形状（DAGQueryTag / SharedEventBusTag / WorktreeManagerTag）不变；现有 `recoverOrphanedWorkflows` 签名未动。验收：装配 smoke 2/2 PASS + recovery.test.ts 4/4 PASS + 全量 DAG session 227/227 PASS + typecheck 0 errors。

地基承载：`packages/opencode/src/dag/layer.ts`（dagQueryLayer + defaultLayer 注释注明 ~20 transitive deps 的 memo 语义与 cross-wire）+ `packages/opencode/src/dag/__tests__/layer-session-prompt.test.ts`（2 smoke，含 die-on-call mock 防 eager 调用）。

#### WP-A2 — recovery 续跑装配 ✅ 已完成

`recoverOrphanedWorkflows(service, promptOps?: PromptOps)` 签名扩展（向后兼容）；assembly 入口守卫 `WorkflowEngine.get(wfId) !== undefined` 实现幂等（INFO 1）；`resumeOrphanWorkflow` 顺序装配：`WorkflowEngine.make → setPromptOps → fillConcurrency → registerEngine → scheduleReadyNodes → forkDetach createWorkflowExecutor`（**不调用 startWorkflow** 避免 running→running 非法转移；INFO 2 处理）；装配失败 `Effect.catchCause + tapError` 折叠为 false 后调用 `failOrphanWorkflow` 走现状语义（标 failed + violation + engine cleanup，不卡中间态）。layer.ts 从 `_promptSvc`（WP-A1 已捕获）构造 `PromptOps` adapter（无 turn 级泄漏；INFO 2 resolution）。新增 `setWorkflowConcurrency` export。scenario-23 三态：正常续跑 1 个孤儿→engine 重建+concurrency 填充+pending 节点进入调度；装配失败→fallback 标 failed+violation+节点级联转移；幂等→第二次调用 resumed=0 marked=0 engine 仍注册。验收：scenario-23 3/3 + recovery 4/4 归 + 全量 DAG session 230/230 + DAG 53/53 + typecheck 0 errors。

地基承载：`packages/opencode/src/dag/session/recovery.ts`（resumeOrphanWorkflow + failOrphanWorkflow + RecoverResult.resumed + promptOps optional 参数）+ `packages/opencode/src/dag/session/workflow-engine.ts`（setWorkflowConcurrency export）+ `packages/opencode/src/dag/layer.ts`（PromptOps adapter line 66-70）+ `packages/opencode/src/dag/session/__tests__/scenario-23-recovery-resume.test.ts`（3 tests）。

#### WP-A3 — running 节点续跑语义 ✅ 已完成

节点转移表扩展 `case "running"` 返回值添加 `"pending"`（`getValidNextSessionNodeStatuses` 内，不绕过 updateNodeStatus；铁律 #1 守恒；isNodeTerminalStatus 未修改；running/pending 均非终态；types.ts:43 注释标注 recovery reset 出处）。recovery.ts 新增 `resetRunningNodes` 内部函数，在 resumeOrphanWorkflow 装配时序的 step 4（registerEngine）之后、step 5（scheduleReadyNodes）之前调用——归位后节点立即被 scheduleReadyNodes 重新选中 spawn（INFO 2 处理，不依赖 daemon 兜底）。每个 running 节点调用 `service.updateNodeStatus` 经状态机验证 + `appendNodeLog` 追加 `executionPhase: 'recovery_reset'` 标记（INFO 5 处理，便于排查"为什么跑了两次"）。装配失败路径 failOrphanWorkflow 不含 resetRunningNodes 调用（失败隔离）。scenario-24 4 测试：running 归位 + 重新 spawn + 转移合法性 + 混合状态隔离；session-service.test.ts 既有 3 处断言同步更新（running→pending 从"非法"改为合法，不删除测试）。验收：scenario-24 4/4 + scenario-23 3/3 + recovery 4/4 + session-service 95/95 + 全量 DAG session 234/234 + DAG 53/53 + typecheck 0 errors。INFO 3（NodeEvent node.reset 事件发射）未实现——buildSessionNodeEvent 对 pending 返回 null（现状一致），archgate 标注为可选项；后续 WP 评估。INFO 4（子 session 孤儿 DB 记录）文档标注，"至少一次"语义可接受。

地基承载：`packages/opencode/src/dag/session/session-service.ts`（节点转移表 L81 case "running" 扩展）+ `packages/opencode/src/dag/session/recovery.ts`（resetRunningNodes 函数 + 装配时序 step 4.5）+ `packages/opencode/src/dag/session/types.ts`（节点状态转换注释追加 recovery reset）+ `packages/opencode/src/dag/session/__tests__/scenario-24-running-node-resume.test.ts`（4 测试）+ `packages/opencode/src/dag/session/__tests__/session-service.test.ts`（既有断言调整 3 处）。

---

### 特性 B — 条件分支

#### WP-B1 — DAGNodeConfig.condition 字段 + schema ✅ 已完成

`DAGNodeConfig` 新增可选 `condition?: DAGNodeCondition` 字段（结构化对象：`{ref_node: string, op: DAGConditionOp, value?: unknown}`，含白名单 8 ops union；INFO 1 设计决策）；新增 `DAGNodeCondition` interface + `DAGConditionOp` type + `DAG_CONDITION_OPS` readonly const（INFO 3 处理：用 `readonly string[]` + `as const`）。`limits.ts` 新增 `validateNodeCondition` helper 返回形态与 `validateWorkflowConfigLimits` 一致（`{ok:true} | {ok:false, reason}`）；覆盖缺省/null 兼容 + required↔condition 互斥（§3.2 方案 1 强制执行，reason = "required node cannot declare condition"）+ 非声明式拒绝（`typeof cond !== 'object' || Array.isArray(cond)`）+ ref⊆dependencies 强制（schema 层拒绝越界引用，不在运行期逃逸）+ op 白名单校验。`session-service.ts` createWorkflow 入口循环 per-node 调用；`workflow-engine.ts` validateReplanPostConfig 校验链添加同样验证步骤（INFO 2 处理，replanned config 不绕过互斥检查）。canonical 文档同步更新：`API.md` §8 DAG 配置类型（含 FallbackConfig.condition vs DAGNodeConfig.condition 语义差异表）+ `USER_GUIDE.md` DAGNodeCondition 小节 + 字段示例；`types.ts` DAGNodeCondition JSDoc 顶部注明差异（INFO 4 处理）。schema unit tests 18 cases：4 正向（eq/ne/exists/not_exists op 白名单命中）+ 2 ref 越界 + 2 required 互斥 + 7 非声明式/非法结构 + 3 缺省兼容。验收：18 schema tests + 252 全量 DAG session + 53 全量 DAG + 233 受影响回归 + typecheck 0 errors。INFO 1/2/3/4 全部处理。P4 INFO（review 建议）：null 显式测试 + gt/lt/gte/lte op 正向测试可后续补充（schema 白名单路径已被 eq 覆盖）。

地基承载：`packages/opencode/src/dag/session/types.ts`（DAGNodeCondition interface + DAG_CONDITION_OPS const + DAGNodeConfig.condition optional 字段，INFO 4 JSDoc 注明区别）+ `packages/opencode/src/dag/session/limits.ts`（validateNodeCondition helper）+ `packages/opencode/src/dag/session/session-service.ts`（createWorkflow 校验循环）+ `packages/opencode/src/dag/session/workflow-engine.ts`（validateReplanPostConfig 校验链扩展）+ `packages/opencode/src/dag/API.md`（§8 DAG 配置类型）+ `packages/opencode/src/dag/USER_GUIDE.md`（DAGNodeCondition 小节）+ `packages/opencode/src/dag/session/__tests__/node-condition-schema.test.ts`（18 tests，INFO 3 命名避开 scenario-25）。

#### WP-B2 — 条件求值挂到就绪判定 ✅ 已完成

独立纯函数模块 `condition-eval.ts`（仅 `import type` from `./types`，零 Effect/DB/Logger 依赖）：3 函数 + 1 接口。`evaluateCondition(condition, outputValue): boolean` 穷举 switch 覆盖 8 ops（`DAGConditionOp` 联合类型 TS 编译期强制完整白名单）；`buildOutputMap(allNodes): Map<nodeId, output>` 仅 completed 节点聚合 output；`splitByCondition(readyNodes, outputMap): ConditionEvalResult {executeList, skipCandidates}` 同步纯函数分流。8 ops null/missing 语义完整文档化（JSDoc 顶部表格）：`exists`/`not_exists` 明确针对 null 设计；`eq`/`ne` 用 null 严格比较；`gt`/`lt`/`gte`/`lte` null 视为缺失返回 false（auditable default，不抛异常）。挂点在 `scheduleReadyNodes` 内（line 914-915）：`getReadyNodes` 返回后、spawn 循环前调用 `splitByCondition`；spawn 循环（line 927/930）改为 iterate `executeList`。无 condition 节点（`cond == null`）保持 executeList（向后兼容）。`void skipCandidates` 显式标记前向占位（WP-B3 消费）。多节点求值相互独立（for-of loop 每节点独立 evaluateCondition）。`getWorkflowStatus` (line 1059-1109) 路径完全未触碰（INFO 2 honored）。56 tests 覆盖 8 ops × 真/假/null/缺失 + splitByCondition 三态路由 + buildOutputMap 纯投影 + 纯度验证。验收：56 条件求值 + 18 schema 回归 + 308 DAG session + 53 DAG core + typecheck 0 errors。purity grep 0 forbidden（3 matches 在 JSDoc，非代码引用）。INFO 1/2/3 均处理。

地基承载：`packages/opencode/src/dag/session/condition-eval.ts`（144 行，evaluateCondition + splitByCondition + buildOutputMap + ConditionEvalResult interface + 8 ops null 语义 JSDoc 表）+ `packages/opencode/src/dag/session/workflow-engine.ts`（scheduleReadyNodes 内 condition split + spawn 循环 iterate executeList）+ `packages/opencode/src/dag/session/__tests__/node-condition-eval.test.ts`（56 tests）。

#### WP-B3 — 条件不满足主动 skip + 下游级联 ✅ 已完成

`workflow-engine.ts` cascadeSkipDownstream 参数重命名 failedNodeId → triggerNodeId + 新增 triggerType 参数（`"upstream_failure" | "condition_false"`，默认 `"upstream_failure"` 向后兼容）；logData 键 failed_node_id → trigger_node_id + trigger_type；logMessage 区分 "failure" vs "condition skip"。scheduleReadyNodes 消费 skipCandidates（4 步：状态机 skip → createViolation(type: 'condition_skipped', details: {trigger: 'condition_false', condition}) → safeAppendLog(executionPhase: 'condition_skip') → cascadeSkipDownstream(triggerNodeId, 'condition_false')），spawn 前执行避免 running→skipped 非法转移。skipped 后调用 maybeFinalizeWorkflow（幂等守卫保证 scheduleReadyNodes + handleNodeCompletion 双调用点无竞态）。types.ts DAG_VIOLATION_TYPES 新增 "condition_skipped" 枚举（数组 append 向后兼容）；i18n.ts VIOLATION_TYPE_LABEL 新增 en/zh 翻译（Record<DAGViolationType, string> 类型完整）。审计双轨：条件节点自身 condition_skip（executionPhase）+ condition_skipped（violation type）；级联下游cascade_skip（executionPhase，保持原名）+ trigger_type 区分来源；violation.details 嵌套 {trigger, condition: {ref_node, op, value}} 承载完整条件信息（INFO I2 处理）。node.skipped 事件 upstream_failed_node 留空，区分信息由 violation.details 承载。级联语义一致：与失败级联共用 findPendingDescendants BFS 拓扑算法（INFO I3 共享下游重叠场景自动过滤已 skipped 节点）。scenario-25 6 tests 覆盖：单节点 skip + 下游级联 + 多依赖不误跳 + 终态收敛 + 共享下游重叠 + 条件 vs 失败对比。Test 3/5 fixture 用 ROOT 前置节点单阶段设计（规避 latent defects）。archgate 7 项约束全 honored：状态机经 sessionService.updateNodeStatus（铁律 #1）；skipped 是终态不可回退（铁律 #2）；pending→skipped 合法转移；required 由 WP-B1 schema 拦截；maybeFinalizeWorkflow 收敛不阻塞；复用 findPendingDescendants；violation + log 双轨审计。验收：454 tests（scenario-25 6 + B1/B2 74 + scenario-22/23/24 14 + DAG session 314 + DAG core 53）+ typecheck 0 errors。INFO I1-I4 全处理。Latent defects（pre-existing 不在 WP-B3 scope）：getReadyNodes 不过滤 skipped 节点；updateNodeStatus throw 在 Effect.sync 内变 defect——skippedNodeIds 集合 + inFlight filter + 状态机拒绝 skipped→running 形成三层防护屏障，latent defects 不影响 WP-B3 功能正确性。

地基承载：`packages/opencode/src/dag/session/workflow-engine.ts`（cascadeSkipDownstream 参数泛化 + scheduleReadyNodes skipCandidates 消费 + maybeFinalizeWorkflow 幂等）+ `packages/opencode/src/dag/session/types.ts`（DAG_VIOLATION_TYPES 扩展 "condition_skipped"）+ `packages/opencode/src/cli/cmd/tui/feature-plugins/dag-workflow/i18n.ts`（VIOLATION_TYPE_LABEL condition_skipped translation）+ `packages/opencode/src/dag/session/__tests__/scenario-25-conditional-skip.test.ts`（6 测试）。

---

### 特性 C — 数据流

#### WP-C1 — DAGNodeConfig.input_mapping 字段 + schema ✅ 已完成

`DAGNodeConfig` 新增可选 `input_mapping?: DAGInputMapping` 字段（Record 形式：`Record<inputKey, DAGInputMappingEntry>`；每条 entry 含 `{ref_node: string, ref_path?: string}`；INFO 1 选型理由 JSDoc 标注：避免 inputKey 重复 + O(1) 查找 + schema 迭代简洁；INFO 3 命名惯例 DAGInputMappingEntry + DAGInputMapping 与 DAGNodeCondition 一致）。`limits.ts` 新增 `validateInputMapping` helper 与 `validateNodeCondition` 同构（`{ok:true} | {ok:false, reason}` 形态）：缺省/null 兼容（返回 `{ok: true}`）+ 整体 Record + 每个 entry 校验为纯对象（结构性检查拒绝闭包/函数/数组/string/number）+ ref⊆dependencies 强制（reason = "input_mapping refs must ⊆ dependencies: ref_node '<x>' not in dependencies [...]"）+ ref_path 类型合法（string | undefined，运行期缺失语义 deferred to WP-C2，INFO 2 处理）。`session-service.ts` createWorkflow 入口循环调用；`workflow-engine.ts` validateReplanPostConfig 校验链添加步骤（archgate 约束 4）。canonical 文档同步：`API.md` 新增 §DAGInputMapping 章节（技术参考 + 校验规则表 + 运行期语义注释）；`USER_GUIDE.md` 新增"数据映射"章节（字段表 + JSON 示例 + 配置示例 + 与 condition 关系说明），章节结构与 WP-B1 同构。ReplanNodePatch 通过 `Partial<Omit<DAGNodeConfig, 'id'|'dependencies'>>` 类型自动支持 input_mapping，类型层面零代码开销。schema unit tests 17 cases：4 合法 + 3 越界 + 7 非法语法（闭包/函数/数组/string/number/ref_path 非 string）+ 3 缺省兼容。验收：17 schema + 331 DAG session + 53 DAG core + 618 受影响测试 + typecheck 0 errors。INFO 1/2/3 全处理。review INFO 1（limits.ts:15 unused import type）P2 不阻塞——`import type` 仅在 JSDoc 引用，符合 AGENTS.md 文档用途允许。

地基承载：`packages/opencode/src/dag/session/types.ts`（DAGInputMappingEntry interface + DAGInputMapping type alias + DAGNodeConfig.input_mapping optional 字段 + JSDoc 选型理由）+ `packages/opencode/src/dag/session/limits.ts`（validateInputMapping helper）+ `packages/opencode/src/dag/session/session-service.ts`（createWorkflow 校验循环）+ `packages/opencode/src/dag/session/workflow-engine.ts`（validateReplanPostConfig 校验链扩展）+ `packages/opencode/src/dag/API.md`（DAGInputMapping 新章节）+ `packages/opencode/src/dag/USER_GUIDE.md`（数据映射新章节）+ `packages/opencode/src/dag/session/__tests__/node-input-mapping-schema.test.ts`（17 tests）。

#### WP-C2 — 上游 output 收集 ✅ 已完成

独立纯函数模块 `input-mapping-collector.ts`（201 行，仅 `import type { DAGInputMapping } from "./types"`，零 Effect/DB/Logger/emit 依赖）。`collectInputMapping(inputMapping, outputMap, nodeDeps): CollectedInputMap`（INFO 1(c) 方案：caller 提供 outputMap，复用 `buildOutputMap(allNodes)` 的产物，收集器自身不调用 DB/listNodes）。`Record<inputKey, CollectedValue {value, __missing?}>` 数据结构，WP-C3 读取 __missing 决策注入策略。4 类运行期缺失去语义完整：(a) `output == null → __missing: 'null_output'`；(b) `ref_path` 不存在 → `'path_not_found'`（resolvePath 纯函数 + unique symbol sentinel PATH_NOT_FOUND 避免 false-positive）；(c) `output` 非 object + ref_path 存在 → `'non_object_output'`（string/number/boolean/array 全覆盖防御性处理不 crash）；(d) `ref_node ∉ dependencies` → `'beyond_deps'`（运行期 defense-in-depth，与 WP-C1 schema 静态拦截双重防线）。ref_path 缺省 = 取整个 output（string/number/array 原样返回，INFO 2 处理）。JSDoc 完整标注 4 类缺失去语义表格（line 26-33 + line 49-61）。workflow-engine.ts 集成极轻量（line 15 import；line 489 spawnReadyNode 加 outputMap? 可选参数；line 659 step 5.5 collectedInputData 局部 const；line 1003 scheduleReadyNodes 传 outputMap 给 spawnReadyNode）—— collectedInputData 当前未消费（由 WP-C3 prompt 注入点消费），不修改 prompt 构造（line 651-660 留给 WP-C3）。21 tests 9 场景全覆盖：正常路径 / ref_path 缺省 / output null / ref_path 不存在 / 非 object output / beyond_deps / 混合 / input_mapping undefined 兼容 / 纯度验证（不 mutate outputMap + 幂等 + 引用隔离）。archgate 7 项约束全 honored：纯函数零副作用（purity grep 0 forbidden）；ref_node ∈ deps 运行期强制；ref_path 缺省取整个 output；4 类缺失去语义明确 + JSDoc 文档化；不引入 ready 阻塞；不写 DB/emit/log；数据结构与 WP-C3 兼容。INFO 1/2/3 全处理。review INFO 1（collectedInputData 不消耗 by design INFO 不阻塞）。验收：21 + 352 DAG session + 62 workflow-engine + 53 DAG core + typecheck 0 errors。

地基承载：`packages/opencode/src/dag/session/input-mapping-collector.ts`（201 行，collectInputMapping + 内部 resolvePath pure + PATH_NOT_FOUND sentinel + OutputMissingReason + CollectedValue + CollectedInputMap + JSDoc 4 类缺失去语义表）+ `packages/opencode/src/dag/session/workflow-engine.ts`（spawnReadyNode outputMap? + step 5.5 collectedInputData）+ `packages/opencode/src/dag/session/__tests__/node-input-mapping-collect.test.ts`（21 tests）。

#### WP-C3 — prompt/input 注入 ✅ 已完成

独立纯函数模块 `prompt-inject.ts`（187 行，仅 `import type { CollectedInputMap } from "./input-mapping-collector"`，零 Effect/DB/Logger/mutable state 依赖）。`injectCollectedDataToPrompt(collectedInputData): InjectionResult`（返回 `{injectionBlock: readonly string[], audit: readonly InjectionAuditEntry[], injected: boolean}`）—— caller inserts block 模式（不合并 merged prompt）。4 类运行期缺失去语义完整 + JSDoc 文档化：null_output / non_object_output / path_not_found / beyond_deps → 全部 skip + distinct audit reason。注入格式：JSON 序列化 + delimiter 块（`=== Collected Input Data ===` / `=== End Collected Data ===`）+ 每行 `[inputKey]: <JSON-serialized-value>`。体积保护：`PER_ENTRY_CHAR_CAP = 5000`（超则截断 + `...[truncated N chars]` 后缀 + audit status 'truncated'）+ `TOTAL_PAYLOAD_CHAR_CAP = 20000`（超则剩余 entry 全 drop + audit status 'skipped' reason 'payload_overflow'）。向后兼容：无 input_mapping 节点 → collectedInputData 空 → 函数 early return `{injectionBlock: [], audit: [], injected: false}`（零开销）。workflow-engine.ts 集成点 L16 import + L665-697 step 5.6：调用 helper（L668）→ if (injected || audit.length > 0) appendNodeLog(executionPhase: 'input_injected', logData: {audit, injectedCount})（L677）→ prompt 数组 spread（L691-695 位置：`[DAG 指令, '', ...injectionBlock, 'Your task:', worker_config.prompt]`，INFO 3 处理 + 不替换 worker_config.prompt）。scenario-26 DB 级集成测试 3 cases 端到端：Test A 正常（上游 completed → 下游 prompt 含 `[upstreamResult]: <data-from-A>` + audit 记录 injected）+ Test B null_output（上游 output null → 下游 injectionBlock 空 + audit 记录 skipped reason 'null_output'）+ Test C 无 input_mapping（下游 collectedInputData 空 → prompt 完全不变向后兼容）。14 unit tests（prompt-inject.test.ts 未修改，覆盖 9 scenarios：正常 3 / 4 类 missing 4 / 体积截断 2 / 混合 1 / 空 2 / 纯度 2）+ 3 DB 集成测试 + 全量 DAG 回归 369/369 + DAG core 53/53 + typecheck 0 errors。archgate 6 项约束全 honored：叠加注入（prompt 数组 spread 不替换）/ 无 input_mapping 节点 prompt 完全不变 / 注入内容可审计（appendNodeLog 执行）/ 4 类 missing 不注入（helper 内处理）/ 不引入 ready 阻塞（纯同步）/ executionPhase snake_case 'input_injected'。纯度验证：prompt-inject.ts grep 0 forbidden keywords（Effect/DB/Logger/emit/console.log/TODO/StateMachine），仅 import type。INFO 1-4 全处理。review INFO 4 项均为 P2 级别冗余/可 inline，不阻塞。

地基承载：`packages/opencode/src/dag/session/prompt-inject.ts`（187 行，4 类 missing policy table JSDoc + volume protection + injection format 自文档化 + injectCollectedDataToPrompt + InjectionStatus + InjectionAuditEntry + InjectionResult）+ `packages/opencode/src/dag/session/workflow-engine.ts`（spawnReadyNode step 5.6 集成）+ `packages/opencode/src/dag/session/__tests__/prompt-inject.test.ts`（14 tests）+ `packages/opencode/src/dag/session/__tests__/scenario-26-data-flow.test.ts`（3 DB 级集成测试）。

---

### 特性 D — sub-DAG

#### WP-D1 — startWorkflowFromConfig 去 Tool.Context 化 ✅ 已完成

独立 headless core 函数模块 `core-start.ts`（172 行，仅 import 自 dag/session/* 同域模块，0 Tool.Context / 0 Core path / 0 DB schema 变更）。`bootstrapWorkflowFromConfig({dagConfig, dagSessionService, agentRegistry, chatSessionId, promptOps, abortSignal, parentWorkflowId?, parentNodeId?}): BootstrapWorkflowResult`——参数化形式 + object literal（与 codebase 既有风格一致；命名避开 WorkflowEngine.startWorkflow 接口方法，INFO-4 honored）。7 步启动序列完整封装：Step1 RequiredNodesValidator（console.warn 合规 INFO-5）+ Step2 validateWorkerTypes（迁入 core，INFO-1 honored）+ Step3 dagSessionService.createWorkflow + Step4 dagSessionService.createNode *N（namespace `${workflowId}::${nodeId}`）+ Step5 WorkflowEngine.make + setPromptOps + Step6 registerEngine + WorkflowEngine.startWorkflow（status→running）+ Step7a forkDetach createWorkflowExecutor + Step7b abortSignal.addEventListener onAbort。`tool/dagworker.ts` 重构为 22 行 thin adapter（ctx 解构 → promptOps 提取 + guard → bootstrapWorkflowFromConfig 调用 → 透传返回），单一来源 grep 验证 0 matches（createWorkflow/createNode/RequiredNodesValidator/registerEngine/setPromptOps/forkDetach/addEventListener.abort）。validateWorkerTypes + WorkerTypeAgentRegistry 从 dagworker.ts 迁出但 re-export 保持向后兼容（dagworker.test.ts 3 tests 不回归）。abortSignal.addEventListener 注册时序 L178 forkDetach < L185 addEventListener 明确保持，确保 daemon 已启动 cancelWorkflow 调用时可达。4 unit tests（core-start.test.ts：headless happy path + DB 验证 + abort wired + validateWorkerTypes 正/负 + validator pass-through）。archgate 5 项约束全 honored：单一来源（grep 0）/ core 函数签名无 Tool.Context 泄漏（grep 0 Tool import）/ abort 时序正确 / 工具路径向后兼容（签名形态保留 + 返回类型保留 + re-export 兼容）/ 状态变更全经 dagSessionService + WorkflowEngine API（不绕过状态机，铁律 #4）。INFO 1-5 全处理。review INFO 3 项（P4 恒真断言 validator pass-through / P5 pre-existing EffectBridge import / P5 inline type import 风格）不阻塞。验收：core-start 4/4 + dagworker 3/3 + DAG session 373/373 + DAG core 53/53 + typecheck 0 errors。

地基承载：`packages/opencode/src/dag/session/core-start.ts`（172 行，bootstrapWorkflowFromConfig + validateWorkerTypes + WorkerTypeAgentRegistry + BootstrapWorkflowResult type + 7 步 sequence JSDoc + INFO-1/2/3/4/5 处理说明 + 调用方文档）+ `packages/opencode/src/tool/dagworker.ts`（startWorkflowFromConfig 重构为 thin adapter 22 行；re-export validateWorkerTypes + WorkerTypeAgentRegistry；清理孤儿 import）+ `packages/opencode/src/dag/session/__tests__/core-start.test.ts`（4 tests）。

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
