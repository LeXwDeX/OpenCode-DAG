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

**定位**: DAG 引擎基础模块，管理 Workflow / Node / ShadowNode 三种实体的状态生命周期。被 scheduler、group-manager 和 session 依赖。

**核心接口**: IStatePersister, IEventBus, IWorkflowStateMachine, INodeStateMachine

**状态枚举**: `WorkflowStatus`（7 值）, `NodeStatus`（8 值，含 QUEUED）, `ShadowNodeStatus`（4 值）— 详见 `state-machine/types.ts`

**转换规则**: 由 `state-machine/errors.ts` 中 `getValidNextWorkflowStatuses()` / `getValidNextNodeStatuses()` 定义

### 1.5 NodeStateMachine 实现

**定位**: 节点级状态管理的具体实现类，与 `WorkflowStateMachine` 平级，提供 Node/ShadowNode 独立生命周期管理。NodeStateMachine 是 Core 层的节点级状态执行器，提供**纯内存（或可选持久化）+ 事件驱动**的状态转移能力。**当前仅被其自身单元测试及 `index.ts` exports 消费**；Scheduler 和 session-service 各自独立实现状态逻辑，仅在事件类型层面依赖 `state-machine/types`。定位为**工具路径/扩展层入口**，待上层按需接入（如 CLI、test harness、影子执行）。

**核心职责**:
- 节点状态转移验证（调用 `getValidNextNodeStatuses()` 强制 Iron Law #1）
- 终态不可逆保障（调用 `isNodeTerminalStatus()` 强制 Iron Law #2）
- 节点事件广播（emit `node.started` / `node.completed` / `node.failed` / `node.reset` 等 Iron Law #3）
- 节点状态持久化（通过 `INodeStatePersister` 扩展接口，rollback 模式 Iron Law #4）
- 节点注册 + 复位 + 跳过 + push/fallback 计数

**设计要点**:
- 构造函数注入：`workflowId`（必需）+ `eventBus?` + `persister?` 可选，符合 §0.1
- `resetNode()` 设计为 admin bypass（类比 `WorkflowStateMachine.updateStatus()`），跳过 #1/#2 验证但保留 #3/#4
- `skipNode()` 严格 from-status 验证，仅允许 PENDING/QUEUED → SKIPPED
- `persistAndApply()` 私有 helper：统一的 persist → catch → throw → memory → emit 模式，消除代码重复
- FAILED 作为半终态：`getValidNextNodeStatuses(FAILED)` 返回 `[RUNNING, ABORTED]`（允许 fallback retry）
- 本地 `INodeStatePersister extends IStatePersister` 不污染公共接口（接口隔离原则）

**接口签名**: 详见 `state-machine/IStateMachine.ts::INodeStateMachine`（11 个公共方法）

**测试覆盖**: 45 个测试按 4 条铁律 + 核心功能分组（含 5 个 Shadow 节点集成测试）

## 2. group-manager 模块

**定位**: 层级管理模块，负责 Group → Sub-Group → Branch 多层级结构，维护 Group 间依赖关系。被 scheduler 依赖（获取可执行 Group 顺序）。

**核心接口**: IGroupManager, IDependencyGraph（Kahn 拓扑排序 + DFS 三色环检测）, IGroupStatePersister（可选）

**关键约束**:
- 嵌套深度 ≤ 5 层（`MAX_NESTING_DEPTH`）
- 依赖无环保证（`addEdge` 前 `wouldCreateCycle` 预检）
- 配置继承：子 Group 自动继承父 Group 的 `env` / `fallback` / `worktree`
- 删除原子性：两阶段设计（先全量校验后执行）

**事件**: `GroupEvent`（`group.created` / `group.removed` / `group.state_changed` / `branch.state_changed`）

## 3. worktree-manager 模块

**定位**: 文件隔离模块，基于 Git Worktree 为每个并行工作流提供独立文件隔离环境。被 group-manager 可选依赖。

**核心接口**: IWorktreeManager, IWorktreePersister（可选）

**关键约束**:
- autoCleanup：状态变更到 completed/failed/cancelled 时自动触发 `cleanup()`（异步不阻塞）
- 依赖 Git CLI，模块内禁止直接修改 `.git/worktrees/`
- emit 签名扩展：`emit(event: WorkflowEvent | NodeEvent | GroupEvent | WorktreeEvent)`

**事件**: `WorktreeEvent`（`worktree.created` / `worktree.deleted` / `worktree.status_changed` / `worktree.merged` / `worktree.conflict`）

## 4. scheduler 模块

**定位**: 执行调度模块，在 state-machine + worktree-manager 之上提供节点生命周期管理和执行调度。

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
| Workflow 状态数 | 7 | 5 | 无 paused/archived（DB 层简化视图） |
| Node 状态数 | 8 | 6 | 无 aborted（shadow 概念不属 DB 层） |
| PENDING→FAILED | ❌ 禁止 | ✅ 允许 | 支持取消前未完成的工作流标记失败 |
| FAILED→RUNNING | ✅ 允许 | ❌ 不允许 | DB 层无 fallback_rerun 语义 |

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
   影子执行 / 外部集成                    (WorkflowEngine)
```

**关键点**:
- **IEventBus 共享**: 两条路径共享同一 IEventBus 实例（D-PLAN 决策）
- **事件统一**: emit 同一套 `workflow.*` / `node.*` 事件类型（无 `dag:*` 前缀）
- **隔离机制**: listener 按 `workflow_id` 字段过滤（不是事件类型前缀），参见 `__tests__/DualPathIsolation.test.ts`

### 8.b 状态类型归属表

| 层 | 类型 | 枚举值数 | 用途 |
|----|------|---------|------|
| Core | `WorkflowStatus` | 7（PENDING / RUNNING / PAUSED / COMPLETED / FAILED / CANCELLED / ARCHIVED） | 状态机内部工作流状态 |
| Core | `NodeStatus` | 8（含 ABORTED） | 状态机内部普通节点状态 |
| Core | `ShadowNodeStatus` | 4（PENDING / RUNNING / COMPLETED / FAILED） | 状态机内部 Shadow 节点状态 |
| Session | `DAGWorkflowStatus` | 5（无 PAUSED / ARCHIVED） | DB 持久化工作流状态（简化版） |
| Session | `DAGNodeStatus` | 6（无 ABORTED） | DB 持久化节点状态（简化版） |

**差异原因**:
- Session 层省略 `PAUSED` / `ARCHIVED`（DB 无需区分暂停/归档）
- Session 层省略 `ABORTED`（DB 不维护 Shadow 节点特殊状态）
- Core 与 Session 状态转移规则**独立实现**（`getValidNextWorkflowStatuses` vs `getValidNextSessionWorkflowStatuses`），非共享函数，符合 §1.5 中描述的架构意图

### 8.c 上层选择路径的判定准则

| 场景 | 推荐路径 | 理由 |
|------|---------|------|
| **DAG 生产执行**（workflow-engine） | Session | 需要 SQLite 持久化 + Effect 包装 |
| **CLI 工具**（如 dagworker 命令） | Session | 生产场景，需 DB 持久化 |
| **单元测试 / 集成测试** | Core | 纯内存，无 SQLite 依赖，速度快 |
| **影子执行**（dry-run / 预览） | Core | 工具场景，不需要 DB 持久化 |
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

更多设计决策详见 `.task_state/dag-completion/taskplan.md` 与 `.task_state/findings.md`。

---

*最后更新: 2026-06-05*
