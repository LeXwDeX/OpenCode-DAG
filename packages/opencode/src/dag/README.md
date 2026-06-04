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
