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

### 4.1 模块定位

scheduler 是 DAG 工作流引擎的第四个核心模块，负责根据 DAG 结构和当前状态调度节点执行。它在 state-machine（状态机）、worktree-manager（工作区管理器）和 group-manager（分组管理器）之上，提供完整的节点生命周期管理和执行调度能力。

### 4.2 核心职责

1. **节点状态管理**：管理节点的完整生命周期状态转换（pending → running → completed/failed）
2. **状态持久化**：确保所有状态变更优先持久化到 SQLite，防止内存与持久层不一致
3. **事件广播**：通过 IEventBus 广播节点状态变更事件，支持其他模块订阅和响应
4. **执行调度**：根据 DAG 拓扑顺序和并发约束调度节点执行
5. **错误恢复**：支持 persist 失败时的 rollback 机制，保证状态一致性

### 4.3 关键接口

#### IScheduler（接口定义）

```typescript
export interface IScheduler {
  // 节点生命周期管理
  createNode(nodeId: string, config: INodeConfig): Promise<INode>;
  getNode(nodeId: string): Promise<INode | null>;
  listNodes(): Promise<INode[]>;
  updateNodeStatus(nodeId: string, newStatus: NodeStatus): Promise<void>;
  
  // 执行调度
  scheduleNode(nodeId: string, executor: INodeExecutor): Promise<void>;
  cancelNode(nodeId: string): Promise<void>;
  
  // 批量操作
  cancelAllNodes(): Promise<void>;
  
  // 事件订阅（可选）
  on(event: SchedulerEvent, handler: EventHandler): void;
}
```

#### INodeExecutor（执行器接口）

```typescript
export interface INodeExecutor {
  execute(nodeId: string, context: ExecutionContext): Promise<ExecutionResult>;
}
```

### 4.4 铁律合规实现

#### 铁律 #1: 状态机不可绕过

**实现方式**：`updateNodeStatus` 方法封装所有状态转换逻辑，包括：
- 转换合法性验证（检查 `VALID_NODE_TRANSITIONS`）
- 终态不可逆验证（检查 `TERMINAL_NODE_STATUSES`）
- 状态持久化（调用 `persist()`）
- 事件广播（调用 `emit()`）

**代码示例**：
```typescript
async updateNodeStatus(nodeId: string, newStatus: NodeStatus): Promise<void> {
  const node = await this.getNode(nodeId);
  if (!node) {
    throw new NodeNotFoundError(nodeId);
  }
  
  const currentStatus = node.status;
  
  // 1. 终态不可逆验证（铁律 #2）
  if (TERMINAL_NODE_STATUSES.includes(currentStatus)) {
    throw new TerminalStateViolationError(nodeId, currentStatus, newStatus);
  }
  
  // 2. 转换合法性验证（铁律 #1）
  const validNextStatuses = VALID_NODE_TRANSITIONS[currentStatus];
  if (!validNextStatuses.includes(newStatus)) {
    throw new InvalidStateTransitionError(nodeId, currentStatus, newStatus);
  }
  
  // 3. 内存状态暂存（用于 rollback）
  const previousStatus = node.status;
  node.status = newStatus;
  node.updatedAt = Date.now();
  
  try {
    // 4. 状态持久化（铁律 #4）
    await this.persist(nodeId, node);
    
    // 5. 事件广播（铁律 #3）
    await this.emit({
      type: 'scheduler.node.state_changed',
      nodeId,
      oldStatus: previousStatus,
      newStatus: newStatus,
      timestamp: Date.now()
    });
  } catch (error) {
    // 6. Rollback 机制（铁律 #4 补充）
    node.status = previousStatus;
    throw new StateNotPersistedError(nodeId, error);
  }
}
```

#### 铁律 #2: 终态不可逆

**实现方式**：在 `updateNodeStatus` 中检查 `TERMINAL_NODE_STATUSES`（completed, failed, cancelled, timeout）。

**常量定义**：
```typescript
export const TERMINAL_NODE_STATUSES = [
  NodeStatus.COMPLETED,
  NodeStatus.FAILED,
  NodeStatus.CANCELLED,
  NodeStatus.TIMEOUT
] as const;
```

#### 铁律 #3: 事件必须广播

**实现方式**：所有状态变更都通过 `IEventBus.emit()` 广播事件。

**事件类型**：
```typescript
export type SchedulerEvent = 
  | { type: 'scheduler.node.state_changed'; nodeId: string; oldStatus: NodeStatus; newStatus: NodeStatus; timestamp: number }
  | { type: 'scheduler.scheduled'; nodeId: string; timestamp: number }
  | { type: 'scheduler.cancelled'; nodeId: string; timestamp: number };
```

**跨模块类型桥接**：使用 `as unknown as WorkflowEvent | NodeEvent` 桥接到 IEventBus 的泛型类型。

#### 铁律 #4: 状态持久化优先

