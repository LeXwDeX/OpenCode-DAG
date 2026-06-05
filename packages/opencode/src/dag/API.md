# DAG 工作流引擎 — API 参考手册

本文档定义了 DAG 引擎所有模块的公共接口、类型和事件。

## 目录

- [1. 状态机模块](#1-状态机模块)
  - [WorkflowStatus / NodeStatus / ShadowNodeStatus](#状态枚举)
  - [WorkflowTransition / NodeTransition](#状态转移触发条件)
  - [IEventBus](#ieventbus)
  - [IStatePersister](#istatepersister)
  - [IWorkflowStateMachine](#iworkflowstatemachine)
  - [INodeStateMachine](#inodestatemachine)
- [2. 调度器模块](#2-调度器模块)
  - [IScheduler](#ischeduler)
- [3. Worktree 管理模块](#3-worktree-管理模块)
  - [IWorktreeManager](#iworktreemanager)
- [4. 分组管理模块](#4-分组管理模块)
  - [IGroupManager](#igroupmanager)
  - [IDependencyGraph](#idependencygraph)
- [5. Session 服务](#5-session-服务)
  - [DAGSessionService](#dagessionservice-effect-模式)
- [6. 查询 API](#6-查询-api)
  - [IDAGQuery](#idagquery)
- [7. 事件系统](#7-事件系统)

---

## 1. 状态机模块

> 路径: `src/dag/state-machine/`

### 状态枚举

```typescript
enum WorkflowStatus {
  PENDING   = 'pending'     // 等待启动
  RUNNING   = 'running'     // 至少一个节点正在执行
  PAUSED    = 'paused'      // 用户暂停
  COMPLETED = 'completed'   // 所有 required_nodes 成功完成
  FAILED    = 'failed'      // 关键节点失败且无法恢复
  CANCELLED = 'cancelled'   // 用户主动取消
  ARCHIVED  = 'archived'    // 长期存储，不再活跃
}

enum NodeStatus {
  PENDING   = 'pending'     // 等待上游依赖完成
  RUNNING   = 'running'     // agent session 正在执行
  PAUSED    = 'paused'      // 节点暂停（workflow paused 传播）
  COMPLETED = 'completed'   // dag_completed 调用且通过校验
  FAILED    = 'failed'      // 执行失败
  ABORTED   = 'aborted'     // shadow 节点决定终止
  SKIPPED   = 'skipped'     // 上游失败或条件跳过
}

enum ShadowNodeStatus {
  PENDING   = 'pending'     // 等待触发
  RUNNING   = 'running'     // shadow session 正在执行
  COMPLETED = 'completed'   // 返回 decision
  FAILED    = 'failed'      // shadow 自身执行失败
}
```

**终态不可逆约束**：
- Workflow: `completed`, `failed`, `cancelled`, `archived` 为终态
- Node: `completed`, `failed`, `aborted`, `skipped` 为终态

### 状态转移触发条件

```typescript
enum WorkflowTransition {
  DAG_EXECUTE            = 'dag_execute'              // DAG 实例创建
  ENGINE_START           = 'engine_start'             // 引擎启动调度循环
  DAG_PAUSE              = 'dag_pause'                // 用户暂停
  DAG_RESUME             = 'dag_resume'               // 用户恢复
  ALL_REQUIRED_COMPLETED = 'all_required_completed'   // 所有必需节点完成
  CRITICAL_NODE_FAILED   = 'critical_node_failed'     // 关键节点失败
  DAG_CANCEL             = 'dag_cancel'               // 用户取消
  AUTO_ARCHIVE           = 'auto_archive'             // 自动归档
  USER_ARCHIVE           = 'user_archive'             // 手动归档
}

enum NodeTransition {
  NODE_REGISTER       = 'node_register'        // DAG 解析时注册节点
  DEPENDENCIES_MET    = 'dependencies_met'     // 上游完成 + 引擎调度
  DAG_COMPLETED       = 'dag_completed'        // dag_completed + 校验通过
  EXEC_FAILED         = 'exec_failed'          // 执行失败
  WORKFLOW_PAUSED     = 'workflow_paused'      // workflow 暂停传播
  WORKFLOW_RESUMED    = 'workflow_resumed'     // workflow 恢复传播
  FALLBACK_RERUN      = 'fallback_rerun'       // fallback 重跑
  FALLBACK_ABORT      = 'fallback_abort'       // fallback 终止
  SKIP_ON_FAILURE     = 'skip_on_failure'      // 上游失败时跳过
}

enum FallbackTrigger {
  EXEC_FAILED    = 'exec_failed'      // agent 输出错误
  PUSH_EXHAUSTED = 'push_exhausted'   // push_count >= max_pushes
  VERDICT_FAIL   = 'verdict_fail'     // output 关键字段判定失败
  TIMEOUT        = 'timeout'          // 执行超时
}
```

### 合法状态转移表

**Workflow 转移规则**（由 `getValidNextWorkflowStatuses()` 定义）:

| From \ To | PENDING | RUNNING | PAUSED | COMPLETED | FAILED | CANCELLED | ARCHIVED |
|-----------|---------|---------|--------|-----------|--------|-----------|----------|
| PENDING   | -       | ✅      | ❌     | ❌        | ❌     | ❌        | ❌       |
| RUNNING   | ❌      | -       | ✅     | ✅        | ✅     | ✅        | ❌       |
| PAUSED    | ❌      | ✅      | -      | ❌        | ❌     | ✅        | ❌       |
| COMPLETED | ❌      | ❌      | ❌     | -         | ❌     | ❌        | ✅       |
| FAILED    | ❌      | ❌      | ❌     | ❌        | -      | ❌        | ✅       |
| CANCELLED | ❌      | ❌      | ❌     | ❌        | ❌     | -         | ✅       |
| ARCHIVED  | ❌      | ❌      | ❌     | ❌        | ❌     | ❌        | -        |

**Node 转移规则**:

| From \ To | PENDING | RUNNING | PAUSED | COMPLETED | FAILED | ABORTED | SKIPPED |
|-----------|---------|---------|--------|-----------|--------|---------|---------|
| PENDING   | -       | ✅      | ❌     | ❌        | ✅     | ❌      | ✅      |
| RUNNING   | ❌      | -       | ✅     | ✅        | ✅     | ❌      | ❌      |
| PAUSED    | ❌      | ✅      | -      | ❌        | ❌     | ❌      | ❌      |
| COMPLETED | ❌      | ❌      | ❌     | -         | ❌     | ❌      | ❌      |
| FAILED    | ❌      | ❌      | ❌     | ❌        | -      | ❌      | ❌      |
| ABORTED   | ❌      | ❌      | ❌     | ❌        | ❌     | -       | ❌      |
| SKIPPED   | ❌      | ❌      | ❌     | ❌        | ❌     | ❌      | -       |

### IEventBus

事件总线接口，所有模块共享同一实例。

```typescript
interface IEventBus {
  subscribe(event: string, listener: EventEmitter): UnsubscribeFunction
  emit(event: WorkflowEvent | NodeEvent | GroupEvent | WorktreeEvent): void
  destroy(): void
}

type EventEmitter = (event: WorkflowEvent | NodeEvent | GroupEvent | WorktreeEvent) => void
type UnsubscribeFunction = () => void
```

**用法**:
```typescript
const unsubscribe = eventBus.subscribe('workflow.completed', (event) => {
  console.log('Workflow completed:', event.workflow_id)
})
// 取消订阅
unsubscribe()
```

### IStatePersister

状态持久化接口，保证状态转移先写磁盘再广播事件。

```typescript
interface IStatePersister {
  writeWorkflowState(workflowId: string, state: WorkflowStateData): Promise<void>
  readWorkflowState(workflowId: string): Promise<WorkflowStateData | null>
  deleteWorkflowState(workflowId: string): Promise<void>
  listWorkflowIds(): Promise<string[]>
}
```

### IWorkflowStateMachine

```typescript
interface WorkflowTransitionParams {
  fromStatus: WorkflowStatus
  toStatus: WorkflowStatus
  transition: WorkflowTransition
  reason?: string
  timestamp?: Date
}

interface IWorkflowStateMachine {
  getStatus(): Promise<WorkflowStatus>
  transition(params: WorkflowTransitionParams): Promise<void>
  updateStatus(status: WorkflowStatus): Promise<void>  // 仅用于初始化/修复
}
```

**执行顺序**: 验证合法性 → 持久化 → 更新内存 → 广播事件

**异常**:
- `InvalidWorkflowTransitionError` — 非法转移
- `WorkflowTerminalViolationError` — 终态违规
- `StateNotPersistedError` — 持久化失败

### INodeStateMachine

```typescript
interface NodeTransitionParams {
  workflowId: string
  nodeName: string
  fromStatus: NodeStatus | ShadowNodeStatus
  toStatus: NodeStatus | ShadowNodeStatus
  transition: NodeTransition
  reason?: string
  timestamp?: Date
  output?: any       // 仅 completed 状态
  diffStats?: any    // 仅 completed 状态
}

interface INodeStateMachine {
  transition(params: NodeTransitionParams): Promise<void>
  getNodeState(nodeName: string): Promise<NodeStateData | null>
  getBranchState(branchName: string): Promise<BranchStateData | null>
  getAllNodeStates(): Promise<Record<string, BranchStateData>>
  registerNode(workflowId: string, branchName: string, nodeName: string, isShadow: boolean): Promise<void>
  resetNode(nodeName: string): Promise<void>
  skipNode(nodeName: string, reason: string): Promise<void>
  incrementPushCount(nodeName: string, reason: string): Promise<void>
  incrementFallbackCount(nodeName: string): Promise<void>
  areAllRequiredNodesCompleted(requiredNodes: string[]): Promise<boolean>
}
```

---

## 2. 调度器模块

> 路径: `src/dag/scheduler/`

### IScheduler

管理 Worker 生命周期、并发执行和状态跟踪。

```typescript
interface IScheduler {
  // Worker CRUD
  createWorker(id: string, config: WorkerExecutionConfig): Promise<WorkerInfo>
  getWorker(workerId: string): Promise<WorkerInfo | undefined>
  getAllWorkers(): Promise<WorkerInfo[]>
  getWorkersByStatus(status: WorkerStatus): Promise<WorkerInfo[]>

  // 状态管理
  updateWorkerStatus(workerId: string, status: WorkerStatus): Promise<void>

  // 执行
  executeWorker(workerId: string, context: any): Promise<any>
  executeWorkers(workerIds: string[], context: any, maxConcurrency?: number): Promise<any[]>
  cancelWorker(workerId: string, reason?: string): Promise<void>

  // 队列控制
  waitForWorkers(workerIds: string[], timeoutMs?: number): Promise<WorkerInfo[]>
  getQueueSize(): Promise<number>
  clearQueue(): Promise<void>

  // 并发
  getRunningCount(): Promise<number>
  setMaxConcurrency(maxConcurrency: number): Promise<void>
  getMaxConcurrency(): Promise<number>
}
```

**Worker 状态**: `pending` → `running` → `completed` | `failed` | `cancelled`

**并发控制**: `executeWorkers` 支持 `maxConcurrency` 参数，默认 10。

---

## 3. Worktree 管理模块

> 路径: `src/dag/worktree-manager/`

### IWorktreeManager

每个 Group/节点在独立 Git worktree 中执行，提供并发文件隔离。

```typescript
interface IWorktreeManager {
  // Worktree CRUD
  create(name: string, config: WorktreeConfig): Promise<WorktreeInfo>
  get(worktreeId: string): Promise<WorktreeInfo | undefined>
  list(): Promise<WorktreeInfo[]>
  listByGroup(groupId: string): Promise<WorktreeInfo[]>

  // 状态管理
  update(worktreeId: string, status: WorktreeInfo['status']): Promise<void>

  // Git 操作
  merge(worktreeId: string, targetBranch: string, commitMessage: string): Promise<WorktreeMergeResult>
  detectConflicts(worktreeId: string, targetBranch: string): Promise<WorktreeConflict[]>
  commit(worktreeId: string, commitMessage: string): Promise<string>
  pull(worktreeId: string, remoteBranch: string): Promise<void>
  getDiff(worktreeId: string, targetBranch: string): Promise<string>

  // 清理
  cleanup(worktreeId: string): Promise<void>
  cleanupMany(worktreeIds: string[]): Promise<void>

  // 锁机制
  lock(worktreeId: string): Promise<void>
  unlock(worktreeId: string): Promise<void>

  // 自动清理
  setAutoCleanup(worktreeId: string, enabled: boolean): Promise<void>
}
```

**Worktree 状态流转**:
```
creating → active → merging → completed
                ↘ failed   ↘ merged
                ↘ deleted  ↘ cleanup (completed/failed 后)
```

---

## 4. 分组管理模块

> 路径: `src/dag/group-manager/`

### IGroupManager

管理多层级 Group 结构：DAG 节点分组、依赖管理、Worktree 隔离和环境继承。

```typescript
interface IGroupManager {
  // Group CRUD
  createGroup(config: GroupConfig): Promise<Group>
  deleteGroup(groupId: string): Promise<void>
  getGroup(groupId: string): Promise<GroupQueryResult>
  getAllGroups(): Promise<GroupQueryResult[]>

  // Branch CRUD
  addBranch(groupId: string, branchConfig: BranchConfig): Promise<Branch>
  deleteBranch(groupId: string, branchId: string): Promise<void>
  getBranch(groupId: string, branchId: string): Promise<Branch>
  getBranches(groupId: string): Promise<Branch[]>

  // 状态管理
  updateGroupStatus(groupId: string, status: GroupStatus): Promise<void>
  updateBranchStatus(groupId: string, branchId: string, status: BranchStatus): Promise<void>

  // 依赖管理
  getDependencies(groupId: string): Promise<string[]>
  addDependency(groupId: string, dependsOn: string[]): Promise<void>
  removeDependency(groupId: string, dependsOn: string[]): Promise<void>
  hasCycles(): Promise<boolean>
  getTopologicalOrder(): Promise<string[]>
  getExecutableGroups(): Promise<string[]>

  // Worktree 管理
  createWorktree(groupId: string): Promise<WorktreeInfo>
  deleteWorktree(groupId: string): Promise<void>
  getWorktreeInfo(groupId: string): Promise<WorktreeInfo>
  mergeWorktree(groupId: string, strategy?: 'default' | 'force' | 'abort_on_conflict'): Promise<GroupMergeResult>

  // 环境管理（支持沿父链继承）
  setEnvironment(groupId: string, env: Record<string, string>): Promise<void>
  getEnvironment(groupId: string): Promise<Record<string, string>>

  // Fallback
  setFallback(groupId: string, fallback: { node: string; trigger?: string; condition?: string }): Promise<void>
  getFallback(groupId: string): Promise<FallbackConfig | null>
  executeFallback(groupId: string): Promise<FallbackResult>

  // 并发控制
  setMaxParallel(groupId: string, maxParallel: number): Promise<void>
  getMaxParallel(groupId: string): Promise<number>
  isConcurrencyExceeded(groupId: string): Promise<boolean>
  getRunningBranchCount(groupId: string): Promise<number>

  // 配置
  getResolvedConfig(groupId: string): Promise<ResolvedGroupConfig>

  // 生命周期
  cleanup(): Promise<void>
  exportConfig(): Promise<GroupConfig[]>
  importConfig(configs: GroupConfig[]): Promise<void>
}
```

**关键约束**:
- 嵌套深度 ≤ 5 层
- depends_on 不允许环依赖
- 每个 Group 独立 worktree

### IDependencyGraph

有向无环图抽象接口，管理节点和边的拓扑关系。

```typescript
interface IDependencyGraph {
  // Node 管理
  addNode(nodeId: string): void
  removeNode(nodeId: string): void
  hasNode(nodeId: string): boolean
  getAllNodes(): string[]
  getNodeCount(): number

  // Edge 管理
  addEdge(from: string, to: string): void   // from 依赖 to
  removeEdge(from: string, to: string): void
  hasEdge(from: string, to: string): boolean
  getEdgeCount(): number

  // 依赖查询
  getDependencies(nodeId: string): string[]         // 直接依赖
  getDependents(nodeId: string): string[]           // 直接被依赖方
  getAllDependencies(nodeId: string): string[]      // 传递闭包
  getAllDependents(nodeId: string): string[]

  // 拓扑排序
  topologicalSort(): string[]

  // 执行规划
  getExecutableNodes(completed: Set<string>): string[]
  getLayers(): string[][]   // 按层分组（同层可并发）

  // 环检测
  hasCycle(): boolean
  findCycles(): string[][]

  // 序列化
  toJSON(): { nodes: string[]; edges: { from: string; to: string }[] }
  fromJSON(data): IDependencyGraph
  clone(): IDependencyGraph
  clear(): void

  // 统计
  getStats(): { nodeCount; edgeCount; averageDegree; maxDepth; hasCycle }
}
```

---

## 5. Session 服务

> 路径: `src/dag/session/session-service.ts`

### DAGSessionService（Effect 模式）

基于 Effect 的 Session 服务，管理 Workflow、Node 和 Violation 的持久化。

```typescript
// 创建实例
const service = yield* DAGSessionService.make

// Workflow 操作
const workflow = yield* service.createWorkflow({
  name: 'my-workflow',
  chatSessionId: 'session-123',
  config: { /* DAG 配置 */ },
  metadata: { key: 'value' },
})

const workflow = yield* service.getWorkflow(workflowId)
const workflows = yield* service.listWorkflowsByChatSession(chatSessionId)
const allWorkflows = yield* service.listAllWorkflows()
yield* service.updateWorkflowStatus(workflowId, 'running')

// Node 操作
const node = yield* service.createNode({
  workflowId: workflowId,
  name: 'step-a',
  nodeName: 'step-a',
  nodeType: 'required',
  config: { agent: 'implement', task: '...' },
  dependencyNodes: [],
})

const node = yield* service.getNode(nodeId)
const nodes = yield* service.listNodes(workflowId)
yield* service.updateNodeStatus({
  sessionId: nodeId,
  status: 'completed',
  outputData: { files: ['src/foo.ts'] },
})

// Violation 操作
const violation = yield* service.createViolation({
  workflowId,
  nodeId: nodeId,
  type: 'required_node_skipped',
  severity: 'error',
  message: 'Required node was skipped',
})

const violations = yield* service.listViolations(workflowId)
```

---

## 6. 查询 API

> 路径: `src/dag/query/`

### IDAGQuery

只读查询接口，用于工作流监控和仪表盘。

```typescript
interface IDAGQuery {
  listWorkflows(): Promise<DAGWorkflowSession[]>
  getWorkflow(id: string): Promise<DAGWorkflowSession | null>
  getNodeStatus(nodeId: string): Promise<DAGNodeStatus | null>
  getExecutionTimeline(workflowId: string): Promise<ExecutionTimeline>
  listWorkflowsByStatus(status: 'pending' | 'running' | 'completed' | 'failed'): Promise<DAGWorkflowSession[]>
  searchWorkflows(query: string): Promise<DAGWorkflowSession[]>
}
```

**返回类型**:

```typescript
interface ExecutionTimeline {
  workflowId: string
  startTime: number
  endTime: number | null
  events: TimelineEvent[]       // 按时间排序的事件流
  totalDuration: number
  nodeExecutionTimes: Record<string, NodeExecutionTime>
}

interface TimelineEvent {
  type: 'node_start' | 'node_complete' | 'node_failed' | 'edge_traversal'
  nodeId: string
  timestamp: number
  duration?: number
}

interface WorkflowStatistics {
  workflowId: string
  totalNodes: number
  completedNodes: number
  pendingNodes: number
  failedNodes: number
  currentRunning: number
  averageNodeDuration: number
  totalElapsedTime: number
}
```

---

## 7. 事件系统

> 类型定义: `src/dag/state-machine/types.ts`（WorkflowEvent / NodeEvent 联合类型）

DAG 事件通过共享的 `IEventBus` 实例广播，所有事件使用 **dot notation** 命名（`workflow.*` / `node.*` / `group.*` / `worktree.*`）。

### Workflow 事件

| 事件名 | 触发条件 | 关键字段 |
|--------|---------|---------|
| `workflow.created` | DAG 实例创建 | `workflow_id`, `template` |
| `workflow.started` | 引擎进入 RUNNING | `workflow_id` |
| `workflow.paused` | 用户暂停 | `workflow_id`, `paused_at` |
| `workflow.resumed` | 恢复执行 | `workflow_id` |
| `workflow.completed` | 所有 required_nodes 完成 | `workflow_id`, `duration_ms`, `accumulated_diff` |
| `workflow.failed` | 关键节点失败 | `workflow_id`, `reason`, `failed_nodes[]` |
| `workflow.cancelled` | 用户取消 | `workflow_id`, `cancelled_at` |
| `workflow.archived` | 归档 | `workflow_id`, `archived_at` |

### Node 事件

| 事件名 | 触发条件 | 关键字段 |
|--------|---------|---------|
| `node.registered` | DAG 解析注册节点 | `workflow_id`, `node_name`, `node_type` |
| `node.started` | 调度器启动节点 | `workflow_id`, `node_name`, `worktree_path` |
| `node.completed` | dag_completed 校验通过 | `workflow_id`, `node_name`, `output_summary`, `diff_stats` |
| `node.failed` | 执行失败 | `workflow_id`, `node_name`, `trigger_reason`, `error` |
| `node.paused` | workflow paused 传播 | `workflow_id`, `node_name` |
| `node.resumed` | workflow resumed 传播 | `workflow_id`, `node_name` |
| `node.restarted` | fallback 重跑 | `workflow_id`, `node_name`, `retry_count` |
| `node.aborted` | shadow decision: abort | `workflow_id`, `node_name`, `reason` |
| `node.skipped` | 上游失败跳过 | `workflow_id`, `node_name`, `upstream_failed_node` |
| `node.pushed` | push 机制触发 | `workflow_id`, `node_name`, `push_count`, `reason` |
| `node.progress` | 进度更新 | `workflow_id`, `node_name`, `progress_data` |
| `node.ask_main` | 请求 main 决策 | `workflow_id`, `node_name`, `question` |
| `node.timeout` | 执行超时 | `workflow_id`, `node_name`, `timeout_sec` |

### Group / Worktree 事件

| 事件名 | 来源模块 | 描述 |
|--------|---------|------|
| `group.created` / `group.removed` | group-manager | Group 生命周期 |
| `group.state_changed` | group-manager | Group 状态转移 |
| `branch.state_changed` | group-manager | Branch 状态转移 |
| `worktree.created` / `worktree.deleted` | worktree-manager | Worktree 生命周期 |
| `worktree.status_changed` | worktree-manager | Worktree 状态转移 |
| `worktree.merged` / `worktree.conflict` | worktree-manager | 合并操作 |

### 事件订阅示例

```typescript
const eventBus = new EventBus()

// 订阅 Workflow 完成
eventBus.subscribe('workflow.completed', (event) => {
  console.log(`[${event.workflow_id}] 完成，耗时 ${event.duration_ms}ms`)
})

// 订阅节点失败
eventBus.subscribe('node.failed', (event) => {
  console.error(`[${event.node_name}] 失败: ${event.trigger_reason}`)
})

// 通配符订阅所有事件
eventBus.subscribe('*', (event) => {
  metrics.record(event.type)
})
```

> 跨模块事件（group.* / worktree.*）通过 `as unknown as WorkflowEvent | NodeEvent` 类型桥接广播，参见 ARCHITECTURE.md §0.4。
