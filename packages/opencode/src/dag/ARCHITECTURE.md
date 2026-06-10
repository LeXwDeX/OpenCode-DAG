<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
-->

# DAG 工作流引擎架构

## 0. 跨模块设计模式约束（所有模块必须遵守）

本节定义 DAG 引擎所有模块必须遵守的统一设计模式。

### 0.1 构造函数参数一致性

```typescript
constructor(
  requiredDependency: IRequiredInterface,  // 必需依赖在前
  optionalDependency?: IOptionalInterface   // 可选依赖在后（带 ?）
)
```

### 0.2 事件广播统一模式

所有模块共享同一 `IEventBus` 实例，通过 `eventBus.emit()` 广播。禁止在模块内部实现自定义事件通道。

### 0.3 持久化辅助方法模式

所有需要持久化的模块提供 `persist()` 私有方法。无 persister 时静默跳过；持久化失败时抛出 `XxxStateNotPersistedError` 阻止内存状态更新。

### 0.4 跨模块类型桥接模式

模块广播自定义事件类型时使用 `as unknown as WorkflowEvent | NodeEvent` 桥接。禁止 `as any`。

### 0.5 设计模式合规性检查表

| 检查项 | 标准 |
|--------|------|
| 构造函数参数顺序 | 必需在前，可选在后 |
| IEventBus 共享 | 构造函数注入，不自定义 on() |
| IEventBus 参数可选性 | `eventBus?: IEventBus` |
| persist() 辅助方法 | 无 persister 时静默跳过 |
| 类型桥接模式 | `as unknown as WorkflowEvent \| NodeEvent` |
| 错误命名模式 | `XxxStateNotPersistedError` |

## 模块依赖关系

```
state-machine ← scheduler / worktree-manager / group-manager / session ← query
                     ↑                          ↑                         ↑
              worktree-manager ──────→ group-manager（可选）       persistence
```

**循环依赖**: 无。group-manager 可选依赖 worktree-manager，worktree-manager 不依赖 group-manager。

## 1. state-machine 模块

> ⚠️ **本节描述 Core 内部状态机实现，全部为 Capability reservoir，未装配生产路径。** 其中 `ShadowNodeStatus` / `NodeType.SHADOW`（Shadow 节点）是状态机的**内部子状态**，**生产路径不可见、不可被编排为节点类型**——编排只使用 `worker_type`（见 API.md 节点配置）。

**定位**: DAG 引擎基础模块，管理 Workflow / Node 的状态生命周期（Node 含一个 Core 内部的 Shadow 子状态机，仅供 reservoir 场景使用）。

**装配状态**: 类型（`WorkflowStatus` / `NodeStatus` / `ShadowNodeStatus` / `errors.ts` 转换函数、`IEventBus`）被 scheduler、group-manager、session 引用；`NodeStateMachine` / `WorkflowStateMachine` 实现类为 **Capability reservoir**，未装配到生产路径（生产路径使用 Session 层的 `session-service` + `WorkflowEngine`）。详见 §8 与 §12。

**核心接口**: IStatePersister, IEventBus, IWorkflowStateMachine, INodeStateMachine

**状态枚举**: `WorkflowStatus`（7 值）, `NodeStatus`（8 值，含 QUEUED）, `ShadowNodeStatus`（4 值）— 详见 `state-machine/types.ts`

**转换规则**: 由 `state-machine/errors.ts` 中 `getValidNextWorkflowStatuses()` / `getValidNextNodeStatuses()` 定义

### 1.5 NodeStateMachine 实现

- **NodeStateMachine**：节点级状态管理的具体实现类，提供纯内存+事件驱动的 Node/ShadowNode 独立生命周期管理（约束由地基代码承载 — 接口 `INodeStateMachine` @ `IStateMachine.ts:265-312`，实现 `NodeStateMachine` @ `NodeStateMachine.ts:40`，测试 124 pass @ `state-machine/*.test.ts`）

## 2. group-manager 模块

**定位**: 层级管理模块，负责 Group → Sub-Group → Branch 多层级结构，维护 Group 间依赖关系。

**装配状态**: 类型（`IGroupManager` / `IDependencyGraph` / `GroupEvent`）被 scheduler 引用（获取可执行 Group 顺序）；`GroupManager` 实现类为 **Capability reservoir**，未装配到生产路径。详见 §11。

**核心接口**: IGroupManager, IDependencyGraph（Kahn 拓扑排序 + DFS 三色环检测）, IGroupStatePersister（可选）

**关键约束**:
- 嵌套深度 ≤ 5 层（`MAX_NESTING_DEPTH`）
- 依赖无环保证（`addEdge` 前 `wouldCreateCycle` 预检）
- 配置继承：子 Group 自动继承父 Group 的 `env` / `fallback` / `worktree`
- 删除原子性：两阶段设计（先全量校验后执行）

