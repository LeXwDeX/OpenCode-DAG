# DAG 工作流引擎架构

## 0. 跨模块设计模式约束（所有模块必须遵守）

本节定义 DAG 引擎所有模块必须遵守的统一设计模式约束。任何模块开发前必须先对照本节检查合规性。

### 0.1 构造函数参数一致性

**约束**：所有模块的构造函数必须遵循统一的参数模式。

**模式定义**：
```typescript
constructor(
  requiredDependency: IRequiredInterface,  // 必需依赖放前面
  optionalDependency?: IOptionalInterface  // 可选依赖放后面（带 ?）
)
```

**具体规则**：
- `IEventBus` 参数：**可选**（`eventBus?: IEventBus`）— 模块可在无事件总线时独立运行
- `IStatePersister` 类参数：**可选**（`persister?: IStatePersister`）— 持久化是增强功能，非核心职责
- 必需依赖（如 `state-machine` 实例）：放参数列表前面
- 可选依赖（如 `persister`、`eventBus`）：放参数列表后面

**已建立的模式**：
- `WorkflowStateMachine`：`constructor(stateMachine, eventBus?)`
- `GroupManager`：`constructor(eventBus?, persister?)`
- `WorktreeManager`：`constructor(eventBus?, persister?)` ← **必须遵守**

### 0.2 事件广播统一模式

**约束**：所有模块共享同一个 `IEventBus` 实例，通过 `eventBus.emit()` 广播事件。**禁止在模块内部实现自定义的 `on()` / `subscribe()` 事件订阅方法**。

**正确模式**：
```typescript
export class MyManager {
  constructor(private eventBus?: IEventBus) {}
  
  private someMethod() {
    // 正确：通过共享的 eventBus 广播
    this.eventBus?.emit(event as unknown as WorkflowEvent | NodeEvent)
  }
}
```

**错误模式**（禁止）：
```typescript
export class MyManager {
  private handlers: Set<(event: any) => void> = new Set()
  
  // 错误：自定义 on() 方法
  public on(handler: (event: any) => void) {
    this.handlers.add(handler)
  }
  
  // 错误：模块内部广播
  private emit(event: any) {
    this.handlers.forEach(h => h(event))
  }
}
```

**理由**：
- 统一事件总线便于调试（单个 `subscribe()` 入口监听所有事件）
- 避免事件孤岛（模块自定义的事件系统无法被外部统一订阅）
- 符合依赖反转原则（模块不持有事件订阅者列表）

### 0.3 持久化辅助方法模式

**约束**：所有需要持久化的模块必须提供 `persist()` 私有辅助方法，遵循统一的错误处理模式。

**模式定义**：
```typescript
private async persist(persister?: IPersister): Promise<void> {
  if (!persister) return  // 可选依赖：不提供时静默跳过
  
  try {
    await persister.save(this.stateData)
  } catch (error) {
    // 抛出统一的错误类型，阻止上层内存状态更新
    throw new XxxStateNotPersistedError(error)
  }
}
```

**调用时机**：状态变更后立即调用（遵守"持久化优先"铁律）

### 0.4 跨模块类型桥接模式

**约束**：当模块需要广播自己定义的事件类型时，使用 `as unknown as` 桥接到 IEventBus 接受的基础类型。

**模式定义**：
```typescript
// 模块定义自己的事件类型
export type ModuleEvent = { type: 'module.specific', data: any }

// 广播时使用 as unknown as 桥接
this.eventBus?.emit(
  moduleEvent as unknown as WorkflowEvent | NodeEvent
)
```

**理由**：
- IEventBus 基础签名是 `emit(event: WorkflowEvent | NodeEvent)`
- 各模块事件类型（GroupEvent、WorktreeEvent 等）与基础类型结构不同
- `as unknown as` 是 TypeScript 中跨类型桥接的标准做法
- 未来可演进为泛型 `IEventBus<T = WorkflowEvent | NodeEvent>`

### 0.5 设计模式合规性检查表

**任何模块开发前必须检查**：

| 检查项 | 符合标准 | 当前状态 |
|--------|---------|---------|
| 构造函数参数顺序 | 必需在前，可选在后 | ✅ state-machine / group-manager / worktree-manager |
| IEventBus 共享 | 通过构造函数注入，不自定义 on() | ✅ state-machine / group-manager / worktree-manager |
| IEventBus 参数可选性 | `eventBus?: IEventBus`（可选） | ✅ group-manager / worktree-manager |
| persist() 辅助方法 | 提供私有 persist()，无 persister 时静默跳过 | ✅ state-machine / group-manager / worktree-manager |
| 类型桥接模式 | `as unknown as WorkflowEvent | NodeEvent` | ✅ group-manager / worktree-manager |
| 错误命名模式 | `XxxStateNotPersistedError` | ✅ state-machine / group-manager / worktree-manager |

