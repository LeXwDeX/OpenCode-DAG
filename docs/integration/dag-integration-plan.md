# DAG 工作流引擎集成到 OpenCode 方案

> 文档版本: 1.0  
> 创建时间: 2026-06-04  
> 目标: 将 DAG 工作流引擎无缝集成到 OpenCode 架构，复用现有基础设施

---

## 执行摘要

本文档描述了如何将 DAG 工作流引擎（基于 v1.0 架构设计文档）集成到 OpenCode 现有架构中。

**核心策略**: 
- 复用 OpenCode 的 Effect 架构、Agent 系统、Tool 系统、Session 管理
- DAG 引擎作为新的 Service 层，不替代现有 Agent，而是协调多个 Agent 并发执行
- 通过 Plugin API 扩展配置能力，通过 TUI Plugin 实现 Workflow TAB

**实现复杂度**: 中等（预估 8-12 周开发周期）

---

## 1. 现有 OpenCode 架构分析

### 1.1 Agent 系统

**位置**: `packages/opencode/src/agent.ts`

**特点**:
- 基于 ACP (Agent Client Protocol) SDK
- Agent class 实现 ACPAgent 接口
- 核心方法: `initialize`, `newSession`, `prompt`, `cancel`, `loadSession`, `setSessionMode`
- 通过 `connection` 和 `sessionManager` 管理会话
- 支持 `unstable_setSessionModel` 用于模型切换

**关键文件**:
```
packages/opencode/src/agent.ts              # Agent 类定义
packages/acp/session.ts                     # Session Manager
packages/acp/connection.ts                  # Agent 连接
```

### 1.2 Session 管理

**位置**: `packages/opencode/src/session.ts`

**特点**:
- 使用 Drizzle SQLite 存储
- Session 表支持父子关系（`parentID`）
- 状态机: `idle` → `retry` → `busy`
- 支持 token 统计、cost 计算、VCS 信息

**关键文件**:
```
packages/opencode/src/session.ts                        # Session 表定义
packages/opencode/src/session/session-data.ts          # SessionData 类型
packages/opencode/src/session/message.ts               # 消息管理
```

### 1.3 Plugin 系统

**位置**: `packages/opencode/src/plugin/`

**特点**:
- 支持 server 和 tui 两种插件类型
- 插件加载器：resolve → load → initialize
- 插件注册到 slots 和 hooks
- TUI Plugin Runtime 管理 UI 插件生命周期

**Hook 类型**:
```typescript
interface Hooks {
  event?: (input: { event: Event }) => Promise<void>
  config?: (input: Config) => Promise<void>
  'chat.message'?: (input, output) => Promise<void>
  'chat.params'?: (input, output) => Promise<void>
  'permission.ask'?: (input, output) => Promise<void>
  'command.execute.before'?: (input, output) => Promise<void>
}
```

**关键文件**:
```
packages/opencode/src/plugin/loader.ts                  # 插件加载器
packages/opencode/src/plugin/install.ts                 # 插件安装
packages/opencode/src/plugin/runtime.ts                 # TUI Plugin Runtime
packages/opencode/src/plugin/hooks.ts                   # Hook 定义
```

### 1.4 Tool 系统

**位置**: `packages/opencode/src/tool/`

**特点**:
- 工具通过 Effect Schema 定义参数和输出
- 工具执行使用 Effect
- 支持动态工具注册
- 工具权限通过 Agent 配置控制

**内置工具**: bash, read, write, edit, grep, glob, webfetch, todowrite 等

**关键文件**:
```
packages/opencode/src/tool/tool.ts                      # Tool 定义
packages/opencode/src/tool/bash.ts                      # Bash 工具
packages/opencode/src/tool/readwrite.ts                 # 文件读写工具
```

### 1.5 Configuration 系统

**位置**: `packages/opencode/src/config/`

**特点**:
- 支持 JSON/YAML 配置格式
- 多层配置合并：全局 → 项目 → 用户
- 配置热更新（file watcher）

**关键文件**:
```
packages/opencode/src/config/config.ts                  # 配置管理
packages/opencode/src/config/config-schema.ts           # 配置 Schema
packages/opencode/src/config/config-merge.ts            # 配置合并
```

### 1.6 UI/TAB 切换系统

**位置**: `packages/app/src/components/`

**特点**:
- 基于 SolidJS + JSX
- 路由系统支持多页面
- 支持自定义 UI 组件

**关键文件**:
```
packages/app/src/routes/index.tsx                       # 主路由
packages/app/src/components/session-view.tsx            # Session 视图
packages/app/src/components/tabs.tsx                    # TAB 组件
```

### 1.7 Event 系统

**位置**: `packages/core/src/event.ts`

**特点**:
- 基于 Effect 的 PubSub
- 支持事件订阅和发布
- 事件可持久化

**关键文件**:
```
packages/core/src/event.ts                              # Event 定义
packages/opencode/src/bus/index.ts                      # 事件总线
```

### 1.8 State 管理

**位置**: `packages/state/`

**特点**:
- 基于 Effect + Drizzle SQLite
- 支持原子化状态存储
- 支持批量更新

**关键文件**:
```
packages/state/src/store.ts                             # Store 定义
packages/state/src/batch.ts                             # 批量更新
```

### 1.9 Hook 系统（Claude Code Hooks API）