**事件**: `GroupEvent`（`group.created` / `group.removed` / `group.state_changed` / `branch.state_changed`）

## 3. worktree-manager 模块

**定位**: 文件隔离模块，基于 Git Worktree 为节点提供独立文件隔离环境。被 group-manager 可选依赖。

**装配状态**: **已接入生产路径**（opt-in）。`worktreeManagerLayer`（`layer.ts:41`）经 `defaultLayer`（`layer.ts:125`）装配为单例；`spawnReadyNode`（`workflow-engine.ts:874-911`）在节点配置 `worker_config.use_worktree === true` 时运行时调用 `create()` / `cleanup()`（默认关闭，commit `c80861d32` 引入）。注意：它**不是** Capability reservoir，与 §12 中 state-machine/scheduler/group-manager 的"未装配"定位不同。

**核心接口**: IWorktreeManager, IWorktreePersister（可选）

**关键约束**:
- autoCleanup：状态变更到 completed/failed/cancelled 时自动触发 `cleanup()`（异步不阻塞）
- 依赖 Git CLI，模块内禁止直接修改 `.git/worktrees/`
- emit 签名扩展：`emit(event: WorkflowEvent | NodeEvent | GroupEvent | WorktreeEvent)`

**事件**: `WorktreeEvent`（`worktree.created` / `worktree.deleted` / `worktree.status_changed` / `worktree.merged` / `worktree.conflict`）

## 4. scheduler 模块

**定位**: 执行调度模块，在 state-machine + worktree-manager 之上提供节点生命周期管理和执行调度。

**装配状态**: **Capability reservoir**。`Scheduler` 实现类当前无生产调用方（生产路径使用 `WorkflowEngine`）。保留理由：为未来"工具路径 / Group 级并发调度"等场景提供备选调度能力。详见 §12。

**核心接口**: IScheduler, INodeExecutor（外部注入执行器，禁止硬编码）

**核心职责**: 节点状态管理 → 状态持久化 → 事件广播 → 执行调度 → 错误恢复

**依赖**:
- 上游: state-machine（状态枚举 + 转换规则）, worktree-manager（可选）
- 下游: DAG 引擎核心, 上层调度器/服务

## 5. session 模块

**定位**: DB 运行时持久化层，是 Core 层（state-machine）面向 SQLite 的投影。使用 Effect 模式包装同步 DB 操作。

**核心接口**: `DAGSessionService`（Effect.gen 工厂）, `WorkflowEngine`（调度编排）, `RequiredNodesMonitor`（违规检测）

**与 Core 层的关系**: Session 层维护自己的简化类型系统（`DAGWorkflowStatus` / `DAGNodeStatus`），有意省略 Core 层的 `paused`/`archived`/`aborted` 等高级状态。两层状态转换规则通过 `getValidNextSessionWorkflowStatuses()` / `getValidNextSessionNodeStatuses()` 独立维护，**非共享函数**，但语义保持一致。

**铁律执行**:
- 铁律 #1: `updateWorkflowStatus` / `updateNodeStatus` 先读当前状态 → 验证转移合法性
- 铁律 #2: 终态返回空数组 `[]`，阻断逆转
- 铁律 #3: `setEventBus(bus?: IEventBus)` 模块级注入，状态变更后 `eventBus.emit()` 对应 dot notation 事件
- 铁律 #4: SQLite DB-first 写入（Effect.sync 包装）

**关键差异（有意设计，非遗漏）**:
| 差异点 | Core 层 | Session 层 | 原因 |
|--------|---------|-----------|------|
| Workflow 状态数 | 7 | 6（P2 扩展） | 含 paused（P2 pause/resume 需要 DB 持久化）；无 archived |
| Node 状态数 | 8 | 6 | 无 aborted（shadow 概念不属 DB 层） |
| PENDING→FAILED | ❌ 禁止 | ✅ 允许 | 支持取消前未完成的工作流标记失败 |
| FAILED→RUNNING | ✅ 允许 | ❌ 不允许 | DB 层无 fallback_rerun 语义 |
| RUNNING→PAUSED | ✅ 允许 | ✅ 允许（P2） | P2 pause/resume 需要 Session 层支持暂停 |
| PAUSED→RUNNING | ✅ 允许 | ✅ 允许（P2） | P2 pause/resume 需要 Session 层支持恢复 |

**事件注入**: `setEventBus()` 是模块级 setter（非构造函数注入），因为 Effect.gen 工厂模式下构造函数注入不自然，属于 §0.1 的合理变通。

## 6. persistence 模块

**定位**: SQLite schema 定义层，使用 Drizzle ORM 声明式定义 DAG 运行时数据模型。

**表结构**（6 表）:

