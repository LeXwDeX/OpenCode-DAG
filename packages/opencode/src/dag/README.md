<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
-->

# DAG 工作流引擎

基于有向无环图（DAG）的工作流编排引擎，支持多分支、多依赖、并发执行、断点恢复等企业级功能。

## 概述

DAG 工作流引擎是 opencode 的核心扩展模块，将任务编排建模为有向无环图。每个节点代表一个独立任务，节点间的依赖关系通过 `depends_on` 定义。引擎自动处理任务调度、并发执行、状态管理和错误恢复。

### 核心特性

- **多分支并行执行** — 无依赖关系的节点自动并发
- **依赖管理** — 拓扑排序保证正确执行顺序
- **断点恢复** — 崩溃后自动扫描孤儿工作流并恢复或标记失败（`recovery.ts`）
- **错误降级** — 非 required 节点失败不阻塞工作流终态收敛；级联 skip 下游
- **Worktree 隔离（可选）** — 节点配置 `use_worktree: true` 时在独立 Git worktree 中执行（opt-in，默认关闭）
- **状态持久化** — SQLite 持久化（Session 路径，`dag_workflow` / `dag_node` / `dag_workflow_history` 表）
- **四条铁律** — 状态机不可绕过、终态不可逆、事件必须广播、持久化优先

## 模块结构

```
src/dag/
├── state-machine/          # 状态机核心（基础层）
│   ├── types.ts            #   WorkflowStatus / NodeStatus / 事件类型
│   ├── errors.ts           #   转移规则验证 + 错误类型
│   ├── WorkflowStateMachine.ts  #   Workflow 状态机实现
│   ├── EventBus.ts         #   IEventBus 实现
│   └── IStateMachine.ts    #   接口定义
│
├── scheduler/              # 调度器（Worker 生命周期 + 并发控制）
│   ├── Scheduler.ts
│   ├── IScheduler.ts
│   └── types.ts
│
├── worktree-manager/       # Git worktree 管理（文件隔离）
│   ├── WorktreeManager.ts
│   ├── IWorktreeManager.ts
│   └── types.ts
│
├── group-manager/          # 多层级 Group 管理 + 依赖图
│   ├── GroupManager.ts
│   ├── IGroupManager.ts
│   ├── DependencyGraph.ts
│   └── IDependencyGraph.ts
│
├── session/                # Session 服务层（DB 持久化 + Effect 模式）
│   ├── session-service.ts  #   DAGSessionService（CRUD + 铁律验证）
│   ├── workflow-engine.ts  #   WorkflowEngine（调度编排）
│   ├── required-nodes-monitor.ts  #   required_nodes 违规检测
│   └── types.ts
│
├── query/                  # 只读查询 API
│   ├── dag-query.ts        #   DAGQuery（时间线 + 统计 + 搜索）
│   └── query-types.ts
│
└── persistence/            # SQLite schema（Drizzle ORM）
    └── schema.ts           #   6 表定义
```

### 模块依赖关系

```
state-machine ← scheduler / worktree-manager / group-manager / session ← query
                     ↑                          ↑
              worktree-manager ──────────→ group-manager（可选依赖）
```

**无循环依赖**，单一方向数据流。

## 快速开始

### 创建 DAG 配置

```yaml
name: ci-pipeline

branches:
  - name: main
    nodes:
      - type: required
        name: setup
        agent: implement
        task: "初始化环境"

      - type: required
        name: build
        agent: implement
        task: "构建项目"
        depends_on: [setup]

      - type: required
        name: test
        agent: implement
        task: "运行测试"
        depends_on: [build]

constraints:
  max_nodes: 20
  max_concurrency: 3
  node_timeout_sec: 600
```

### 运行测试

```bash
# 运行所有 DAG 测试
cd packages/opencode && bun test src/dag

# 运行特定模块
bun test src/dag/state-machine
bun test src/dag/session
```

## 测试

**396 pass, 5 skip, 0 fail**（跨 15 个测试文件）

| 模块 | 测试数 |
|------|--------|
| state-machine | 65 |
| scheduler | 43 |
| worktree-manager | 15 |
| group-manager | 43 |
| dag-integration | 24 |
| dag-smoke | 5 |
| dag-e2e | 8 |
| dag-deepseek-e2e | 8 |
| worker-execution | 16 |
| session-service | 98 |
| workflow-engine | 14 |
| required-nodes-validator | 17 |

## API 概览

### 状态机

```typescript
import { WorkflowStateMachine } from './state-machine/WorkflowStateMachine'
import { WorkflowStatus, WorkflowTransition } from './state-machine/types'

const machine = new WorkflowStateMachine(workflowId, eventBus, persister)
machine.initialize(WorkflowStatus.PENDING)

await machine.transition({
  fromStatus: WorkflowStatus.PENDING,
  toStatus: WorkflowStatus.RUNNING,
  transition: WorkflowTransition.ENGINE_START,
})
```

### 调度器

```typescript
import { Scheduler } from './scheduler/Scheduler'

const scheduler = new Scheduler(persister, eventBus)
await scheduler.createWorker(id, config)
await scheduler.executeWorkers(workerIds, context, maxConcurrency)
```

### Session 服务

```typescript
import { DAGSessionService } from './session/session-service'

const service = yield* DAGSessionService.make
const workflow = yield* service.createWorkflow({
  name: 'my-workflow',
  chatSessionId: 'session-123',
  config: { /* DAG 配置 */ },
})
yield* service.updateWorkflowStatus(workflow.id, 'running')
```

完整 API 参考：[API.md](./API.md)

## 约束和限制

| 约束 | 默认值 |
|------|--------|
| 最大节点数 | 20 |
| 最大并发数 | 10 |
| 节点超时 | 600 秒 |
| 最大 Push 次数 | 3 |
| 最大 Fallback 链 | 3 |
| Group 嵌套深度 | ≤ 5 层 |

## 四条铁律（不可违反）

1. **状态机不可绕过** — 所有状态变更必须通过状态机 API
2. **终态不可逆** — `completed`/`failed`/`cancelled` 不可回退
3. **事件必须广播** — 每次状态变更发出 dot notation 事件（`workflow.*` / `node.*`）
4. **状态持久化优先** — 先写磁盘再更新内存，失败时回滚

## 文档索引

| 文档 | 用途 |
|------|------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 模块架构 + 设计模式 |
| [API.md](./API.md) | 公共接口参考 |
| [USER_GUIDE.md](./USER_GUIDE.md) | 用户使用教程 |
| [AGENTS.md](./AGENTS.md) | 开发者指南 |

---

*最后更新: 2026-06-05*