**位置**: OpenCode 完全兼容 Claude Code Hooks 协议

**支持的 22 种事件**:
- PreToolUse, PostToolUse, PostToolUseFailure
- FileChanged, UserPromptSubmit, Stop
- InstructionsLoaded, SessionStart, SessionEnd
- PermissionRequest, PermissionDenied
- SubagentStart, SubagentStop
- TaskCreated, TaskCompleted, TeammateIdle
- PreCompact, PostCompact
- WorktreeCreate, WorktreeRemove
- ConfigChange

**Hook 配置**:
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "./hooks/validate.sh" }]
      }
    ]
  }
}
```

---

## 2. DAG 引擎集成方案

### 2.1 核心架构：DAG 引擎作为新 Service 层

**设计原则**:
- DAG 引擎是 **协调层**，不替代现有 Agent
- 每个 DAG Node 对应一个 Agent Session（复用 ACP）
- 引擎通过 Event 系统广播状态变化
- 引擎通过 Tool 系统提供操作接口

**架构图**:
```
┌─────────────────────────────────────────────────────────────┐
│                         User Interface                       │
│  ┌──────────────────┐           ┌──────────────────────┐    │
│  │    Chat TAB      │           │   Workflow TAB       │    │
│  │  (现有会话视图)   │           │   (DAG 可视化)       │    │
│  └────────┬─────────┘           └──────────┬───────────┘    │
└───────────┼────────────────────────────────┼────────────────┘
            │                                │
            ▼                                ▼
┌─────────────────────────────────────────────────────────────┐
│                      Agent Router                            │
│  - 判断任务类型：简单 → Chat TAB，复杂 → Workflow TAB        │
│  - 调用 /dagworker 命令创建工作流                            │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    DAG Engine Service                        │
│  位置: packages/opencode/src/dag/                           │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  DAG Parser  │  │  Scheduler   │  │  State Manager   │  │
│  │  (YAML 解析) │  │  (任务调度)   │  │  (状态持久化)     │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Worktree    │  │  Shadow Exec │  │  Push Mechanism  │  │
│  │  Manager     │  │  (诊断节点)   │  │  (推进机制)       │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    Agent System (现有)                       │
│  - 每个 DAG Node 作为一个独立的 Agent Session                │
│  - 复用 ACP Connection 和 Session Manager                    │
│  - 通过 Tool 系统调用系统工具（dag_completed 等）            │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 DAG Engine Service 实现

**文件结构**:
```
packages/opencode/src/dag/
├── index.ts                    # 导出所有模块
├── engine.ts                   # DAG 引擎主类
├── types.ts                    # 类型定义
├── parser.ts                   # YAML 解析器
├── scheduler.ts                # 任务调度器
├── state.ts                    # 状态管理
├── worktree.ts                 # Git Worktree 管理
├── shadow.ts                   # Fallback Shadow 节点
├── push.ts                     # Push 机制
├── events.ts                   # 事件定义
├── tools/                      # DAG 相关工具
│   ├── dag-completed.ts        # 节点完成工具
│   ├── dag-inject.ts           # 节点输入注入
│   └── dag-query.ts            # 工作流查询工具
└── hooks/                      # DAG 相关 Hook
    ├── on-node-start.ts
    ├── on-node-complete.ts
    └── on-fallback.ts
```

**核心类定义**:

```typescript
// packages/opencode/src/dag/engine.ts

import { Effect, Layer, Context } from 'effect'
import * as Schema from '@effect/schema/Schema'
import * as Git from '@/git'
import * as Agent from '@/agent'
import * as Session from '@/session'
import * as Event from '@/event'
import * as State from '@opencode/state'

export class DagEngine extends Context.Service('@opencode/DagEngine')<DagEngine> {
  private readonly scheduler: DagScheduler
  private readonly stateManager: DagStateManager
  private readonly worktreeManager: WorktreeManager

  constructor(
    private readonly config: DagConfig,
    private readonly agent: Agent.Agent,
    private readonly git: Git.Git,
    private readonly state: State.Store,
  ) {
    super()
    this.scheduler = new DagScheduler(agent)
    this.stateManager = new DagStateManager(state)
    this.worktreeManager = new WorktreeManager(git)
  }

  /**
   * 启动新的 DAG 工作流
   */
  async startWorkflow(input: {
    yaml: string
    params: Record<string, unknown>
  }): Promise<WorkflowID> {
    return Effect.promise(async () => {
      // 1. 解析 YAML
      const dag = DagParser.parse(input.yaml)
      
      // 2. 验证 DAG 配置
      this.validate(dag)
      
      // 3. 创建 Git Worktree（沙盒）
      const worktree = await this.worktreeManager.create({
        baseBranch: this.config.baseBranch,
      })
      
      // 4. 初始化工作流状态
      const workflowId = await this.stateManager.initWorkflow({
        dag,
        worktree,
        params: input.params,
      })
      
      // 5. 启动调度
      await this.scheduler.start(workflowId)
      
      return workflowId
    }).pipe(Effect.runPromise)
  }

  /**
   * 查询工作流状态
   */
  async queryWorkflow(workflowId: WorkflowID): Promise<WorkflowStatus> {
    return this.stateManager.getWorkflow(workflowId)
  }

  /**
   * 取消工作流
   */
  async cancelWorkflow(workflowId: WorkflowID): Promise<void> {
    await this.scheduler.cancel(workflowId)
    await this.worktreeManager.remove(workflowId)
  }

  /**
   * 验证 DAG 配置
   */
  private validate(dag: DAG): void {
    // 检查 required_nodes
    const requiredNodes = ['skeleton', 'tdd', 'implement']
    for (const nodeName of requiredNodes) {
      if (!dag.nodes.find(n => n.name === nodeName)) {
        throw new Error(`Required node '${nodeName}' is missing`)
      }
    }
    
    // 检查 max_agents
    if (dag.nodes.length > this.config.maxAgents) {
      throw new Error(`Too many nodes: ${dag.nodes.length} > ${this.config.maxAgents}`)
    }
    
    // 检查 global_fallback
    if (!dag.globalFallback) {
      throw new Error('global_fallback is required')
    }
  }
}

// Service 层定义
export namespace DagEngine {
  export const Live = Layer.effect(DagEngine, Effect.gen(function* (_) {
    const config = yield* _(Config.Service)
    const agent = yield* _(Agent.Agent)
    const git = yield* _(Git.Git)
    const state = yield* _(State.Store)
    
    return new DagEngine(config, agent, git, state)
  }))
}
```