| 表名 | 职责 | 命名规范 |
|------|------|---------|
| `dagWorkflows` | 工作流元数据 + 状态 | snake_case ✅ |
| `dagNodes` | 节点元数据 + 状态 | snake_case ✅ |
| `dagViolations` | 违规记录 | snake_case ✅ |
| `dagWorkflowHistory` | 工作流状态变更历史 | camelCase ⚠️ |
| `dagNodeLogs` | 节点执行日志 | camelCase ⚠️ |
| `dagSchemaVersions` | Schema 版本管理 | camelCase ⚠️ |

**依赖**: 无 DAG 内部依赖，被 session 模块引用。

## 7. query 模块

**定位**: 只读查询 API，提供时间线、统计、搜索等仪表盘能力。

**核心接口**: `IDAGQuery`（`listWorkflows` / `getWorkflow` / `getNodeStatus` / `getExecutionTimeline` / `listWorkflowsByStatus` / `searchWorkflows`）

**依赖**: session-service（数据来源）。

## 8. Core 路径 vs Session 路径（职责划分）

DAG 模块采用**双路径设计**：Core 路径（内存/工具）与 Session 路径（DB/生产）**刻意隔离**，上层按需选择。

### 8.a 调用关系图

```
┌──────────────────────────────────────────────────────────────────┐
│                       IEventBus (共享)                            │
└──────────────────────────────────────────────────────────────────┘
        │                                          │
        ▼                                          ▼
┌──────────────────────┐                 ┌──────────────────────┐
│   Core 路径 (工具)    │                 │  Session 路径 (生产)  │
├──────────────────────┤                 ├──────────────────────┤
│ WorkflowStateMachine │                 │   session-service    │
│  ├─ WorkflowStatus   │                 │  ├─ DAGWorkflowStatus│
│  └─ persist?: opt.   │                 │  └─ DB: SQLite      │
│                      │                 │                      │
│ NodeStateMachine     │                 │   WorkflowEngine     │
│  ├─ NodeStatus       │                 │  ├─ DAGNodeStatus   │
│  └─ persist?: opt.   │                 │  └─ DB: SQLite      │
└──────────────────────┘                 └──────────────────────┘
        ▲                                          ▲
        │                                          │
   CLI / test harness /                    DAG 生产执行
   外部集成                                (WorkflowEngine)
```

**关键点**:
- **IEventBus 共享**: 两条路径共享同一 IEventBus 实例（D-PLAN 决策）
- **事件统一**: emit 同一套 `workflow.*` / `node.*` 事件类型（无 `dag:*` 前缀）
- **隔离机制**: listener 按 `workflow_id` 字段过滤（不是事件类型前缀），参见 `__tests__/DualPathIsolation.test.ts`

### 8.b 状态类型归属表

> 注：本表 **Core 行**（`WorkflowStatus` / `NodeStatus` / `ShadowNodeStatus`）均为 Core 状态机**内部**类型，**生产路径不可编排**；其中 `ShadowNodeStatus` 是 Core 内部 Shadow 子状态机。生产实际使用 **Session 行**的 `DAG*Status`。

| 层 | 类型 | 枚举值数 | 用途 |
|----|------|---------|------|
| Core | `WorkflowStatus` | 7（PENDING / RUNNING / PAUSED / COMPLETED / FAILED / CANCELLED / ARCHIVED） | 状态机内部工作流状态 |
| Core | `NodeStatus` | 8（含 ABORTED） | 状态机内部普通节点状态 |
| Core | `ShadowNodeStatus` | 4（PENDING / RUNNING / COMPLETED / FAILED） | 状态机内部 Shadow 节点状态 |
| Session | `DAGWorkflowStatus` | 6（含 PAUSED，P2 扩展；无 ARCHIVED） | DB 持久化工作流状态（P2 需暂停语义） |
| Session | `DAGNodeStatus` | 6（无 ABORTED） | DB 持久化节点状态（简化版） |

**差异原因**:
- Session 层 P2 起支持 `PAUSED`（DB 需区分暂停/运行/终态，用于 pause/resume 控制面）
- Session 层省略 `ARCHIVED`（DB 无归档生命周期需求）
- Session 层省略 `ABORTED`（DB 不维护 Shadow 节点特殊状态）
- Core 与 Session 状态转移规则**独立实现**（`getValidNextWorkflowStatuses` vs `getValidNextSessionWorkflowStatuses`），非共享函数，符合 §1.5 中描述的架构意图

### 8.c 上层选择路径的判定准则

| 场景 | 推荐路径 | 理由 |
|------|---------|------|
| **DAG 生产执行**（workflow-engine） | Session | 需要 SQLite 持久化 + Effect 包装 |
| **CLI 工具**（如 dagworker 命令） | Session | 生产场景，需 DB 持久化 |
| **单元测试 / 集成测试** | Core | 纯内存，无 SQLite 依赖，速度快 |
| **外部集成**（如 MCP 调用方） | 视场景 | 需 DB 持久化选 Session，纯内存选 Core |
| **Test harness**（CI/CD 测试框架） | Core | 纯内存，易 mock |

