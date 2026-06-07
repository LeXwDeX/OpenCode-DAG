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
- [错误处理与 Fallback](#错误处理与-fallback)
- [监控与调试](#监控与调试)
- [常见模式](#常见模式)

---

## 核心概念

### DAG（有向无环图）

DAG 工作流将任务编排建模为有向无环图：
- **节点（Node）**：一个独立的任务单元（如 "实现功能"、"运行测试"）
- **边（Edge）**：节点之间的依赖关系（`depends_on`）
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

DAG 工作流通过 YAML 配置文件定义：

```yaml
# 基础信息
name: my-workflow                # 工作流名称
description: 描述工作流的目的     # 可选

# 系统配置
system:
  sandbox:
    type: git_worktree           # 隔离模式: git_worktree | none
    base_dir: ".task_state"      # worktree 存储位置
    cleanup_on_complete: true    # 完成后自动清理
    keep_on_failure: true        # 失败时保留（便于调试）
  default_merge_strategy: squash # 合并策略: squash | merge | rebase

# 分支与节点定义
branches:
  - name: main                   # 分支名称
    nodes:
      - type: required           # 节点类型
        name: node-name          # 节点名称（全局唯一）
        agent: implement         # 使用的 agent 类型
        task: "节点任务的描述"    # 具体任务
        depends_on: []           # 依赖的上游节点

# 全局约束
constraints:
  max_nodes: 20                  # 最大节点数
  max_concurrency: 3             # 最大并发数
  node_timeout_sec: 600          # 节点超时（秒）
  max_pushes: 3                  # 节点最大推送次数
  max_fallback_chain: 3          # 最大 fallback 链深度
  disable_worktree_isolation: false  # 是否禁用 worktree（不推荐）
```

### 约束参数详解

| 参数 | 默认值 | 范围 | 说明 |
|------|--------|------|------|
| `max_nodes` | 20 | 1-50 | 单个工作流最大节点数量 |
| `max_concurrency` | 3 | 1-10 | 同时执行的最大节点数量 |
| `node_timeout_sec` | 600 | 60-3600 | 单节点最大执行时间 |
| `max_pushes` | 3 | 1-10 | 节点失败后 push 重跑的最大次数 |
| `max_fallback_chain` | 3 | 0-5 | fallback 链最大深度 |
| `disable_worktree_isolation` | false | true/false | 禁用 worktree（测试环境可用） |

---

## 工作流执行模式

### 1. 串行执行

所有节点按依赖顺序依次执行：

```yaml
branches:
  - name: main
    nodes:
      - name: setup
        agent: implement
        task: "初始化项目"
      - name: build
        agent: implement
        task: "构建项目"
        depends_on: [setup]
      - name: test
        agent: implement
        task: "运行测试"
        depends_on: [build]
```

执行顺序: `setup → build → test`

### 2. 并行执行

无依赖关系的节点自动并发：

```yaml
branches:
  - name: main
    nodes:
      - name: lint
        agent: implement
        task: "代码检查"
        depends_on: [setup]
      - name: unit-test
        agent: implement
        task: "单元测试"
        depends_on: [setup]
      - name: e2e-test
        agent: implement
        task: "端到端测试"
        depends_on: [setup]
      - name: setup
        agent: implement
        task: "环境准备"
```

执行: `setup → [lint, unit-test, e2e-test] 并行`

### 3. 菱形 DAG

汇合模式 — 多个并行分支汇总到一个节点：

```yaml
branches:
  - name: main
    nodes:
      - name: analyze
        agent: implement
        task: "分析需求"
      - name: frontend
        agent: implement
        task: "前端实现"
        depends_on: [analyze]
      - name: backend
        agent: implement
        task: "后端实现"
        depends_on: [analyze]
      - name: integration
        agent: implement
        task: "集成测试"
        depends_on: [frontend, backend]
```

执行: `analyze → [frontend, backend] 并行 → integration`

### 4. 多分支

跨分支的独立执行线：

```yaml
branches:
  - name: feature-a
    nodes:
      - name: impl-a
        agent: implement
        task: "实现功能 A"
  - name: feature-b
    nodes:
      - name: impl-b
        agent: implement
        task: "实现功能 B"
```

执行: `[impl-a, impl-b] 完全并行`

---

## 节点配置详解

### 节点类型

| 类型 | 说明 | 必需 |
|------|------|------|
| `required` | 必需节点，失败即工作流失败 | 是 |
| `optional` | 可选节点，失败可跳过 | 否 |
| `shadow` | 影子节点，用于诊断/审查 | 否 |

### 完整节点配置

```yaml
- type: required              # 节点类型
  name: implement-module      # 唯一标识（小写、连字符）
  agent: implement            # agent 类型
  task: |                     # 任务描述（支持多行）
    实现 XX 模块:
    - 创建 src/xx.ts
    - 添加对应测试
    - 确保类型检查通过
  depends_on: [skeleton, tdd] # 依赖节点
  timeout_sec: 300            # 超时时间（覆盖全局）
  max_retries: 2              # 失败重试次数
  skip_on_failure: false      # 上游失败时是否跳过
  fallback:                   # fallback 配置
    node: fallback-handler
    trigger: on_error
```

### Shadow 节点

Shadow 节点用于非侵入式的诊断和审查，不影响主流程：

```yaml
- type: shadow
  name: code-review
  agent: review
  task: "审查已实现代码的质量"
  depends_on: [implement-module]
  fallback:
    node: rerun-implement
    trigger: on_error
    condition: "review verdict is FAIL"
```

**Shadow 节点特点**：
- 不参与暂停传播
- 不产生 `skipped` 状态
- decision 决定被诊断节点的行为

---

## 错误处理与 Fallback

### Fallback 机制

当节点失败时，可配置 fallback 策略：

```yaml
- name: risky-task
  agent: implement
  task: "执行可能失败的任务"
  max_retries: 3               # 重试 3 次
  fallback:
    node: safe-alternative     # fallback 节点名
    trigger: on_error          # 触发条件: always | on_error | on_timeout | custom
    condition: "error contains 'timeout'"  # 可选条件表达式
```

### Fallback 触发条件

| trigger | 说明 |
|---------|------|
| `on_error` | 节点执行失败时触发 |
| `on_timeout` | 节点超时时触发 |
| `always` | 无论结果如何都触发 |
| `custom` | 基于 condition 表达式判断 |

### Push 机制

节点失败后可通过 push 机制重跑：

```
节点失败 → push_count < max_pushes → push 重跑 → 成功/再次失败
                  ↓ 达到上限
              fallback 链
```

### 失败传播

当必需节点失败且 fallback 链耗尽时：
1. 节点状态 → `failed`
2. 下游依赖节点 → `skipped`（如果 `skip_on_failure: true`）
3. 工作流状态 → `failed`

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
| 节点超时 | 任务过于复杂 | 检查 `timeout_sec`，拆分任务 |
| Worktree 创建失败 | Git 仓库状态异常 | 检查磁盘空间、Git 权限 |
| 状态恢复失败 | 数据库连接问题 | 检查 SQLite 文件完整性 |
| 循环依赖 | `depends_on` 配置错误 | 使用 `topologicalSort()` 检测 |
| 节点卡在 running | agent 无响应 | 检查 agent 进程是否正常 |

---

## 常见模式

### 模式 1: CI/CD 流水线

```yaml
name: ci-pipeline
branches:
  - name: main
    nodes:
      - name: checkout
        agent: implement
        task: "拉取代码"
      - name: install
        agent: implement
        task: "安装依赖"
        depends_on: [checkout]
      - name: lint
        agent: implement
        task: "代码检查"
        depends_on: [install]
      - name: unit-test
        agent: implement
        task: "单元测试"
        depends_on: [install]
      - name: build
        agent: implement
        task: "构建产物"
        depends_on: [lint, unit-test]
      - name: deploy
        agent: implement
        task: "部署到生产"
        depends_on: [build]
        timeout_sec: 1800
```

### 模式 2: 多 agent 协作开发

```yaml
name: collaborative-dev
branches:
  - name: backend
    nodes:
      - name: api-design
        agent: architect
        task: "设计 API 接口"
      - name: api-impl
        agent: implement
        task: "实现 API"
        depends_on: [api-design]
  - name: frontend
    nodes:
      - name: ui-design
        agent: architect
        task: "设计 UI 组件"
      - name: ui-impl
        agent: implement
        task: "实现 UI"
        depends_on: [ui-design]
  - name: integration
    nodes:
      - name: e2e-test
        agent: implement
        task: "端到端集成测试"
        depends_on: [api-impl, ui-impl]
```

### 模式 3: 带审查的质量门禁

```yaml
name: quality-gated
branches:
  - name: main
    nodes:
      - name: implement
        agent: implement
        task: "实现功能"
      - name: verify
        agent: implement
        task: "运行验证"
        depends_on: [implement]
      - name: review
        type: shadow
        agent: review
        task: "代码审查"
        depends_on: [verify]
        fallback:
          node: implement        # 审查不通过 → 重新实现
          trigger: custom
          condition: "verdict == FAIL"
      - name: finalize
        agent: implement
        task: "最终确认"
        depends_on: [review]
```