### 2.3 DAG Node 执行复用现有 Agent System

**设计**:
- 每个 DAG Node 作为一个独立的 Agent Session
- Node 的 `agent_prompt` 通过 `setSessionMode` 注入
- Node 的执行结果通过 `dag_completed` 工具回传

**集成步骤**:

```typescript
// packages/opencode/src/dag/scheduler.ts

class DagScheduler {
  constructor(private readonly agent: Agent.Agent) {}

  async start(workflowId: WorkflowID): Promise<void> {
    const workflow = await this.stateManager.getWorkflow(workflowId)
    const dag = workflow.dag
    
    // 按拓扑顺序启动节点
    const sorted = this.topologicalSort(dag)
    
    for (const node of sorted) {
      await this.executeNode(workflowId, node)
    }
  }

  private async executeNode(workflowId: WorkflowID, node: DAGNode): Promise<void> {
    // 1. 检查是否已完成
    const nodeState = await this.stateManager.getNode(workflowId, node.name)
    if (nodeState?.status === 'completed') {
      return // 跳过已完成的节点（断点恢复）
    }
    
    // 2. 创建新的 Agent Session
    const sessionId = SessionID.create()
    await this.agent.newSession({
      sessionId,
      model: node.model,
      systemPrompt: await this.buildSystemPrompt(node),
      tools: this.getToolsForNode(node),
    })
    
    // 3. 注入上游输出
    if (node.dependencies) {
      const upstreamOutputs = await this.getUpstreamOutputs(workflowId, node.dependencies)
      await this.agent.injectUpstream(sessionId, upstreamOutputs)
    }
    
    // 4. 启动执行
    const message = await this.agent.prompt({
      sessionId,
      message: 'Start executing your task',
    })
    
    // 5. 监听 dag_completed 工具调用
    await this.waitForCompletion(workflowId, node.name, sessionId)
  }

  private async waitForCompletion(
    workflowId: WorkflowID,
    nodeName: string,
    sessionId: SessionID,
  ): Promise<void> {
    // 监听 Session 事件
    const subscription = this.event.subscribe('tool.call', async (event) => {
      if (event.sessionId === sessionId && event.tool === 'dag_completed') {
        // 节点完成
        await this.handleNodeComplete(workflowId, nodeName, event.output)
      }
    })
    
    // 等待完成或超时
    await Effect.race(
      Effect.promise(() => subscription.waitForCompletion()),
      Effect.sleep(this.config.nodeTimeoutMs).pipe(
        Effect.andThen(() => this.handleNodeTimeout(workflowId, nodeName))
      ),
    ).pipe(Effect.runPromise)
  }

  private async handleNodeComplete(
    workflowId: WorkflowID,
    nodeName: string,
    output: unknown,
  ): Promise<void> {
    // 1. 更新状态
    await this.stateManager.updateNode(workflowId, nodeName, {
      status: 'completed',
      output,
    })
    
    // 2. 触发下游节点
    const downstream = this.getDownstreamNodes(workflowId, nodeName)
    for (const nextNode of downstream) {
      await this.executeNode(workflowId, nextNode)
    }
  }
}
```

### 2.4 DAG 特有工具集成

**新增工具**:

1. **`dag_completed`** — 节点完成信号
2. **`dag_inject`** — 节点输入注入
3. **`dag_query`** — 工作流状态查询
4. **`dag_cancel`** — 取消当前节点

**工具定义示例**:

```typescript
// packages/opencode/src/dag/tools/dag-completed.ts

import { Effect } from 'effect'
import * as Schema from '@effect/schema/Schema'
import * as Tool from '@/tool'

export const DagCompletedTool = Tool.define(
  'dag_completed',
  Schema.Struct({
    output: Schema.Unknown,
    summary: Schema.String,
    filesChanged: Schema.Array(Schema.String),
  }),
  Effect.gen(function* (_) {
    return (args, ctx) =>
      Effect.gen(function* (_) {
        // 1. 验证输出
        yield* _(validateOutput(args.output))
        
        // 2. 记录到状态
        yield* _(State.updateNode({
          workflowId: ctx.workflowId,
          nodeName: ctx.nodeName,
          status: 'completed',
          output: args.output,
          summary: args.summary,
          filesChanged: args.filesChanged,
        }))
        
        // 3. 发布事件
        yield* _(Event.publish('dag.node.completed', {
          workflowId: ctx.workflowId,
          nodeName: ctx.nodeName,
          output: args.output,
        }))
        
        return {
          success: true,
          message: 'Node completed successfully',
        }
      })
  }),
)
```