**反模式（禁止）**:
- ❌ 同一进程混用 Core + Session 处理**同一 workflow_id**（状态同步复杂度爆炸）
- ❌ session-service 调用 `NodeStateMachine.transition()`（破坏隔离设计）
- ❌ WorkflowEngine 调用 `WorkflowStateMachine.transition()`（生产路径应经 session-service）

**允许混用场景**:
- ✅ 同一进程实例化 Core + Session，但**不同 workflow_id**（通过 IEventBus 按 workflow_id 隔离）
- ✅ 单元测试中同时使用两路径验证 EventBus 兼容性（参见 `__tests__/DualPathIsolation.test.ts`）

### 8.d 集成模式示例

#### 模式 1：生产 DAG 执行（Session 路径）

```typescript
const service = yield* DAGSessionService.make  // DB-backed
setEventBus(bus)                                // 注入共享 EventBus

yield* service.createWorkflow({ ... })
yield* service.updateWorkflowStatus(workflowId, 'running')
yield* service.createNode({ ... })
yield* service.updateNodeStatus({ ..., status: 'running' })
```

#### 模式 2：单元测试 / Test harness（Core 路径）

```typescript
const bus = new EventBus()
const wsm = new WorkflowStateMachine('test-1', bus, mockPersister)
const nsm = new NodeStateMachine('test-1', bus, mockNodePersister)

wsm.initialize(WorkflowStatus.PENDING)
await wsm.transition({ fromStatus: PENDING, toStatus: RUNNING, transition: ENGINE_START })
await nsm.registerNode('test-1', 'main', 'step-1', false)
await nsm.transition({ workflowId: 'test-1', nodeName: 'step-1', fromStatus: PENDING, toStatus: COMPLETED, transition: DAG_COMPLETED })
```

#### 模式 3：双路径共存（同进程，不同 workflow_id）

```typescript
const bus = new EventBus()

// Core 路径处理 workflow-A（测试/预览）
const coreWsm = new WorkflowStateMachine('workflow-A', bus)
coreWsm.initialize(WorkflowStatus.PENDING)

// Session 路径处理 workflow-B（生产）
setEventBus(bus)
const sessionService = yield* DAGSessionService.make
yield* sessionService.createWorkflow({ chatSessionId: 'sess', name: 'workflow-B', ... })

// listener 按 workflow_id 区分
bus.subscribe('workflow.started', (event) => {
  if (event.workflow_id === 'workflow-A') {
    // Core 路径处理
  } else if (event.workflow_id === 'workflow-B') {
    // Session 路径处理
  }
})
```

### 8.e 设计决策记录

| ID | 决策 | 理由 | 时间 |
|----|------|------|------|
| **D-PLAN** | NodeStateMachine 定位为独立 Core 层状态转移执行器（工具/扩展入口） | YAGNI + 接口隔离 + 单一职责；不强行集成 Scheduler | 2026-06-05 |
| **D-PLAN-反** | 不做 Scheduler 与 NodeStateMachine 强行集成 | 会破坏 Core/Session 刻意隔离；当前生产路径稳定 | 2026-06-05 |
| **N-1** | Core 与 Session 共享 EventBus 时按 `workflow_id` 字段过滤（不是事件类型前缀） | 事件类型统一为 `workflow.*` / `node.*`，无 `dag:*` 前缀（archgate advisory） | 2026-06-05 |
| **D1** | FAILED 作为半终态（允许 → RUNNING / ABORTED） | 地基代码 `errors.ts` 锚定 | 2026-06-05 |
| **D6** | `node.reset` 纳入 NodeEvent union（方案 C） | admin bypass 仍应发事件（保留铁律 #3/#4） | 2026-06-05 |
| **D7** | 不提升 writeNodeState / readNodeState 到公共 IStatePersister | 接口隔离；仅 NodeStateMachine 自身使用 | 2026-06-05 |
| **D-PAUSE-SESSION** | Session 层扩展 `DAGWorkflowStatus` 加入 `'paused'`；HTTP 层新增 §10 DAG Mutation API（pause/resume POST endpoint） | P2 pause/resume 控制面需要 DB 持久化暂停状态；§5「有意省略」假设不再成立；Core 与 Session 状态转移规则仍独立实现；HTTP 写操作通过独立的 §10 DAG Mutation API 路由（绕过 §9 只读约束）| 2026-06-07 |
| **D-PLAN-RETIRE** | **Core 三实现类退役 + Session 为唯一生产真相源**：NodeStateMachine / WorkflowStateMachine / Scheduler / GroupManager 实现类退出 reservoir，Session 路径提纯为 A 层(纯逻辑) + B 层(运行时) + C 层(观察控制面复用聚合)。保留 state-machine/{EventBus,IStateMachine,types}.ts + group-manager/types.ts + worktree-manager/{types,IWorktreeManager,WorktreeManager}.ts（生产强依赖）。ARCHIVED/ABORTED/ShadowNodeStatus/node PAUSED 随实现类退役（不进 A 层真相源）。详见 `.task_state/task_plan_dag_integration.md`。 | 用户目标=干净边界+可观察/探针/控制。Core 三模块与 Session 范式级错配(Promise vs Effect/fiber, Group/Branch vs 扁平 node)不可直接复用；生产已用更成熟方式实现 Core 设想的全部能力(重试/暂停/中止)。archgate 两轮校验 PASS 方向。 | 2026-06-09 |