## 1. state-machine 模块

### 1.1 宏观定位

state-machine 是 DAG 引擎基础模块，被 scheduler 与 group-manager 依赖。管理 Workflow、Node、ShadowNode 三种实体的状态生命周期，提供持久化接口由上层注入实现。

### 1.2 核心接口边界

- **IStatePersister**：状态持久化接口，读写 state.json 中 Workflow / Node 状态，由上层实现（原子写入，支持缓存）
- **IEventBus**：事件总线接口，发布状态变化事件，支持通配符订阅；状态机 emit，上层 subscribe
- **IWorkflowStateMachine**：Workflow 状态管理（`getStatus()` / `transition()`），内部封装合法性验证，严格遵循持久化优先原则
- **INodeStateMachine**：Node / ShadowNode 状态管理（`transition()` / `getNodeState()` / `getSchedulableNodes()`），同时支持节点注册与重置

### 1.3 状态机铁律

1. **状态机不可绕过**：所有 Workflow / Node / Shadow 状态变化必须经状态机 API，禁止直接修改 state.json
2. **终态不可逆**：Workflow 终态（COMPLETED / FAILED / CANCELLED / ARCHIVED）及 Node 终态（COMPLETED / FAILED / ABORTED / SKIPPED）达成后，禁止再次 transition()
3. **事件必须广播**：每次 transition() 必须通过 IEventBus 发出对应 WorkflowEvent / NodeEvent，不可静默变更
4. **状态持久化优先**：transition() 顺序为"先写 state.json → 成功后广播事件"；持久化失败时回滚内存状态并通过错误标识通知上层

### 1.4 开发规约

- **事件命名**：本模块使用引擎级命名（`workflow.*` / `node.*`），TAB 级命名（`dag.*`）由 scheduler 做映射转换
- **状态枚举**（详见 `types.ts`）：
  - `WorkflowStatus`（7 值）：PENDING / RUNNING / PAUSED / COMPLETED / FAILED / CANCELLED / ARCHIVED
  - `NodeStatus`（7 值）：PENDING / RUNNING / PAUSED / COMPLETED / FAILED / ABORTED / SKIPPED
  - `ShadowNodeStatus`（4 值）：PENDING / RUNNING / COMPLETED / FAILED
- **转换规则**：参考 `errors.ts` 中 `getValidNextWorkflowStatuses()` 与 `getValidNextNodeStatuses()`；普通节点与 Shadow 节点使用不同规则分支
- **错误类型**（均继承 `StateMachineError`）：
  - 非法转换：`InvalidWorkflowTransitionError` / `InvalidNodeTransitionError`
  - 终态违规：`WorkflowTerminalViolationError` / `NodeTerminalViolationError`
  - 持久化失败：`ErrorCode.STATE_NOT_PERSISTED`（通过错误码标识，暂无独立 Error class）

## 2. group-manager 模块

### 2.1 宏观定位

group-manager 是 DAG 引擎的层级管理模块，负责管理 Group → Sub-Group → Branch 多层级结构，维护 Group 间依赖关系。被 scheduler 依赖（获取可执行 Group 顺序），依赖 state-machine（状态变更通过状态机 API 执行）。

本模块自身是内存态管理，持久化由外部调用者通过 IGroupStatePersister 接口实现（可选注入）。

### 2.2 核心接口边界

- **IGroupManager**：Group 生命周期管理接口（CRUD / 状态变更 / 依赖管理 / Worktree 集成 / 配置继承 / 并发控制）
- **IDependencyGraph**：依赖图数据结构接口（节点 / 边 / 查询 / 拓扑排序 / 环检测 / 序列化），支持 Kahn 拓扑排序与 DFS 三色环检测
- **IGroupStatePersister**：Group 状态持久化接口（可选依赖），由上层实现，GroupManager 通过该接口在状态变更前持久化

### 2.3 铁律合规

group-manager 完全遵守 state-machine 定义的 4 条状态机铁律：

1. **状态机不可绕过**：所有 Group / Branch 状态变更必须通过 `updateGroupStatus()` / `updateBranchStatus()` API，内部先合法性验证、再持久化、再更新内存、再广播事件
2. **终态不可逆**：Group 终态（COMPLETED / FAILED / CANCELLED）达成后，再次调用 transition 抛出 `GroupTerminalViolationError`
3. **事件必须广播**：每次状态变更通过 IEventBus emit `GroupStateChangedEvent` / `BranchStateChangedEvent`，创建 / 删除 emit 对应 Created / Removed 事件
4. **状态持久化优先**：若注入 IGroupStatePersister，状态变更顺序为"验证 → 持久化 → 更新内存 → 广播事件"；持久化失败时回滚并抛出错误

### 2.4 开发规约