### 2.5 配置系统集成

**方案**: 通过 Plugin API 扩展配置能力

**配置加载**:

```typescript
// packages/opencode/src/config/dag-config.ts

import * as Schema from '@effect/schema/Schema'
import * as FS from '@opencode/filesystem'

export const DagConfigSchema = Schema.Struct({
  maxAgents: Schema.Number.annotations({ default: 10 }),
  maxFallbackChain: Schema.Number.annotations({ default: 3 }),
  nodeTimeoutMs: Schema.Number.annotations({ default: 300_000 }),
  pushIntervalMs: Schema.Number.annotations({ default: 5_000 }),
  sandboxType: Schema.Union([
    Schema.Literal('git-worktree'),
    Schema.Literal('fake'),
  ]).annotations({ default: 'git-worktree' }),
  mergeStrategy: Schema.Union([
    Schema.Literal('squash'),
    Schema.Literal('merge'),
    Schema.Literal('rebase'),
  ]).annotations({ default: 'squash' }),
  lspEnabled: Schema.Boolean.annotations({ default: true }),
})

export type DagConfig = Schema.Schema.Type<typeof DagConfigSchema>

export async function loadDagConfig(): Promise<DagConfig> {
  // 1. 从 ~/.config/opencode/workflow/SYSTEM.yaml 加载
  const globalConfig = await FS.readFile('~/.config/opencode/workflow/SYSTEM.yaml')
    .pipe(
      Effect.flatMap((content) => Schema.decode(DagConfigSchema)(content)),
      Effect.catchAll(() => Effect.succeed({})),
    )
  
  // 2. 从 <project>/.opencode/workflow.yaml 加载
  const projectConfig = await FS.readFile('./.opencode/workflow.yaml')
    .pipe(
      Effect.flatMap((content) => Schema.decode(DagConfigSchema)(content)),
      Effect.catchAll(() => Effect.succeed({})),
    )
  
  // 3. 合并配置
  return {
    ...DagConfigSchema.default,
    ...globalConfig,
    ...projectConfig,
  }
}
```

### 2.6 UI 集成：Workflow TAB

**方案**: 通过 TUI Plugin 实现 Workflow TAB

**实现步骤**:

1. **创建 TUI Plugin**: `@opencode/plugin-workflow-tab`
2. **注册到 OpenCode**: 在 `opencode.json` 中配置
3. **实现 UI 组件**:
   - DAG 可视化（拓扑图）
   - 节点状态面板
   - 工作流日志
   - 配置编辑器

**UI 组件示例**:

```typescript
// packages/plugin-workflow-tab/src/index.ts

import { TuiPlugin } from '@opencode/plugin-tui'
import { createSignal, For, Show } from 'solid-js'

export const WorkflowTab: TuiPlugin = {
  name: 'workflow-tab',
  
  onInit: (api) => {
    // 注册新的 TAB
    api.registerTab({
      id: 'workflow',
      label: 'Workflow',
      component: WorkflowView,
    })
  },
}

function WorkflowView() {
  const [workflows, setWorkflows] = createSignal<Workflow[]>([])
  
  // 订阅工作流事件
  Event.subscribe('dag.workflow.*', (event) => {
    setWorkflows((prev) => [...prev, event.workflow])
  })
  
  return (
    <div class="workflow-tab">
      <h1>DAG Workflows</h1>
      
      <For each={workflows()}>
        {(workflow) => (
          <WorkflowCard workflow={workflow} />
        )}
      </For>
    </div>
  )
}

function WorkflowCard(props: { workflow: Workflow }) {
  return (
    <div class="workflow-card">
      <h3>{props.workflow.name}</h3>
      <p>Status: {props.workflow.status}</p>
      
      <div class="dag-graph">
        <For each={props.workflow.nodes}>
          {(node) => (
            <NodeBox node={node} />
          )}
        </For>
      </div>
    </div>
  )
}
```

### 2.7 Git Worktree 集成

**复用现有 Git 模块**: `packages/opencode/src/git.ts`

**工作**:
- 实现 Worktree 管理器
- 支持并发 Worktree 管理
- 实现 Merge 策略

**实现示例**:

```typescript
// packages/opencode/src/dag/worktree-manager.ts

import * as Git from '@/git'
import { Effect } from 'effect'

class WorktreeManager {
  constructor(private readonly git: Git.Git) {}

  /**
   * 创建 Git Worktree（沙盒）
   */
  async create(input: {
    baseBranch: string
    workflowId: WorkflowID
  }): Promise<WorktreePath> {
    return Effect.gen(function* (_) {
      const worktreePath = yield* _(
        this.git.worktreeAdd({
          path: `.worktrees/${input.workflowId}`,
          base: input.baseBranch,
        })
      )
      
      return worktreePath
    }).pipe(Effect.runPromise)
  }

  /**
   * 移除 Git Worktree
   */
  async remove(workflowId: WorkflowID): Promise<void> {
    return Effect.gen(function* (_) {
      yield* _(
        this.git.worktreeRemove({
          path: `.worktrees/${workflowId}`,
        })
      )
    }).pipe(Effect.runPromise)
  }

  /**
   * 合并 Worktree 到主分支
   */
  async merge(workflowId: WorkflowID, strategy: MergeStrategy): Promise<void> {
    return Effect.gen(function* (_) {
      const worktreePath = `.worktrees/${workflowId}`
      
      // 1. 切换到主分支
      yield* _(this.git.checkout({ branch: 'main' }))
      
      // 2. 根据策略合并
      switch (strategy) {
        case 'squash':
          yield* _(this.git.merge({
            branch: worktreePath,
            squash: true,
          }))
          break
          
        case 'merge':
          yield* _(this.git.merge({
            branch: worktreePath,
          }))
          break
          
        case 'rebase':
          yield* _(this.git.rebase({
            branch: worktreePath,
          }))
          break
      }
      
      // 3. 移除 Worktree
      yield* _(this.git.worktreeRemove({ path: worktreePath }))
    }).pipe(Effect.runPromise)
  }
}
```

### 2.8 Hook 集成（Claude Code Hooks API）

**支持的 Hook 事件**:

| DAG 事件 | 对应的 Claude Code Hook | 用途 |
|---------|----------------------|------|
| dag.node.start | TaskCreated | 节点创建时 |
| dag.node.execute | SubagentStart | Agent Session 启动时 |
| dag.node.complete | SubagentStop | Agent Session 结束时 |
| dag.node.failed | TaskCompleted | 任务完成时 |
| dag.fallback.trigger | - | Fallback 触发时 |
| dag.workflow.complete | TaskCompleted | 工作流完成时 |

**配置示例**:

```json
{
  "hooks": {
    "TaskCreated": [
      {
        "matcher": "dag.node.*",
        "hooks": [
          {
            "type": "command",
            "command": "./hooks/on-node-start.sh"
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "matcher": "dag.node.*",
        "hooks": [
          {
            "type": "command",
            "command": "./hooks/on-node-execute.sh"
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "matcher": "dag.node.*",
        "hooks": [
          {
            "type": "command",
            "command": "./hooks/on-node-complete.sh"
          }
        ]
      }
    ]
  }
}
```

---

## 3. 关键实现步骤

### Phase 1: 核心基础设施（2-3 周）

- [ ] 实现 DAG Engine Service（`packages/opencode/src/dag/engine.ts`）
- [ ] 实现 DAG Parser（`packages/opencode/src/dag/parser.ts`）
- [ ] 实现 DAG State Manager（`packages/opencode/src/dag/state.ts`）
- [ ] 实现 DAG Scheduler（`packages/opencode/src/dag/scheduler.ts`）
- [ ] 实现 Git Worktree Manager（`packages/opencode/src/dag/worktree.ts`）
- [ ] 实现 Shadow 节点执行器（`packages/opencode/src/dag/shadow.ts`）
- [ ] 实现 Push 机制（`packages/opencode/src/dag/push.ts`）

**关键决策**: 
- 使用 Effect 架构统一管理异步流程
- 状态持久化使用 Drizzle SQLite（复用现有）
- Worktree 管理复用现有 Git 模块

### Phase 2: Agent 集成（1-2 周）

- [ ] 实现 DAG Node 的 Agent Session 创建逻辑
- [ ] 实现 `dag_completed` 工具定义
- [ ] 实现 `dag_inject` 工具定义
- [ ] 实现节点输入注入机制
- [ ] 实现节点工具权限控制
- [ ] 实现 Shadow 节点工具（`dag_shadow_complete`）

**关键决策**:
- 每个 DAG Node 作为独立的 Agent Session
- 通过 `setSessionMode` 注入节点配置
- 通过 Tool 系统传递节点上下文

### Phase 3: 配置系统（1 周）

- [ ] 设计 DAG 配置 Schema（`packages/opencode/src/config/dag-config.ts`）
- [ ] 实现 SYSTEM.yaml 加载器
- [ ] 实现项目级 workflow.yaml 加载器
- [ ] 实现配置合并逻辑（Global + Project + User）
- [ ] 实现配置热更新（File Watcher）

**关键决策**:
- 配置优先级：User > Project > Global
- 配置热更新：监听文件变化，动态重新加载
- 配置验证：使用 Effect Schema 进行强类型验证

### Phase 4: 工具系统（1 周）

- [ ] 实现 `dag_completed` 工具（节点完成信号）
- [ ] 实现 `dag_inject` 工具（输入注入）
- [ ] 实现 `dag_query` 工具（状态查询）
- [ ] 实现 `dag_cancel` 工具（取消节点）
- [ ] 实现 `dag_shadow_complete` 工具（Shadow 节点完成）
- [ ] 实现 `/dagworker` 命令集成

**关键决策**:
- 工具定义使用 Effect Schema
- 工具执行使用 Effect
- 工具权限通过 Agent 配置控制

### Phase 5: UI 集成（2-3 周）

- [ ] 创建 Workflow TAB TUI Plugin（`packages/plugin-workflow-tab`）
- [ ] 实现 DAG 可视化组件（拓扑图）
- [ ] 实现节点状态面板
- [ ] 实现工作流日志视图
- [ ] 实现配置编辑器（SYSTEM.yaml 编辑）
- [ ] 实现工作流启动对话框（创建新工作流）