更多设计决策详见 `.task_state/dag-completion/taskplan.md` 与 `.task_state/findings.md`。

## 9. bridge 模块（DAG 内部事件 → 平台 Bus 单向桥接）

**定位**：把 DAG 内部 `IEventBus` 上的 `workflow.*` / `node.*` 事件**单向、只读**地翻译发布到平台 Effect `Bus`，使 OpenCode TUI / SDK 等外部订阅者能通过统一的 `dag.workflow.*` / `dag.node.*` 事件收到 DAG 运行时变化。**禁止任何反向回写**。

**包**：`src/dag/bridge/`（独立子模块）
- `dag-bus-bridge.ts`：`DagEventBridge` 类
- `dag-events.ts`：用 `Effect.Schema.Struct` + `BusEvent.define()` 声明到平台总线的事件清单

### 9.a 职责边界

| 允许 | 禁止 |
|------|------|
| 订阅 DAG `IEventBus` 全品类事件 | 任何对 `WorkflowEngine` / `session-service` 的写操作 |
| 按 §9.c 规则转换为 `BusEvent.define()` 事件并 `Bus.publish()` | 修改 DAG 内存状态 / SQLite 表 / `IEventBus` 事件流 |
| 提供 `subscribe(bus)` / `dispose()` 生命周期方法 | 为每个 `DAGWorkflowSession` 创建独立订阅（必须按 `workflow_id` 过滤） |
| 在 server 启动时由 server 层挂载 | 从 TUI / SDK 进程直连（必须经 server） |
| 暴露 `DagEventBusEvent` payload schema（含 `workflow_id` / `node_id?` / `status` / 时间戳） | 把 DAG 内部类型（`WorkflowEvent` / `NodeEvent` 枚举值）原样转发到平台 Bus（必须翻译） |

### 9.b 事件命名约定（翻译规则）

| DAG 内部事件 | 平台 Bus 事件 | payload 关键差异 |
|--------------|--------------|-----------------|
| `workflow.created/started/completed/failed/cancelled/paused/resumed` | `dag.workflow.updated` | payload 含 `workflow_id`、`status: DAGWorkflowStatus`、`chat_session_id`；paused/resumed 为 P2 扩展 |
| `node.started/completed/failed/paused/resumed/restarted/aborted/skipped` | `dag.node.updated` | payload 含 `workflow_id`、`node_id`、`status: DAGNodeStatus`、`chat_session_id?` |
| `node.progress` | `dag.node.progress` | payload 含 `node_id`、`progress` 数值/消息 |
| `node.ask_main` | `dag.node.ask_main` | payload 含 `node_id`、`question` |
| `node.timeout` / `node.reset` / `node.pushed` / `node.registered` | 不转发 | 内部调度事件，无需扩散 |

> 合并策略：多个 DAG 终态事件合并为单一 `updated` 是为了**保护状态机权威**——平台侧只关心"状态变过了"，不关心"DAG 内部是怎么走完状态转移的"。具体状态转移规则的唯一真相源是 §1 state-machine。

### 9.c 隔离与订阅策略

- 全局**单例** `DagEventBridge`，在 server 进程启动时 `subscribe(bus)` 一次，进程退出时 `dispose()` 释放
- 订阅 DAG `IEventBus` 的 `*` 通配（或逐一订阅所有事件），按 `event.workflow_id` 字段过滤，**不按事件类型前缀**（与 §8.a 双路径隔离规则同形）
- TUI 侧用现有 `api.event.on("dag.node.updated", …)` 过滤 `workflow_id === activeWorkflow` 即可

### 9.d 反模式（禁止）

- ❌ 桥接层调用 `WorkflowEngine.updateNodeStatus()` 反向写状态
- ❌ 桥接层绕过状态机直接 `DB.insert/update`（破坏四铁律 #1）
- ❌ 把 `workflow.failed_with_violations` 等已删除状态重新引入（参见 history）
- ❌ TUI 直连 DAG SQLite（跨进程 + 状态机边界）
- ❌ 为每个 workflow 实例化独立 bridge（内存/订阅数爆炸）

