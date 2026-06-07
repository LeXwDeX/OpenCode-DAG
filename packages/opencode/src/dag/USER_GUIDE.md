<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
-->

# DAG 工作流用户指南

本指南面向使用 DAG 工作流引擎编排复杂任务的用户。提供从基础概念到高级模式的完整教程。

## 目录

- [核心概念](#核心概念)
- [配置文件参考](#配置文件参考)
- [工作流执行模式](#工作流执行模式)
- [节点配置详解](#节点配置详解)
- [错误处理与重试](#错误处理与重试)
- [监控与调试](#监控与调试)
- [常见模式](#常见模式)

---

## 核心概念

### DAG（有向无环图）

DAG 工作流将任务编排建模为有向无环图：
- **节点（Node）**：一个独立的任务单元（如 "实现功能"、"运行测试"）
- **边（Edge）**：节点之间的依赖关系（`dependencies`）
- **工作流（Workflow）**：一组节点和边的完整定义

```
  [A:骨架设计] ──→ [B:TDD 测试] ──→ [C:实现] ──→ [D:审查]
                         │                          ▲
                         └──── [E:文档更新] ─────────┘
```

**规则**：
- 节点只有在其所有上游节点 `completed` 后才会被调度
- 无依赖关系的节点自动并行执行
- 图中不允许出现环（循环依赖）

### 状态流转

每个工作流和节点都有固定的状态生命周期：

```
工作流:  pending → running → completed / failed / cancelled
节点:    pending → running → completed / failed / skipped
```

**终态不可逆**：一旦进入 `completed`、`failed`、`cancelled`，不能回退到 `running`。

### 四条铁律

1. **状态机不可绕过** — 所有状态变更必须通过状态机 API
2. **终态不可逆** — 终态不可回退
3. **事件必须广播** — 每次状态变更发出事件
4. **状态持久化优先** — 先写磁盘再更新内存

---

## 配置文件参考

> **Canonical schema**: DAG 工作流配置的唯一定义来源是 `DAGConfig` / `DAGNodeConfig` 接口（`packages/opencode/src/dag/session/types.ts`）。本文档所有示例均使用该 JSON schema。

DAG 工作流通过 JSON 配置文件定义：

```json
{
  "name": "my-workflow",
  "description": "描述工作流的目的",
  "max_concurrency": 3,
  "nodes": [
    {
      "id": "node-name",
      "name": "节点显示名称",
      "dependencies": [],
      "required": true,
      "worker_type": "implement",
      "worker_config": {
        "agent": "implement",
        "prompt": "节点任务的描述"
      }
    }
  ]
}
```

### 字段说明

#### DAGConfig（工作流级别）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 工作流名称（用于显示） |
| `description` | string | 否 | 工作流描述 |
| `nodes` | DAGNodeConfig[] | 是 | 所有节点定义（1-20 个） |
| `max_concurrency` | number | 是 | 最大并发 worker 数（1-10） |
| `timeout_ms` | number | 否 | 工作流级别的超时（毫秒） |

#### DAGNodeConfig（节点级别）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 节点唯一标识（不允许包含 `::`） |
| `name` | string | 是 | 节点显示名称 |
| `description` | string | 否 | 节点描述 |
| `dependencies` | string[] | 是 | 依赖的节点 ID 列表 |
| `required` | boolean | 是 | 是否为必需节点 |
| `timeout_ms` | number | 否 | 节点超时（毫秒） |
| `retry` | object | 否 | 重试策略 `{ max_attempts, delay_ms }` |
| `worker_type` | string | 是 | Worker 类型（路由到具体 agent） |
| `worker_config` | object | 是 | Worker 配置 `{ agent, prompt, ... }` |

---

## 工作流执行模式

### 1. 串行执行

所有节点按依赖顺序依次执行：

```json
{
  "name": "serial-pipeline",
  "max_concurrency": 1,
  "nodes": [
    {
      "id": "setup",
      "name": "Setup",
      "dependencies": [],
      "required": true,
      "worker_type": "implement",
      "worker_config": { "prompt": "初始化项目" }
    },
    {
      "id": "build",
      "name": "Build",
      "dependencies": ["setup"],
      "required": true,
      "worker_type": "implement",
      "worker_config": { "prompt": "构建项目" }
    },
    {
      "id": "test",
      "name": "Test",
      "dependencies": ["build"],
      "required": true,
      "worker_type": "implement",
      "worker_config": { "prompt": "运行测试" }
    }
  ]
}
```

执行顺序: `setup → build → test`

### 2. 并行执行

无依赖关系的节点自动并发：

```json
{
  "name": "parallel-pipeline",
  "max_concurrency": 3,
  "nodes": [
    {
      "id": "setup",
      "name": "Setup",
      "dependencies": [],
      "required": true,
      "worker_type": "implement",
      "worker_config": { "prompt": "环境准备" }
    },
    {
      "id": "lint",
      "name": "Lint",
      "dependencies": ["setup"],
      "required": true,
      "worker_type": "implement",
      "worker_config": { "prompt": "代码检查" }
    },
    {
      "id": "unit-test",
      "name": "Unit Test",
      "dependencies": ["setup"],
      "required": true,
      "worker_type": "implement",
      "worker_config": { "prompt": "单元测试" }
    },
    {
      "id": "e2e-test",
      "name": "E2E Test",
      "dependencies": ["setup"],
      "required": true,
      "worker_type": "implement",
      "worker_config": { "prompt": "端到端测试" }
    }
  ]
}
```

执行: `setup → [lint, unit-test, e2e-test] 并行`

### 3. 菱形 DAG

汇合模式 — 多个并行分支汇总到一个节点：

```json
{
  "name": "diamond-dag",
  "max_concurrency": 2,
  "nodes": [
    {
      "id": "analyze",
      "name": "Analyze",
      "dependencies": [],
      "required": true,
      "worker_type": "implement",
      "worker_config": { "prompt": "分析需求" }
    },
    {
      "id": "frontend",
      "name": "Frontend",
      "dependencies": ["analyze"],
      "required": true,
      "worker_type": "implement",
      "worker_config": { "prompt": "前端实现" }
    },
    {
      "id": "backend",
      "name": "Backend",
      "dependencies": ["analyze"],
      "required": true,
      "worker_type": "implement",
      "worker_config": { "prompt": "后端实现" }
    },
    {
      "id": "integration",
      "name": "Integration",
      "dependencies": ["frontend", "backend"],
      "required": true,
      "worker_type": "implement",
      "worker_config": { "prompt": "集成测试" }
    }
  ]
}
```

执行: `analyze → [frontend, backend] 并行 → integration`

### 4. 多分支独立执行

无依赖关系的节点完全并行：

```json
{
  "name": "multi-branch",
  "max_concurrency": 2,
  "nodes": [
    {
      "id": "impl-a",
      "name": "Feature A",
      "dependencies": [],
      "required": true,
      "worker_type": "implement",
      "worker_config": { "prompt": "实现功能 A" }
    },
    {
      "id": "impl-b",
      "name": "Feature B",
      "dependencies": [],
      "required": true,
      "worker_type": "implement",
      "worker_config": { "prompt": "实现功能 B" }
    }
  ]
}
```

执行: `[impl-a, impl-b] 完全并行`

---

## 节点配置详解

### 必需与可选节点

| `required` 值 | 说明 | 失败影响 |
|------|------|------|
| `true` | 必需节点，失败即工作流失败 | 工作流标记为 `failed` |
| `false` | 可选节点，失败可跳过 | 记录 violation 但不阻塞工作流 |

### 完整节点配置

```json
{
  "id": "implement-module",
  "name": "实现模块",
  "description": "实现 XX 模块的完整任务",
  "dependencies": ["skeleton", "tdd"],
  "required": true,
  "timeout_ms": 300000,
  "retry": { "max_attempts": 2, "delay_ms": 1000 },
  "worker_type": "implement",
  "worker_config": {
    "agent": "implement",
    "prompt": "实现 XX 模块:\n- 创建 src/xx.ts\n- 添加对应测试\n- 确保类型检查通过"
  }
}
```

### 字段映射参考

| 含义 | JSON 字段 | 说明 |
|------|-----------|------|
| 节点标识 | `id` | 唯一标识（小写、连字符，不含 `::`） |
| 显示名称 | `name` | 用户可读名称 |
| 依赖关系 | `dependencies` | 上游节点 ID 列表（bare `cfg.id`，无 namespace） |
| agent 类型 | `worker_type` | 路由到具体 agent（须在 registry 中注册） |
| 任务描述 | `worker_config.prompt` | 具体任务指令 |
| 超时时间 | `timeout_ms` | 毫秒为单位 |
| 重试策略 | `retry` | `{ max_attempts, delay_ms }` |

---

## 错误处理与重试

### 重试机制

节点可配置自动重试：

```json
{
  "id": "risky-task",
  "name": "Risky Task",
  "dependencies": [],
  "required": true,
  "retry": {
    "max_attempts": 3,
    "delay_ms": 2000
  },
  "worker_type": "implement",
  "worker_config": { "prompt": "执行可能失败的任务" }
}
```

重试规则：
- `max_attempts: 3` 表示最多尝试 3 次（含首次）
- `delay_ms: 2000` 表示每次重试间隔 2000 毫秒
- 重试耗尽后节点标记为 `failed`

### 失败传播

当必需节点（`required: true`）失败时：
1. 节点状态 → `failed`
2. 工作流状态 → `failed`
3. 下游依赖节点不会被调度

当可选节点（`required: false`）失败时：
1. 节点状态 → `failed`
2. 记录 `execution_failed` violation
3. 工作流仍可继续（只要所有 required 节点完成）

---

## 监控与调试

### 查看工作流状态

通过 DAG Query API 查询工作流状态：

```typescript
import { DAGQuery } from '@/dag/query/dag-query'

// 列出所有工作流
const workflows = await query.listWorkflows()

// 按状态过滤
const running = await query.listWorkflowsByStatus('running')

// 获取执行时间线
const timeline = await query.getExecutionTimeline(workflowId)
console.log(`总耗时: ${timeline.totalDuration}ms`)

// 搜索工作流
const matched = await query.searchWorkflows('feature')
```

### 事件订阅

订阅工作流事件实现实时监控：

```typescript
import { eventBus } from '@/event-bus'

// 工作流开始
eventBus.subscribe('dag:workflow:started', {
  handler: async (event) => {
    console.log(`[${event.workflowId}] 开始执行`)
  }
})

// 节点完成
eventBus.subscribe('dag:node:completed', {
  handler: async (event) => {
    console.log(`[${event.nodeId}] 完成 (${event.durationMs}ms)`)
  }
})

// 节点失败
eventBus.subscribe('dag:node:failed', {
  handler: async (event) => {
    console.error(`[${event.nodeId}] 失败: ${event.error}`)
    // 触发告警逻辑
  }
})

// 违规检测
eventBus.subscribe('dag:violation:detected', {
  handler: async (event) => {
    console.warn(`[VIOLATION] ${event.violationType}: ${event.message}`)
  }
})
```

### 违规记录

工作流中的违规行为会自动记录到 Violation 表中：

```typescript
// 查询工作流的违规记录
const violations = yield* service.listViolations(workflowId)

violations.forEach(v => {
  console.log(`[${v.severity}] ${v.type}: ${v.message}`)
})
```

### 故障排查清单

| 现象 | 可能原因 | 排查步骤 |
|------|---------|---------|
| 节点超时 | 任务过于复杂 | 检查 `timeout_ms`，拆分任务 |
| Worktree 创建失败 | Git 仓库状态异常 | 检查磁盘空间、Git 权限 |
| 状态恢复失败 | 数据库连接问题 | 检查 SQLite 文件完整性 |
| 循环依赖 | `dependencies` 配置错误 | 使用 `topologicalSort()` 检测 |
| 节点卡在 running | agent 无响应 | 检查 agent 进程是否正常 |

---

## 常见模式

### 模式 1: CI/CD 流水线

```json
{
  "name": "ci-pipeline",
  "max_concurrency": 3,
  "nodes": [
    {
      "id": "checkout",
      "name": "Checkout",
      "dependencies": [],
      "required": true,
      "worker_type": "implement",
      "worker_config": { "prompt": "拉取代码" }
    },
    {
      "id": "install",
      "name": "Install",
      "dependencies": ["checkout"],
      "required": true,
      "worker_type": "implement",
      "worker_config": { "prompt": "安装依赖" }
    },
    {
      "id": "lint",
      "name": "Lint",
      "dependencies": ["install"],
      "required": true,
      "worker_type": "implement",
      "worker_config": { "prompt": "代码检查" }
    },
    {
      "id": "unit-test",
      "name": "Unit Test",
      "dependencies": ["install"],
      "required": true,
      "worker_type": "implement",
      "worker_config": { "prompt": "单元测试" }
    },
    {
      "id": "build",
      "name": "Build",
      "dependencies": ["lint", "unit-test"],
      "required": true,
      "worker_type": "implement",
      "worker_config": { "prompt": "构建产物" }
    },
    {
      "id": "deploy",
      "name": "Deploy",
      "dependencies": ["build"],
      "required": true,
      "timeout_ms": 1800000,
      "worker_type": "implement",
      "worker_config": { "prompt": "部署到生产" }
    }
  ]
}
```

### 模式 2: 多 agent 协作开发

```json
{
  "name": "collaborative-dev",
  "max_concurrency": 3,
  "nodes": [
    {
      "id": "api-design",
      "name": "API Design",
      "dependencies": [],
      "required": true,
      "worker_type": "architect",
      "worker_config": { "prompt": "设计 API 接口" }
    },
    {
      "id": "api-impl",
      "name": "API Implementation",
      "dependencies": ["api-design"],
      "required": true,
      "worker_type": "implement",
      "worker_config": { "prompt": "实现 API" }
    },
    {
      "id": "ui-design",
      "name": "UI Design",
      "dependencies": [],
      "required": true,
      "worker_type": "architect",
      "worker_config": { "prompt": "设计 UI 组件" }
    },
    {
      "id": "ui-impl",
      "name": "UI Implementation",
      "dependencies": ["ui-design"],
      "required": true,
      "worker_type": "implement",
      "worker_config": { "prompt": "实现 UI" }
    },
    {
      "id": "e2e-test",
      "name": "E2E Integration Test",
      "dependencies": ["api-impl", "ui-impl"],
      "required": true,
      "worker_type": "implement",
      "worker_config": { "prompt": "端到端集成测试" }
    }
  ]
}
```

### 模式 3: 带审查的质量门禁

```json
{
  "name": "quality-gated",
  "max_concurrency": 2,
  "nodes": [
    {
      "id": "implement",
      "name": "Implement",
      "dependencies": [],
      "required": true,
      "worker_type": "implement",
      "worker_config": { "prompt": "实现功能" }
    },
    {
      "id": "verify",
      "name": "Verify",
      "dependencies": ["implement"],
      "required": true,
      "worker_type": "verify",
      "worker_config": { "prompt": "运行验证" }
    },
    {
      "id": "review",
      "name": "Code Review",
      "dependencies": ["verify"],
      "required": false,
      "worker_type": "review",
      "worker_config": { "prompt": "代码审查" }
    },
    {
      "id": "finalize",
      "name": "Finalize",
      "dependencies": ["verify"],
      "required": true,
      "worker_type": "implement",
      "worker_config": { "prompt": "最终确认" }
    }
  ]
}
```

`review` 为可选节点（`required: false`），与 `finalize` 并行执行。即使审查失败，工作流仍可完成。