**关键决策**:
- 使用 SolidJS + JSX（复用现有 UI 框架）
- DAG 可视化使用 SVG 或 Canvas
- 状态更新通过 Event 系统实时推送

### Phase 6: Hook 集成（1 周）

- [ ] 实现 DAG 事件发布（`Event.publish('dag.node.*')`）
- [ ] 实现 Hook 配置加载（`hooks.json`）
- [ ] 实现 Hook 执行器（Command Hook, Webhook Hook）
- [ ] 实现 Hook 错误处理（失败重试、告警）
- [ ] 集成 Claude Code Hooks API（22 种事件）

**关键决策**:
- Hook 执行使用 Effect
- 支持多种 Hook 类型：Command、Webhook
- Hook 失败不影响主流程（异步执行）

### Phase 7: /dagworker CLI（1 周）

- [ ] 实现 `/dagworker` 命令解析器
- [ ] 实现子命令：`list`, `create`, `query`, `cancel`, `shadow`
- [ ] 实现交互式工作流创建向导
- [ ] 实现实时状态显示（SSE 或 WebSocket）
- [ ] 实现配置验证和提示

**关键决策**:
- 使用 OpenCode 现有的 CLI 框架
- 实时状态更新使用 SSE 或 WebSocket
- /dagworker 命令作为独立子命令

### Phase 8: 测试与文档（1-2 周）

- [ ] 单元测试（Jest / Vitest）
  - DAG Parser
  - DAG Scheduler
  - DAG State Manager
  - Git Worktree Manager
  - Shadow 节点执行器
- [ ] 集成测试
  - 端到端工作流执行
  - 并发节点调度
  - Fallback 机制
  - 断点恢复
- [ ] 文档编写
  - API 文档
  - 配置说明
  - 用户指南
  - 示例工作流

---

## 4. 关键设计决策

### 4.1 DAG 引擎位置

**选项 1**: 作为新 Service 层集成到 Core（推荐）
- 优点：复用现有基础设施，与 Agent System 深度集成
- 缺点：代码量较大，需要理解现有架构

**选项 2**: 作为独立包开发
- 优点：独立性强，便于测试和维护
- 缺点：与 Core 集成较松，可能需要较多胶水代码

**选项 3**: 作为 Plugin 开发
- 优点：最小化对 Core 的侵入
- 缺点：功能受限，某些 Hook 不可用

**决策**: 选择选项 1，作为新 Service 层集成到 Core。

### 4.2 Git 工作树支持

**选项 1**: 复用现有 Git 模块（推荐）
- 优点：最小化重复代码，利用现有功能
- 缺点：可能需要扩展 Git API

**选项 2**: 使用第三方 Git 库（如 `simple-git`）
- 优点：API 更完善
- 缺点：引入新依赖，可能与现有代码冲突

**选项 3**: 实现自定义 Git 封装
- 优点：灵活性强
- 缺点：维护成本高

**决策**: 选择选项 1，复用现有 Git 模块。

### 4.3 状态持久化方案

**选项 1**: 使用 Drizzle SQLite（推荐）
- 优点：与现有 State 系统一致，支持事务
- 缺点：需要学习 Drizzle API

**选项 2**: 使用 JSON 文件
- 优点：简单易实现
- 缺点：不支持并发，事务不可靠

**选项 3**: 使用 Redis
- 优点：高性能，支持分布式
- 缺点：引入新依赖，单机部署不需要

**决策**: 选择选项 1，使用 Drizzle SQLite。

### 4.4 UI 框架选择

**选项 1**: 使用 TUI Plugin（推荐）
- 优点：与 OpenCode UI 一致，复用现有组件
- 缺点：学习成本

**选项 2**: 使用 Web UI（如 React）
- 优点：现代化，用户体验好
- 缺点：需要额外的构建和部署

**选项 3**: 无 UI，仅通过 CLI 交互
- 优点：简单易实现
- 缺点：用户体验差

**决策**: 选择选项 1，使用 TUI Plugin。

### 4.5 节点并发限制

**设计**: 通过配置项 `maxAgents` 控制最大并发节点数

**理由**:
- 避免过度消耗资源（CPU、内存、网络）
- 便于调试和监控
- 支持动态调整（通过热更新配置）

**实现**:
```typescript
class DagScheduler {
  private readonly maxConcurrent = 3 // 从配置读取
  
  async start(workflowId: WorkflowID): Promise<void> {
    const queue = new TaskQueue(this.maxConcurrent)
    
    for (const node of topologicallySortedNodes) {
      queue.add(() => this.executeNode(workflowId, node))
    }
    
    await queue.waitForAll()
  }
}
```

### 4.6 Fallback 机制

**设计**: 多级 Fallback（节点级 → 工作流级）

**实现**:
```typescript
class DagScheduler {
  private async handleNodeFailure(
    workflowId: WorkflowID,
    node: DAGNode,
    error: Error,
  ): Promise<void> {
    // 1. 尝试节点级 Fallback
    if (node.fallback) {
      await this.executeFallback(node.fallback, node, error)
      return
    }
    
    // 2. 尝试工作流级 Fallback
    if (this.dag.globalFallback) {
      await this.executeFallback(this.dag.globalFallback, node, error)
      return
    }
    
    // 3. 无 Fallback，工作流失败
    await this.abortWorkflow(workflowId, error)
  }
}
```