- **配置继承**：子 Group 自动继承父 Group 的 `env` / `fallback` / `worktree` 配置；显式配置覆盖父级，未配置则继承父级（递归合并直至根节点）
- **嵌套深度限制**：最大 5 层（常量 `MAX_NESTING_DEPTH = 5`）；超限时抛出 `GroupNestingDepthError`
- **依赖无环保证**：`DependencyGraph.addEdge()` 在添加前执行 `wouldCreateCycle()` 预检，若有环则拒绝并抛出 `CycleError`
- **删除原子性**：`deleteGroup()` 采用两阶段设计——先对整棵子树做可删性全量校验（`validateSubtreeDeletability`），校验全部通过后才执行实际删除；中途任何阶段失败都保证操作完全回滚
- **可执行 Group 判定**：`getExecutableGroups()` 返回状态为 `pending` 且所有依赖状态为 `completed` 的 Group（双重过滤）
- **事件类型**：`GroupEvent` 联合类型（`group.created` / `group.removed` / `group.state_changed` / `branch.state_changed`）；因 IEventBus 签名暂为 `WorkflowEvent | NodeEvent`，emit 时使用 `as unknown as` 类型桥接（架构演进计划：统一事件类型体系）
- **Worktree 集成**：可选注入 IWorktreeManager，为每个 Group 分配独立 worktree（具体创建逻辑由 worktree-manager 负责）
- **错误类型**（均继承 `GroupManagerError`）：GroupNotFoundError / BranchNotFoundError / CycleError / GroupDependedOnError / GroupNestingDepthError / InvalidGroupTransitionError / GroupTerminalViolationError / GroupConflictError / BranchConflictError / GroupConfigError / GroupMergeError / WorktreeCreationError / FallbackExecutionError

## 3. worktree-manager 模块

### 3.1 宏观定位

worktree-manager 是 DAG 引擎的文件隔离模块，基于 Git Worktree 技术为每个并行执行的工作流提供独立文件隔离环境。被 group-manager 依赖（为每个 Group 分配独立 worktree），与 state-machine 共享统一的事件广播模式。

本模块自身是内存态管理，持久化由外部调用者通过 IWorktreePersister 接口实现（可选注入）。

### 3.2 核心接口边界

- **IWorktreeManager**：Worktree 生命周期管理接口（CRUD / 合并 / 冲突检测 / 清理 / 锁定 / 状态变更 / Pull / Commit）
- **IWorktreePersister**：Worktree 状态持久化接口（可选依赖），由上层实现，WorktreeManager 通过该接口在状态变更前持久化

### 3.3 铁律合规

worktree-manager 完全遵守 state-machine 定义的 4 条状态机铁律：

1. **状态机不可绕过**：所有 Worktree 状态变更必须通过 `updateStatus()` API，禁止直接修改内存状态或外部文件系统
2. **终态不可逆**：Worktree 终态（MERGED / DELETED）达成后，再次更新状态抛出 `WorktreeTerminalViolationError`
3. **事件必须广播**：每次状态变更通过 IEventBus emit `WorktreeEvent`（`worktree.created` / `worktree.deleted` / `worktree.status_changed` / `worktree.merged` / `worktree.conflict`），创建 / 删除 emit 对应事件
4. **状态持久化优先**：若注入 IWorktreePersister，状态变更顺序为"验证 → 持久化 → 更新内存 → 广播事件"；持久化失败时回滚并抛出错误

### 3.4 开发规约

- **事件广播统一**：与 state-machine / group-manager 共享相同的 `IEventBus` 实例，通过 `eventBus.emit()` 广播事件，**不使用自定义 on() 方法**；`WorktreeEvent` 类型在 emit 时使用 `as unknown as WorkflowEvent | NodeEvent` 类型桥接（与 group-manager 一致，架构演进计划：统一事件类型体系）
- **IEventBus 签名扩展**：`emit(event: WorkflowEvent | NodeEvent | GroupEvent | WorktreeEvent)`，支持跨模块类型联合
- **状态持久化顺序**：状态变更后立即调用 `persist()`；持久化失败抛出 `WorktreeStateNotPersistedError`，阻止内存状态更新
- **autoCleanup 自动清理**：WorktreeConfig 中有 `autoCleanup` 字段；启用后状态变更到 completed / failed / cancelled 时自动触发 `cleanup()`；autoCleanup 执行异步不阻塞当前 update 操作
- **依赖 Git CLI**：所有 worktree 操作均通过 `git` 命令执行（`git worktree add / prune / merge / diff`），模块内禁止直接修改 `.git/worktrees/` 目录
- **错误类型**（均继承 `WorktreeError`）：WorktreeStateNotPersistedError / WorktreeAlreadyExistsError / WorktreeNotFoundError / WorktreeCreationError / WorktreeMergingError / WorktreeConflictError

## 4. scheduler 模块

（后续模块循环时填充）