### 9.e 依赖关系

```
bridge ← IEventBus（共享实例，来自 §0.2 注入规范）
      ← @/bus（平台 Bus.publish / BusEvent.define）
      ← effect/Schema（仅用于 payload 声明）

DAGQuery ← session-service（只读数据来源，与 bridge 无直接依赖）

server/routes/dag（新增 HTTP 路由组） ← DAGQuery（注入为 Effect 服务）
                                      ← DagEventBridge（进程启动时挂上共享 IEventBus）
```

**HTTP 写操作状态（P1-补 后状态）**: 
- `server/routes/dag`（§9 只读路由）：提供 `listWorkflows` / `getWorkflow` / `getNodeStatus` / `getExecutionTimeline` / `searchWorkflows` 等只读 endpoint，绑定 `DAGQuery`。**严禁任何写操作**。
- `server/routes/dag/control`（§10 Mutation 路由，P2 引入）：提供 `POST /pause/:workflowId`、`POST /resume/:workflowId` 等控制 endpoint，直接绑定 `WorkflowEngine.pauseWorkflow` / `resumeWorkflow`（绕过 `DAGQuery` 只读边界）。

> 创建/启动/取消 workflow 等操作仍经由 `WorkflowEngine` 的 tool 层调用（`dagworker` tool），不经过 HTTP；§10 Mutation API 仅暴露暂停/恢复控制面。

## 10. DAG Mutation API（P2 扩展：HTTP 写操作控制面）

**定位**：P2 pause/resume 需求引入的 HTTP 控制 API。与 §9 bridge 只读层并列，专用于**workflow 生命周期控制操作**。

**包**：`src/server/routes/instance/httpapi/` 下新增 `groups/dag-mutation.ts` 与 `handlers/dag-mutation.ts`（flat file 模式，与现有 `groups/dag.ts` / `handlers/dag.ts` 一致；独立子路由组，与 §9 只读路由分离）

### 10.a 职责边界

| 允许 | 禁止 |
|------|------|
| 提供 POST /pause/:workflowId、POST /resume/:workflowId 等控制 endpoint | 状态机直接修改（必须经 `WorkflowEngine.pauseWorkflow` / `resumeWorkflow`） |
| 直接绑定 `WorkflowEngine`（非 `DAGQuery`） | 任何 SQLite 直接读写（必须经 `WorkflowEngine` 内部调用 `session-service`） |
| Effect 风格 handler（`Effect.fn("DagMutation.<method>")`） | 绕过状态机合法性校验 |
| 接受来自 TUI / 外部集成方 / 调度器的控制请求 | 接受来自 `dagworker` tool 的请求（tool 层直接调用 `WorkflowEngine`，不经过 HTTP） |

### 10.b Endpoint 清单

| Method | Path | Handler | 绑定的 `WorkflowEngine` 方法 |
|--------|------|---------|---|
| POST | `/dag/workflows/:workflowId/pause` | `DagMutation.pause` | `pauseWorkflow(workflowId)` |
| POST | `/dag/workflows/:workflowId/resume` | `DagMutation.resume` | `resumeWorkflow(workflowId)` |

**扩展策略**：未来如需 `cancel` / `restart` 等操作，按同一模式加入 `dag-mutation` 路由，保持与 §9 只读路由完全分离。

### 10.c Session 层状态扩展（P2 配套）

#### 10.c.1 `DAGWorkflowStatus` 扩展（workflow 级）

| 类型 | 扩展前 | 扩展后 | 影响 |
|------|--------|--------|------|
| `session/types.ts:DAGWorkflowStatus` | 5 值（无 `paused`） | 6 值（含 `paused`） | DB schema 加列（见 §10.d） |
| `getValidNextSessionWorkflowStatuses('running')` | `[completed, failed, cancelled]` | `[completed, failed, cancelled, paused]` | Session 状态机合法集扩展 |
| `getValidNextSessionWorkflowStatuses('paused')` | 不存在 | `[running, cancelled]` | 新增状态转移规则 |
| `buildSessionWorkflowEvent` switch | 无 `paused` case | 加 `paused` case（触发 `workflow.paused` 事件） | Bridge 已支持（§9.b 表格更新） |

#### 10.c.2 `DAGNodeStatus` 不变（node 级）

**关键设计决策（Option A）**：`DAGNodeStatus` **不扩展**，仍是 6 值（pending/queued/running/completed/failed/skipped，无 `paused`）。

**理由**：
- pause 是 workflow-level 操作，node-level 状态变化不符合 §8.b 状态类型归属表（Session Node 状态数固定在 6）
- Option C no-interrupt 协议（§10.e）下，pausing workflow 不中断 running 节点；pending 节点只需"不被 dispatch 直到 resume"，不需新增 `paused` 状态
- 避免扩展 `DAGNodeStatus` 需要同步更新 Core 层 `NodeStatus`（8→9 值）、`getValidNextSessionNodeStatuses`、`buildSessionNodeEvent` 等多处，违反最小变更原则