### 4.7 断点恢复

**设计**: 基于状态检查点（Checkpoint）实现断点恢复

**实现**:
```typescript
class DagScheduler {
  async recover(workflowId: WorkflowID): Promise<void> {
    const workflow = await this.stateManager.getWorkflow(workflowId)
    
    if (workflow.status !== 'running') {
      return // 无需恢复
    }
    
    // 找到所有已完成的节点
    const completedNodes = workflow.nodes.filter(
      (n) => n.status === 'completed'
    )
    
    // 继续执行未完成的节点
    const pendingNodes = this.getPendingNodes(workflow, completedNodes)
    
    for (const node of pendingNodes) {
      await this.executeNode(workflowId, node)
    }
  }
}
```

---

## 5. 性能与可扩展性

### 5.1 性能考虑

**并发控制**:
- 限制最大并发节点数（默认 3）
- 使用任务队列（TaskQueue）调度节点
- 避免过度消耗 CPU 和内存

**资源隔离**:
- 每个节点在独立的 Git Worktree 中运行
- Agent Session 独立，不共享状态
- 工具执行隔离，避免资源冲突

**状态查询优化**:
- 使用索引优化 SQLite 查询性能
- 批量更新状态（State.batch）
- 缓存热点数据（工作流状态、节点状态）

### 5.2 可扩展性

**水平扩展**:
- 当前版本为单实例部署
- 未来可考虑分布式部署（多 Worker 节点）
- 使用 Redis 作为分布式状态存储

**插件扩展**:
- 支持自定义 Hook（Command Hook、Webhook Hook）
- 支持自定义 UI 组件（Workflow TAB）
- 支持自定义工具（dag_completed、dag_inject 等）

**配置扩展**:
- 支持多层配置合并（Global + Project + User）
- 支持配置热更新（File Watcher）
- 支持配置验证（Effect Schema）

---

## 6. 安全与隔离

### 6.1 沙箱隔离

**Git 工作树沙箱**:
- 每个工作流在独立的 Git Worktree 中运行
- 工作流之间完全隔离，不共享文件
- Worktree 自动清理，不产生垃圾

**Agent Session 隔离**:
- 每个节点创建独立的 Agent Session
- Session 之间不共享上下文
- Session 超时自动清理

**工具权限隔离**:
- 通过 Agent 配置控制工具权限（allow / deny）
- 每个节点只能调用配置允许的工具
- 敏感工具（如 bash）需要额外授权

### 6.2 权限控制

**配置权限**:
- 全局配置（SYSTEM.yaml）需要管理员权限
- 项目配置（workflow.yaml）开发者可读
- 用户配置（user config）仅创建者可见

**工具权限**:
- 系统工具（read、write）默认可用
- 用户工具（bash）需要显式授权
- 危险工具（git push、npm publish）需要额外确认

**Hook 权限**:
- Hook 执行需要相应权限（命令执行权限、网络访问权限）
- Hook 失败不影响主流程（异步执行）
- Hook 执行日志可查看

---

## 7. 测试策略

### 7.1 单元测试

**覆盖范围**:
- DAG Parser：YAML 解析、Schema 验证
- DAG Scheduler：拓扑排序、并发控制、Fallback 机制
- DAG State Manager：状态更新、查询、持久化
- Git Worktree Manager：Worktree 创建、移除、合并
- Shadow 节点执行器：诊断逻辑、决策生成
- Push 机制：推进逻辑、超时处理

**工具**:
- Jest 或 Vitest
- Effect Test Utils
- Mock Git（使用 `simple-git` 的 mock）

### 7.2 集成测试

**覆盖范围**:
- 端到端工作流执行（完整 DAG）
- 并发节点调度（多节点并行）
- Fallback 机制（失败恢复）
- 断点恢复（状态检查和恢复）
- 配置合并（多层配置）

**工具**:
- Docker（隔离测试环境）
- Testcontainers（PostgreSQL、Redis）
- Git Worktree（实际 Git 操作）

### 7.3 性能测试

**覆盖范围**:
- 大规模 DAG（100+ 节点）
- 高并发场景（10+ 并发节点）
- 长时间运行工作流（1+ 小时）

**工具**:
- k6（负载测试）
- Prometheus（指标收集）
- Grafana（可视化）

---

## 8. 部署与运维

### 8.1 部署要求

**硬件要求**:
- CPU: 2+ cores
- Memory: 4+ GB
- Storage: 10+ GB（Git Worktree 占用）
- Network: 稳定连接（Agent API 调用）

**软件要求**:
- Node.js: 20+
- Git: 2.40+
- SQLite: 3.40+
- OpenCode: 最新版

### 8.2 部署步骤

**步骤 1**: 安装依赖
```bash
npm install
npm run build
```

**步骤 2**: 配置 DAG
```bash
# 全局配置
vi ~/.config/opencode/workflow/SYSTEM.yaml

# 项目配置
vi .opencode/workflow.yaml
```

**步骤 3**: 启动 OpenCode
```bash
opencode
```

**步骤 4**: 创建工作流
```bash
/dagworker create
```

### 8.3 监控与告警

