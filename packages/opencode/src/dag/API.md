<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
-->

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
- [8. DAG 配置类型](#8-dag-配置类型)
  - [DAGConfig](#dagconfig工作流配置)
  - [DAGNodeConfig](#dagnodeconfig节点配置)
  - [DAGNodeCondition](#dagnodecondition声明式条件表达式wp-b1)

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

---

## 8. DAG 配置类型

> 路径: `src/dag/session/types.ts`

> **Canonical source of truth**: 以下类型的 TypeScript 接口定义是该 DAG 配置形状的**唯一权威来源**。USER_GUIDE.md 中的示例、模板文件、工具文档必须与这些接口保持一致。

### DAGConfig（工作流配置）

```typescript
interface DAGConfig {
  name: string                // 工作流名称
  description?: string        // 描述
  nodes: DAGNodeConfig[]      // 节点定义列表（1-20 个）
  max_concurrency: number     // 最大并发 worker 数（1-10）
  timeout_ms?: number         // 工作流级别超时（毫秒）
}
```

### DAGNodeConfig（节点配置）

```typescript
interface DAGNodeConfig {
  id: string                                    // 节点唯一标识（bare cfg.id，无 namespace）
  name: string                                  // 显示名称
  description?: string                          // 描述
  dependencies: string[]                        // 依赖的节点 ID 列表
  required: boolean                             // 必需节点（跳过触发违规）
  timeout_ms?: number                           // 节点超时（毫秒）
  retry?: { max_attempts: number; delay_ms: number }
  worker_type: string                           // Worker 类型（路由到具体 agent）
  worker_config: Record<string, unknown>        // Worker 配置
  condition?: DAGNodeCondition                  // 声明式条件表达式（WP-B1，见下）
  input_mapping?: DAGInputMapping               // 声明式数据映射（WP-C1，见下）
}
```

**字段语义说明**：

- `dependencies`: bare `cfg.id` 值（**不包含** `workflowId::` 前缀）。Namespacing 由引擎在节点 materialization 阶段（`dagworker.ts`）完成。
- `required`: 为 `false` 时，节点失败/跳过不会导致工作流级失败（由 `maybeFinalizeWorkflow` 处理）。
- `worker_type`: 经 `Agent.Service.get(worker_type)` 路由；必须匹配已注册 agent。内置 agents: `build`, `plan`, `general`, `explore`, `scout`。用户可通过 `opencode.json` 的 `agents: Record<string, AgentInfo>` 注册自定义 agent。
- `worker_config`: 透传给 worker 的不透明配置袋。已知 keys: `prompt`（string）、`agent`（agent 名覆盖）、`use_worktree: true`（触发 worktree 隔离）。

### DAGNodeCondition（声明式条件表达式，WP-B1）

```typescript
type DAGConditionOp = 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'exists' | 'not_exists'

interface DAGNodeCondition {
  ref_node: string      // 引用的上游节点 ID（必须是 dependencies 子集）
  op: DAGConditionOp    // 比较运算符
  value?: unknown       // 比较基准值（exists/not_exists 忽略）
}
```

**校验规则**（`createWorkflow` / `validateReplanPostConfig` schema 强制）：

| 规则 | 违反时 reason |
|------|--------------|
| 声明 `condition` 的节点 `required` 必须为 `false` | `required node cannot declare condition` |
| `ref_node` 必须在节点的 `dependencies` 列表中 | `condition refs must ⊆ dependencies: ref_node '<x>' not in dependencies [...]` |
| `condition` 必须是结构化对象（禁止函数/闭包/数组/字符串） | `condition must be a structured object, got <type>` |
| `ref_node` 必须为非空 string | `condition.ref_node must be a non-empty string, got <type>` |
| `op` 必须是白名单运算符之一 | `condition.op must be one of eq|ne|...|not_exists, got <x>` |
| 缺省（`condition` 未提供/undefined）——**向后兼容** | （不拒绝，节点无条件执行） |

**运行时语义**（WP-B2/B3 实现）：
- 当节点所有依赖满足后，求值 `condition`（纯函数，无副作用）。
- `condition` 为真 → 节点进入就绪（queued → running）。
- `condition` 为假 → 节点经状态机主动跳过（skipped），并级联下游。
- 缺省 `condition` → 无条件执行（向后兼容）。

**与 `group-manager/types.ts:FallbackConfig.condition?:string` 的区别**（INFO 4）：

| 概念 | 类型 | 作用域 | 语义 |
|------|------|--------|------|
| `DAGNodeConfig.condition` | `DAGNodeCondition`（结构化对象） | **节点级** | 声明式条件，决定节点是否执行（skip vs ready）；schema 强制 required 互斥 + ref⊆deps |
| `FallbackConfig.condition` | `string` | **group 级**（core 储备池） | shadow 节点 custom trigger 的表达式字符串，与节点执行条件无关 |

两者语义完全不同，不可混淆；前者在 `session/types.ts`，后者在 `group-manager/types.ts`。

### DAGInputMapping（声明式数据映射，WP-C1）

```typescript
interface DAGInputMappingEntry {
  ref_node: string         // 数据来源的上游节点 ID（必须是 dependencies 子集）
  ref_path?: string        // 可选：指向 ref_node output 的子字段（缺省 = 整个 output 对象）
}

type DAGInputMapping = Record<string, DAGInputMappingEntry>
```

**字段语义说明**：

- `input_mapping` 是 Record 形式（非数组），key 为注入目标键（inputKey），value 为 `DAGInputMappingEntry`。Record 形式避免 inputKey 重复，查找 O(1)，schema 迭代简洁（INFO 1）。
- `ref_node` 必须是声明的上游依赖节点 ID（schema 强制 ⊆ `dependencies`）。
- `ref_path` 可选，缺省表示取整个 output 对象；运行时语义由 WP-C2 实现，C1 仅做静态结构校验（INFO 2）。
- 与 `condition` 正交：`condition` 控制"是否执行"（skip vs ready），`input_mapping` 控制"执行时注入什么上游数据"。两者可同时声明。

**校验规则**（`createWorkflow` / `validateReplanPostConfig` schema 强制）：

| 规则 | 违反时 reason |
|------|--------------|
| `input_mapping` 必须是纯对象（禁止函数/闭包/数组/字符串/数字） | `input_mapping must be a serializable object (no closure/function/array), got <type>` |
| 每个 entry 必须是结构化对象（禁止闭包/函数/数组/null） | `input_mapping.<key> must be a structured object, got <type>` |
| 每个 entry 的 `ref_node` 必须是非空 string | `input_mapping.<key>.ref_node must be a non-empty string, got <type>` |
| 每个 entry 的 `ref_path`（若提供）必须是 string | `input_mapping.<key>.ref_path must be string \| undefined, got <type>` |
| 每个 entry 的 `ref_node` 必须在节点的 `dependencies` 列表中 | `input_mapping refs must ⊆ dependencies: ref_node '<x>' not in dependencies [...]` |
| 缺省（`input_mapping` 未提供/undefined）——**向后兼容** | （不拒绝，节点无数据注入） |

**运行时语义**（WP-C2/C3 实现，C1 不含运行期行为）：

- 节点就绪（所有 dependencies 已 completed）后，按 `input_mapping` 从依赖节点的持久化 output 收集对应值。
- `ref_path` 缺省 → 取整个 output 对象；提供时按路径取值（缺失时确定语义，不抛异常，WP-C2 定义）。
- 未声明 `input_mapping` 的节点 → 无数据注入（向后兼容，prompt 构造不变）。