#### 10.c.3 只读 response schema 同步扩展

`server/routes/instance/httpapi/groups/dag.ts:21` 的 `DagWorkflowStatus = Schema.Literals(["pending", "running", "completed", "failed", "cancelled"])` 也必须加 `"paused"`，否则 GET endpoint 返回 paused 状态的 workflow 时 schema 校验失败。

#### 10.c.4 Bus event payload schema 同步扩展

`bridge/dag-events.ts` 中 `DAGWorkflowStatusSchema`（定义 `dag.workflow.updated` payload 中的 status 字段）也必须加 `"paused"`，否则 workflow.paused → dag.workflow.updated 翻译后 platform Bus 接收端 schema 校验失败。

### 10.d Drizzle Schema 扩展（P2 配套，sync 模式）

`packages/opencode/src/dag/persistence/schema.ts` 中 `dagWorkflows` 表新增 Drizzle 列：

```typescript
paused_at: integer(),      // Unix timestamp (ms), nullable
resumed_at: integer(),     // Unix timestamp (ms), nullable
```

**Drizzle 字段命名约定**（AGENTS.md style guide）：
- TS 字段名用 **snake_case**（`paused_at`、`resumed_at`），与 `created_at`、`started_at`、`completed_at` 一致
- SQL 列名从 TS 字段名自动推断（Drizzle 默认行为），无需显式指定字符串参数
- **禁止**使用 camelCase TS 字段名（如 `pausedAt`）+ SQL 列名（如 `'paused_at'`）的混合风格，违反 AGENTS.md snake_case 唯一约定

**注意**：本项目使用 Drizzle sync 模式（`drizzle().sync()`），**不使用 SQL migration 文件**。schema 变更通过直接修改 `schema.ts` 实现，运行时由 Drizzle 自动同步到 SQLite。

### 10.e Fiber 中断协议（P2 配套 — Option A + Option C）

`workflow-engine.ts` 中 `Effect.forkDetach(spawnReadyNode)` 创建的 fiber **不支持强制中断**（`Effect.InterruptFiber` 会破坏 spawnReadyNode 主流程）。

**P2 策略**：采用 **Option A（节点状态不变）+ Option C（无强制中断）** 组合：

#### 10.e.1 设计选择
- **Option A**（§10.c.2）：`DAGNodeStatus` 不扩展，节点保持原状态
- **Option C**：禁止对 `spawnReadyNode` fiber 强制中断

#### 10.e.2 实现语义
- pause 操作**仅更新 workflow 状态**（`session-service.updateWorkflowStatus(workflowId, 'paused')`），**不改变任何 node 状态**
- 正在 `running` 的节点继续完成（不被中断），完成后按正常逻辑触发下游节点调度
- `spawnReadyNode` 入口新增 `workflow.paused` 标志检查（workflow-engine.ts 在 spawnReadyNode 入口处读取 `workflow.status`）：
  - 若 `workflow.status === 'paused'`，spawnReadyNode **提前 return**，pending 节点**保持 pending 状态不变**
  - **不触发**任何 node 事件（因为 node 状态未变化）
- resume 操作：`updateWorkflowStatus(workflowId, 'running')` 后，`spawnReadyNode` 入口检查通过，pending 节点按正常逻辑被 dispatch
- 已 dispatch 但未进入 spawnReadyNode 主体的 fiber：在入口处检查 `workflow.status` 后提前 return

**禁止操作**：
- ❌ 对 `spawnReadyNode` fiber 调用 `Effect.interrupt()`
- ❌ 强制 kill sub-agent 子进程
- ❌ 修改 `DAGNodeStatus` 为 7 值（违反 §8.b 状态归属表）
- ❌ 在 pause/resume 时触发 `node.paused` / `node.resumed` 事件（`DAGNodeStatus` 无该状态）
- ❌ 让 pending 节点"假性转为 paused"（不存在该状态转换，必须保持 pending 直到被 dispatch 或 workflow 取消）

### 10.f 与 §9 bridge 的关系

`workflow.paused` / `workflow.resumed` 事件通过 §9 bridge 单向转发到平台 Bus（已在 §9.b 事件命名表中登记）。§10 Mutation API **不**直接向 bridge 写事件；事件由 `WorkflowEngine.pauseWorkflow` 内部触发（经 `session-service.updateWorkflowStatus` → `emit('workflow.paused')` → bridge → 平台 Bus）。

### 10.g 与 `dagworker` tool 的关系