**监控指标**:
- 工作流执行时间
- 节点执行时间
- Fallback 触发次数
- Push 触发次数
- 工具调用次数
- Token 使用量

**告警规则**:
- 工作流执行时间 > 1 小时
- 节点连续 Fallback > 3 次
- Token 使用量 > 预算上限
- 异常错误率 > 5%

**工具**:
- Prometheus（指标收集）
- Grafana（可视化）
- Slack / Email（告警通知）

---

## 9. 成本与时间线

### 9.1 开发成本估计

**代码量**:
- DAG Engine Core: ~3,000 行 TypeScript
- Agent 集成: ~1,500 行
- 配置系统: ~1,000 行
- 工具系统: ~1,000 行
- UI 集成: ~2,500 行
- Hook 集成: ~1,000 行
- CLI 集成: ~1,500 行
- 测试代码: ~2,500 行

**总计**: ~12,000 行 TypeScript

**人力投入**:
- 1 名高级开发者（8-12 周）
- 1 名初级开发者（6-8 周，并行开发）

### 9.2 时间线

**Week 1-3**: 核心基础设施
- [ ] DAG Engine Service
- [ ] DAG Parser
- [ ] DAG State Manager
- [ ] DAG Scheduler
- [ ] Git Worktree Manager

**Week 4-5**: Agent 集成
- [ ] Agent Session 创建
- [ ] dag_completed 工具
- [ ] 节点输入注入
- [ ] Shadow 节点执行器

**Week 6**: 配置系统
- [ ] DAG 配置 Schema
- [ ] SYSTEM.yaml 加载器
- [ ] 配置热更新

**Week 7**: 工具系统
- [ ] dag_inject 工具
- [ ] dag_query 工具
- [ ] dag_cancel 工具
- [ ] /dagworker 命令

**Week 8-10**: UI 集成
- [ ] Workflow TAB TUI Plugin
- [ ] DAG 可视化
- [ ] 节点状态面板
- [ ] 工作流日志

**Week 11**: Hook 集成
- [ ] DAG 事件发布
- [ ] Hook 配置加载
- [ ] Hook 执行器
- [ ] Claude Code Hooks API

**Week 12**: 测试与文档
- [ ] 单元测试
- [ ] 集成测试
- [ ] 性能测试
- [ ] 文档编写

---

## 10. 风险与应对

### 10.1 技术风险

**风险 1**: 与现有 Agent System 集成复杂
- 应对：充分理解现有架构，渐进式集成
- 缓解：早期原型验证（Spike）

**风险 2**: Git Worktree 管理复杂
- 应对：复用现有 Git 模块，最小化扩展
- 缓解：充分测试各种场景（并发、合并冲突）

**风险 3**: 状态持久化性能问题
- 应对：使用索引优化，批量更新
- 缓解：性能测试覆盖大规模场景

**风险 4**: Hook 执行不稳定
- 应对：异步执行，失败重试
- 缓解：Hook 超时控制，自动重试

### 10.2 运维风险

**风险 1**: 工作流执行失败
- 应对：Fallback 机制，断点恢复
- 缓解：充分测试各种失败场景

**风险 2**: 资源过度消耗
- 应对：并发控制，资源限制
- 缓解：监控指标，自动告警

**风险 3**: 配置错误
- 应对：配置验证，热更新回滚
- 缓解：配置变更审计日志

### 10.3 商业风险

**风险 1**: 开发周期过长
- 应对：敏捷开发，每周交付 MVP
- 缓解：优先级排序，核心功能优先

**风险 2**: 功能过于复杂
- 应对：渐进式发布，V1 聚焦核心功能
- 缓解：用户反馈收集，持续迭代

**风险 3**: 市场竞争
- 应对：差异化优势（DAG 工作流）
- 缓解：快速迭代，响应市场需求

---

## 11. 总结

### 11.1 核心价值

**对 OpenCode**:
- 增加 DAG 工作流能力，支持复杂任务编排
- 复用现有基础设施，最小化代码侵入
- 通过 Plugin API 扩展配置能力，保持灵活性

**对 Agent**:
- 独立 Session 执行，不污染主 Agent 上下文
- 通过 Tool 系统传递节点上下文，保持隔离性
- 通过 Shadow 节点实现故障恢复，提高稳定性

**对用户**:
- 可视化工作流执行，实时查看进度
- /dagworker 命令快速启动工作流
- Hook 系统支持自定义扩展，满足多样需求

### 11.2 关键特性

- ✅ DAG 工作流编排（多节点、多分支）
- ✅ Git Worktree 沙箱（隔离执行环境）
- ✅ Shadow 节点诊断（故障恢复机制）
- ✅ 断点恢复能力（状态检查和恢复）
- ✅ 配置热更新（多层配置合并）
- ✅ Hook 系统扩展（自定义 Hook）
- ✅ UI 可视化（Workflow TAB）
- ✅ /dagworker CLI（命令行交互）

### 11.3 下一步行动

1. **评审本文档**：与团队讨论集成方案，收集反馈
2. **原型验证**：实现最小可行版本（Spike），验证核心设计
3. **分阶段开发**：按照时间线，逐步实现各功能模块
4. **持续测试**：每阶段完成后进行单元测试和集成测试
5. **文档同步**：开发过程中同步编写 API 文档和用户指南

---

**文档结束**