**实现方式**：采用 **rollback 模式**（先更新内存，后持久化，失败时回滚）。

**设计理由**：
- 避免"持久化旧状态 → 更新内存新状态"的不一致窗口
- 持久化失败时自动恢复内存状态
- 参考 WorktreeManager 的成熟模式

**错误处理**：
```typescript
export class StateNotPersistedError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly originalError: Error
  ) {
    super(`Failed to persist state for node ${nodeId}: ${originalError.message}`);
  }
}
```

### 4.5 关键设计决策

#### P0 修复：persist 顺序问题（rollback 模式）

**问题背景**：
初始实现采用"先调用 `persist()`，后更新 `node.status`"的顺序，导致：
- 持久化写入的是旧状态
- 内存中是新状态
- 应用重启后状态回退到旧值

**修复方案**：
```typescript
// ❌ 错误实现（初始版本）
try {
  await this.persist(nodeId, node);  // 持久化旧状态
  node.status = newStatus;           // 内存更新
} catch (error) {
  // 持久化失败，但内存未更新，无法回滚
}

// ✅ 正确实现（rollback 模式）
const previousStatus = node.status;
node.status = newStatus;             // 先更新内存
try {
  await this.persist(nodeId, node);  // 后持久化新状态
} catch (error) {
  node.status = previousStatus;      // 失败时回滚
  throw new StateNotPersistedError(nodeId, error);
}
```

**验证方式**：通过测试验证 persist 后的状态确实是新状态。

#### P1 修复：executeWorker 外部注入

**问题背景**：
初始实现在 Scheduler 内部硬编码了 `simulateExecution` 方法，导致：
- 无法在测试中注入真实的执行逻辑
- 无法在不同执行环境（CLI、Web）中使用不同的 executor
- 违反了依赖注入原则（§0.1）

**修复方案**：
```typescript
// 构造函数接受可选的 workerExecutor
constructor(
  private persister: IStatePersister,
  private eventBus?: IEventBus,
  private workerExecutor?: INodeExecutor  // 新增参数
) {}

// scheduleNode 接受外部 executor
async scheduleNode(nodeId: string, executor: INodeExecutor): Promise<void> {
  // 使用传入的 executor，而非内部方法
  const result = await executor.execute(nodeId, context);
}
```

**验证方式**：通过测试验证实用的 executor 是否被调用。

### 4.6 依赖关系

**上游依赖**：
- `state-machine`：提供状态枚举（NodeStatus, WorkflowStatus）和状态转换规则（VALID_NODE_TRANSITIONS）
- `worktree-manager`：在工作区中执行节点（可选依赖）

**下游依赖**：
- DAG 引擎核心：调用 Scheduler 的 `scheduleNode`、`updateNodeStatus` 等方法
- 上层调度器/服务：订阅 Scheduler 事件以响应节点状态变更

**依赖关系图**：
```
state-machine ─────┐
                   ├──→ scheduler ──→ DAG 引擎核心
worktree-manager ──┘            └──→ 上层调度器/服务
```

### 4.7 测试覆盖

**测试套件**：35 个测试，全部通过

**测试分类**：
1. **基础功能测试**（17 个）：节点创建、状态查询、状态更新等
2. **铁律 #1 测试**（5 个）：验证所有状态变更都经过 `updateNodeStatus`
3. **铁律 #2 测试**（5 个）：验证终态不可逆
4. **铁律 #3 测试**（4 个）：验证所有状态变更都广播事件
5. **铁律 #4 测试**（3 个）：验证状态持久化优先和 rollback 机制
6. **P0/P1 修复验证**（1 个）：验证 executeWorker 外部注入

### 4.8 关键文件

- `src/dag/scheduler/types.ts`：类型定义（NodeStatus, SchedulerEvent, INode, INodeExecutor 等）
- `src/dag/scheduler/errors.ts`：错误类型（NodeNotFoundError, TerminalStateViolationError, StateNotPersistedError 等）
- `src/dag/scheduler/IScheduler.ts`：接口定义（IScheduler）
- `src/dag/scheduler/Scheduler.ts`：实现类（Scheduler）
- `src/dag/scheduler/__tests__/Scheduler.test.ts`：测试套件

### 4.9 使用示例

```typescript
// 1. 初始化 Scheduler
const persister = new StatePersister(sqliteDatabase);
const eventBus = new EventBus();
const executor = new MyNodeExecutor();

const scheduler = new Scheduler(persister, eventBus, executor);

// 2. 创建节点
const node = await scheduler.createNode('node-1', {
  name: 'Build Project',
  command: 'npm run build',
  timeout: 30000
});

// 3. 调度执行
await scheduler.scheduleNode('node-1', executor);

// 4. 监听事件
eventBus.on('scheduler.node.state_changed', (event) => {
  console.log(`Node ${event.nodeId}: ${event.oldStatus} → ${event.newStatus}`);
});

// 5. 取消节点
await scheduler.cancelNode('node-1');
```