`dagworker` tool（`src/tool/dagworker.ts`）是 LLM 调度入口，直接调用 `WorkflowEngine.pauseWorkflow` / `resumeWorkflow`（不经过 HTTP）。§10 HTTP Mutation API 与 `dagworker` tool **并行存在**，共用同一个 `WorkflowEngine` 服务：

```
LLM tool:    dagworker tool → WorkflowEngine.pauseWorkflow  (tool 层直连)
HTTP client: POST /pause/:id → DagMutation.pause → WorkflowEngine.pauseWorkflow  (HTTP 层路由)
TUI button:  调用 HTTP API (POST /pause/:id)
```

两者通过 `WorkflowEngine` 内部同步（单 `WorkflowEngine` 实例，按 workflow_id 隔离）。

## 11. 节点↔子会话绑定（点节点进上下文的字段约定）

**定位**：TUI 「点节点进入子 agent 会话并递归下钻」的唯一契约字段。

**字段**：`DAGNodeSession.metadata.chat_session_id: string | undefined`

**写入方**：`WorkflowEngine` / `worker` 在 dispatch 节点给 subagent 时，必须把 OpenCode 创建的子会话 `SessionID` 立即写入该节点的 `metadata.chat_session_id`，并持久化到 SQLite（`dag_node.metadata` JSON 列）。

**约束**：
- 字段名固定为 `chat_session_id`（禁止 `sessionId` / `subSessionId` 等别名）
- 写入必须在节点进入 `RUNNING` 之前或同时（保证 TUI 首次拉取时已可用）
- 未绑定子会话的节点（如纯函数 worker）：字段为 `undefined`，TUI 降级为 `node-dialog` 日志视图
- 不新增独立字段，复用现有 `metadata` JSON 列

## 12. Core 路径定位说明（Capability Reservoir Doctrine）

> ⚠️ **本 Doctrine 已有批准的退役方向（D-PLAN-RETIRE, §8.e, 2026-06-09）**。三实现类（NodeStateMachine / WorkflowStateMachine / Scheduler / GroupManager）将退出 reservoir，Session 路径提纯为单一真相源三层架构。在退役 WP 实际执行并完成后，本节将重写为稳态架构描述。**退役尚未执行前，下列约束仍然有效**。

**背景**: `state-machine/`、`group-manager/`、`scheduler/` 中的实现类（`NodeStateMachine`、`WorkflowStateMachine`、`GroupManager`、`Scheduler`）在代码库中存在但**未装配到生产路径**。生产路径使用 `session-service` + `WorkflowEngine`（Session 路径，§5）。

> 注：`worktree-manager/` 的 `WorktreeManager` **不在此列**——它已 opt-in 装配进生产路径（详见 §3）。本节 Doctrine 仅约束上述 3 个仍未装配的模块。

**这些实现类不是死代码**。它们被设计为 **Capability reservoir**（能力储备池）。

> ⚠️ 以下"未来场景"表 **已因 D-PLAN-RETIRE（§8.e, 2026-06-09）失效**——Core 实现类批准退役后，这些场景不会以 Core 路径模块方式实现。保留此表仅为历史参考，不构成新开发指导。

| 场景 | 使用的 Core 路径模块 | 理由 | 状态 |
|------|----------------------|------|------|
| ~~工具路径（MCP 外部调用）~~ | ~~Core 路径~~ | — | **失效**（D-PLAN-RETIRE） |
| ~~丰富状态转移（`FAILED→RUNNING` 重试）~~ | ~~`state-machine`~~ | — | **失效**（生产用 running→pending 重试） |
| ~~层级调度（Group 级并发）~~ | ~~`GroupManager`~~ | — | **失效**（D-PLAN-RETIRE） |

**类型共享规则**: Core 路径的**类型**（枚举、接口、错误类）被 Session 路径引用（例如 `WorkflowStatus` / `IEventBus`），这是有意设计。仅**实现类**（具体 `new Xxx(...)` 调用）保持隔离。

**禁止操作**:
- ❌ 从 `workflow-engine.ts`（Session 路径）直接 `new NodeStateMachine(...)`
- ❌ 从 `session-service.ts` 调用 Core 路径实现类的 `transition()` 等方法
- ❌ 删除 Core 路径实现类（**D-PLAN-RETIRE 已批准退役方向**；退役 WP 执行时此条被豁免，但必须遵守退/留判定表中的"必留资产"边界）
- ✅ Core 路径类型（`WorkflowStatus` / `NodeStatus` / `IGroupManager` 接口定义等）可被 Session 路径引用

**判定流程**:
1. 是类型/接口/枚举引用？ → ✅ 允许
2. 是 `new Xxx()` 实例化？ → ❌ 禁止（除非新建 D-PLAN-xxx 设计决策并经 archgate 审批）

---

*最后更新: 2026-06-09（D-PLAN-RETIRE 退役方向批准 + §12 Doctrine 更新）*
