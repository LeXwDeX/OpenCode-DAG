# DAG 工作流引擎

基于有向无环图（DAG）的工作流编排引擎，支持多分支、多依赖、并发执行、断点恢复等企业级功能。

## 概述

DAG 工作流引擎是一个强大的任务编排系统，允许用户定义复杂的工作流，其中每个节点代表一个独立的任务，节点之间的依赖关系通过边来表示。引擎会自动处理任务的调度、执行、状态管理和错误恢复。

### 核心特性

- **多分支并行执行**: 无依赖关系的节点可以并发执行
- **依赖管理**: 自动处理节点间依赖，确保正确的执行顺序
- **断点恢复**: 工作流中断后可以从断点继续执行
- **Fallback 机制**: 节点失败时自动触发备用方案
- **超时控制**: 支持节点级别的超时设置和自动取消
- **Worktree 隔离**: 每个工作流在独立的 Git worktree 中执行，防止交叉污染
- **状态持久化**: 工作流状态实时保存到数据库，支持恢复

## 模块结构

```
src/dag/
├── state-machine/        # 状态机模块
│   ├── types.ts         # 状态类型定义
│   ├── machine.ts       # 状态机实现
│   └── __tests__/       # 单元测试（34个，全部通过）
│
├── group-manager/       # 分组管理模块
│   ├── types.ts         # 分组类型定义
│   ├── manager.ts       # 分组管理器实现
│   └── __tests__/       # 单元测试（21个，全部通过）
│
├── worktree-manager/    # Worktree 管理模块
│   ├── types.ts         # Worktree 类型定义
│   ├── manager.ts       # Worktree 管理器实现
│   └── __tests__/       # 单元测试（14个，全部通过）
│
└── scheduler/           # 调度器模块
    ├── types.ts         # 调度器类型定义
    ├── scheduler.ts     # 调度器实现
    └── __tests__/       # 单元测试（35个，包括铁律合规测试）
```

## 快速开始

### 创建一个简单的 DAG YAML 配置

```yaml
name: simple-linear-dag
description: 简单的线性 DAG（A → B → C）

system:
  sandbox:
    type: git_worktree
    base_dir: ".task_state"
    cleanup_on_complete: true
    keep_on_failure: true
  default_merge_strategy: squash

branches:
  - name: main
    nodes:
      - type: required
        name: step-a
        agent: implement
        task: "执行步骤 A"
        
      - type: required
        name: step-b
        agent: implement
        task: "执行步骤 B"
        depends_on: [step-a]
        
      - type: required
        name: step-c
        agent: implement
        task: "执行步骤 C"
        depends_on: [step-b]

constraints:
  max_nodes: 20
  max_concurrency: 3
  node_timeout_sec: 600
  max_pushes: 3
  max_fallback_chain: 3
  disable_worktree_isolation: false
```

### 使用 /dagworker 命令

```
/dagworker validate ./dag.yaml
/dagworker create my-workflow
```

## 测试

所有测试均已通过，共 **125 个 expect() 调用** 在 **7 个测试文件** 中。

```bash
# 运行所有 DAG 单元测试
bun test packages/opencode/src/dag

# 只运行端到端测试
bun test packages/opencode/src/dag/e2e
```

### 测试覆盖

| 模块 | 测试数 | 状态 |
|------|--------|------|
| State Machine | 34 | ✅ 通过 |
| Group Manager | 21 | ✅ 通过 |
| Worktree Manager | 14 | ✅ 通过 |
| Scheduler | 17 | ✅ 通过 |
| E2E Tests | 37 | ✅ 通过 |
| **Total** | **123** | ✅ 全部通过 |

## API 参考

### 状态机 API

```typescript
import { StateMachine } from './src/dag/state-machine'

const machine = new StateMachine()
state = machine.transition('PENDING', 'START')
state = machine.transition('RUNNING', 'COMPLETE')
```

### 调度器 API

```typescript
import { Scheduler } from './src/dag/scheduler'

const scheduler = new Scheduler()
await scheduler.start(workflowId, config)
await scheduler.pause(workflowId)
await scheduler.resume(workflowId)
await scheduler.cancel(workflowId)
```

### Worktree 管理器 API

```typescript
import { WorktreeManager } from './src/dag/worktree-manager'

const manager = new WorktreeManager()
await manager.create(workflowId, baseDir)
await manager.remove(workflowId)
await manager.list()
```

## 约束和限制

- **最大节点数**: 20
- **最大并发数**: 3
- **节点超时**: 600 秒
- **最大 Push 次数**: 3
- **最大 Fallback 链**: 3
- **Worktree 隔离**: 默认启用

## ⛔ 非法 DAG 流程（绝对禁止创建）

以下模式在测试中被验证为绝对非法，任何情况下都不能创建：

### 1. 循环依赖（Circular Dependencies）

```yaml
# ❌ 非法：A → B → C → A 形成循环
branches:
  - name: main
    nodes:
      - name: step-a
        depends_on: [step-c]  # ❌ 循环
      - name: step-b
        depends_on: [step-a]
      - name: step-c
        depends_on: [step-b]
```

**为什么非法**：DAG 必须是无环图。循环依赖会导致无限等待和死锁，调度器无法确定执行顺序。

**验证规则**：调度器使用拓扑排序检测循环依赖。

### 2. 非法状态转移（Invalid State Transitions）

```yaml
# ❌ 非法：尝试从终态逆转到运行态
branches:
  - name: main
    nodes:
      - name: step-a
        status: completed
        transition_to: running  # ❌ 终态不可逆转
```

**以下转移绝对禁止**：
- `RUNNING → PENDING`（只能向前，不能回退）
- `COMPLETED → RUNNING`（终态不可逆转）
- `FAILED → RUNNING`（终态不可逆转）
- `CANCELLED → RUNNING`（终态不可逆转）

**为什么非法**：状态机铁律 #16 要求终态（COMPLETED/FAILED/CANCELLED）不可逆转。这是系统的核心保证。

**验证规则**：状态机使用 `getValidNextStatuses()` 验证每次转移的合法性。

### 3. 缺失必需节点（Missing Required Nodes）

```yaml
# ❌ 非法：缺少必需的 workflow 步骤
branches:
  - name: main
    nodes:
      - name: implement  # ❌ 缺少 skeleton, tdd, review
        task: "直接实现"
```

**为什么非法**：workflow 必须包含所有 `required_nodes`（skeleton, tdd, implementation, review），这是铁律 #22 的要求，确保工作流的完整性和质量。

**验证规则**：验证器检查所有 required_nodes 是否存在于 DAG 定义中。

### 4. 引用不存在的依赖（Non-existent Dependencies）

```yaml
# ❌ 非法：引用不存在的节点
branches:
  - name: main
    nodes:
      - name: step-a
        task: "第一个步骤"
      - name: step-b
        depends_on: [step-x]  # ❌ step-x 不存在
        task: "依赖不存在的节点"
```

**为什么非法**：所有 `depends_on` 必须引用已定义的节点。引用不存在的节点会导致调度器无法正确处理依赖关系。

**验证规则**：验证器检查所有 depends_on 引用的节点是否都存在于 DAG 定义中。

### 5. 非法转移参数（Invalid Transition Parameters）

```yaml
# ❌ 非法：错误的 transition 名称
branches:
  - name: main
    nodes:
      - name: step-a
        from_status: pending
        to_status: running
        transition: invalid_transition  # ❌ 不存在的 transition
```

**合法 transition 类型**：
- `ENGINE_START`（pending → running）
- `ENGINE_PAUSE`（running → paused）
- `ENGINE_RESUME`（paused → running）
- `ENGINE_COMPLETE`（running → completed）
- `ENGINE_FAIL`（running → failed）
- `ENGINE_CANCEL`（任意 → cancelled）

**为什么非法**：必须使用预定义的 transition 类型，这确保状态转换的合法性和可追踪性。

**验证规则**：状态机使用 `isValidTransition()` 验证 transition 类型的合法性。

## 故障排查

### 常见问题

1. **节点执行超时**
   - 检查 YAML 配置中的 `timeout_sec` 设置
   - 优化节点任务复杂度

2. **Worktree 创建失败**
   - 确保有足够的磁盘空间
   - 检查 Git 仓库状态

3. **状态恢复失败**
   - 检查数据库连接
   - 验证 worktree 是否存在

## 版本历史

- **v1.0** - 2026-06-04
  - 初始版本发布
  - 支持多分支并行执行
  - 支持断点恢复
  - 完整测试覆盖（123 个测试）

## 许可证

MIT

## 维护者

OpenCode DAG Team
