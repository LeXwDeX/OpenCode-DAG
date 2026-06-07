# DAG Session 模块设计（含 Chat 集成）

> **版本**: 2.0 ⭐ 取代 v1.0
> **状态**: 设计完成，待评审
> **创建日期**: 2026-06-05
> **更新日期**: 2026-06-05
> **作者**: DAG 架构团队
> **前置文档**: 005-ahe-principles.md, 006-dag-ui-display.md

---

## 0. v2 变更摘要

v1.0 设计试图复用 OpenCode 的 Session 系统，但产生了 4 个产品需求偏离：
1. ❌ Chat→Workflow 触发机制缺失
2. ❌ 跨模式历史查看不完整
3. ❌ Worker 级执行追踪粒度不足
4. ❌ required_nodes 约束验证缺失

**v2.0 核心调整**:

1. **放弃复用 OpenCode Session**，改为 DAG 拥有独立的 Session 模块（`src/dag/session/`）
2. **明确 DDD Bounded Context**：DAG Session 与 OpenCode Session 是两个独立限界上下文，互不共享代码
3. **补齐 4 个偏离的产品功能**：触发器、图查询、执行追踪、约束验证
4. **⭐ 用户确认的三层架构**：
   - **代码层独立**：DAG Session 完全独立（自己的 SQLite 表、EventBus、Service）
   - **对话层不割裂**：DAG 状态通过 synthetic message 注入到触发它的 Chat Session
   - **执行层 Hook 驱动**：`/dag-worker` slashcommand 直接走 DAG 新执行线（非 LLM 调用）

---

## 1. 核心架构原则 ⭐

### 1.1 DAG Session 独立拥有原则（DDD Bounded Context）

**原则**: DAG 模块拥有自己的 Session 实现，与 OpenCode Session（`src/session/`）完全独立。

**理由**:

| 维度 | 独立的优势 | 复用的劣势 |
|------|-----------|-----------|
| **演化自由** | DAG Session 可独立演进，无需等待 OpenCode Session 团队对齐 | OpenCode Session 一旦变化（如移除 `session_type='workflow'` 字段），DAG 立即被破坏 |
| **实现简繁** | DAG Session 极简实现：SQLite + EventBus（DAG 已有），无 Effect / SyncEvent / Projector | 复用路径要学习 Effect、SyncEvent 抽象，理解成本高 |
| **故障隔离** | DAG Session 出问题不影响 Chat | Session 出问题会同时影响 Chat 和 DAG |
| **性能控制** | 独立的 SQLite 表、索引、缓存策略 | 共享 SessionTable 会成为热点表 |
| **测试范围** | 仅测 DAG 代码路径 | 需 mock 整个 OpenCode Session 服务栈 |

**约束**:

> ❌ **禁止**: DAG 模块 import `src/session/*`、`src/sync/*`、`src/acp/session.ts`
>
> ✅ **必须**: DAG 模块使用 `src/dag/session/*` 提供的 API

**类比**: 类似微服务架构中的 "每个服务拥有自己的数据库"——不是拒绝通信，而是拒绝共享底层状态。

### 1.2 与 OpenCode Session 的关系

DAG Session 与 OpenCode Session 是 **"跨限界上下文的关系"**，通过显式的 **标识符引用** 而非代码共享：

```
OpenCode Session                DAG Session
┌─────────────┐                ┌──────────────────┐
│ Session A   │                │ DAG Workflow B   │
│ (chat)      │ ──────────────→│                  │
│ id: ss_abc  │  source_chat_  │ source_session_id│
│             │  session_id    │  = "ss_abc"      │
└─────────────┘                └──────────────────┘
        │                               │
        │                               │ (parent_id)
        │                               v
        │                      ┌──────────────────┐
        │                      │ DAG Node C       │
        │                      │ parent_id = B.id │
        │                      └──────────────────┘
```

**关键点**:
- `source_session_id` 是 **字符串引用**，不是外键约束（两个独立数据库）
- 删除 OpenCode Session 时，DAG Session 中的引用变成"悬挂"（dangling），由 DAG Session 容错处理
- 查询跨上下文数据通过 DAG Session 的图查询 API

---

## 2. DAG Session 数据模型

### 2.1 Schema 设计

```typescript
// src/dag/session/types.ts

/**
 * DAG Workflow Session
 *
 * 代表一个完整的 DAG 工作流执行实例。
 */
export interface WorkflowSession {
  id: string                           // workflow session id (例如: "wf_xyz")
  type: 'workflow'

  // 关联字段
  source_chat_session_id?: string      // 触发该工作流的 chat session id（可选）
  name: string                         // 工作流名称（例如: "refactor-module", "implement-feature"）

  // 配置
  config: WorkflowConfig

  // 状态
  status: WorkflowStatus
  progress: WorkflowProgress

  // 约束跟踪
  required_nodes_status: RequiredNodesStatus

  // 时间戳
  created_at: number
  started_at?: number
  completed_at?: number

  // 元数据
  metadata?: Record<string, unknown>
}

export type WorkflowStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'failed_with_violation'  // ⭐ 偏离4: 区分违规失败与普通失败
  | 'cancelled'

export interface WorkflowProgress {
  completed_nodes: number
  total_nodes: number
  running_nodes: number
  pending_nodes: number
  failed_nodes: number
}

/**
 * required_nodes 跟踪状态
 *
 * ⭐ 偏离4: 显式跟踪 required_nodes 的完成情况
 */
export interface RequiredNodesStatus {
  required_ids: string[]               // 配置中的 required_nodes
  completed_ids: string[]              // 已完成
  skipped_ids: string[]                // 被跳过（违规）
  failed_ids: string[]                 // 执行失败的 required nodes
}

export interface WorkflowConfig {
  nodes: NodeDefinition[]
  dependencies: Record<string, string[]>
  required_nodes: string[]             // 不可跳过的节点 ID 列表
  max_concurrency: number
}

export interface NodeDefinition {
  id: string
  name: string
  type: WorkerType
  config: Record<string, unknown>
}
```

### 2.2 DAG Node Session（Worker 执行单元）

```typescript
/**
 * DAG Node Session
 *
 * 代表一个 Worker 的执行实例。是 Workflow 的子 Session。
 */
export interface NodeSession {
  id: string                           // node session id (例如: "wn_abc")
  type: 'workflow_node'

  // 关联字段
  workflow_id: string                  // 父 Workflow Session ID
  node_name: string                    // 配置中的 node name
  worker_id: string                    // Scheduler 中的 worker ID

  // 状态
  status: WorkerStatus

  // ⭐ 偏离3: 详细的执行追踪
  output: unknown                      // Worker 输出结果
  execution_log: string                // stdout/stderr 完整日志
  state_history: StateTransition[]     // 状态变化时间线
  metrics: ExecutionMetrics            // 资源消耗
  error_info?: ErrorInfo               // 错误详情

  // 重试
  retry_count: number

  // 时间戳
  created_at: number
  started_at?: number
  completed_at?: number

  // 元数据
  metadata?: Record<string, unknown>
}

/**
 * 状态转换记录
 * ⭐ 偏离3: 完整的状态历史
 */
export interface StateTransition {
  from_status: WorkerStatus
  to_status: WorkerStatus
  timestamp: number
  reason: string                       // 转换原因（例如: "dependency_completed", "timeout"）
}

/**
 * 执行指标
 * ⭐ 偏离3: Worker 资源消耗
 */
export interface ExecutionMetrics {
  duration_ms: number
  cpu_usage_avg?: number               // 平均 CPU 使用率 (%)
  cpu_usage_peak?: number
  memory_mb_avg?: number               // 平均内存 (MB)
  memory_mb_peak?: number
  tokens_input?: number                // LLM token 消耗
  tokens_output?: number
  api_calls?: number                   // 外部 API 调用次数
}

/**
 * 错误详情
 * ⭐ 偏离3: 结构化错误信息
 */
export interface ErrorInfo {
  message: string
  stack?: string
  code?: string                        // 错误码
  retry_attempt: number                // 第几次重试时失败
  caused_by?: string                   // 上游节点名（如果是级联失败）
}

export type WorkerStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'skipped'                         // ⭐ 偏离4: 显式标记为跳过
```

### 2.3 SQLite 表结构

```sql
-- src/dag/session/schema.sql

-- 工作流 Session 表
CREATE TABLE dag_workflow_sessions (
  id                        TEXT PRIMARY KEY,
  source_chat_session_id    TEXT,                          -- 可选：来源 chat session
  name                      TEXT NOT NULL,
  status                    TEXT NOT NULL,
  config                    TEXT NOT NULL,                 -- JSON
  progress                  TEXT NOT NULL,                 -- JSON (WorkflowProgress)
  required_nodes_status     TEXT NOT NULL,                 -- JSON (RequiredNodesStatus)
  metadata                  TEXT,                          -- JSON, nullable
  created_at                INTEGER NOT NULL,
  started_at                INTEGER,
  completed_at              INTEGER
);

CREATE INDEX idx_dag_wf_source ON dag_workflow_sessions(source_chat_session_id);
CREATE INDEX idx_dag_wf_status ON dag_workflow_sessions(status);

-- 工作流节点 Session 表
CREATE TABLE dag_node_sessions (
  id                        TEXT PRIMARY KEY,
  workflow_id               TEXT NOT NULL,                 -- 父 Workflow Session
  node_name                 TEXT NOT NULL,
  worker_id                 TEXT NOT NULL,
  status                    TEXT NOT NULL,
  output                    TEXT,                          -- JSON, nullable
  execution_log             TEXT DEFAULT '',               -- 完整日志
  state_history             TEXT DEFAULT '[]',             -- JSON array
  metrics                   TEXT DEFAULT '{}',             -- JSON object
  error_info                TEXT,                          -- JSON, nullable
  retry_count               INTEGER DEFAULT 0,
  created_at                INTEGER NOT NULL,
  started_at                INTEGER,
  completed_at              INTEGER,
  FOREIGN KEY (workflow_id) REFERENCES dag_workflow_sessions(id)
);

CREATE INDEX idx_dag_node_workflow ON dag_node_sessions(workflow_id);
CREATE INDEX idx_dag_node_status ON dag_node_sessions(status);
```

---

## 3. 偏离 1 解决方案：Chat → Workflow 触发机制

### 3.1 触发入口：DAGCreateTool

设计一个 LLM 可调用的 Tool，让 Chat 中的 LLM 能够主动创建 DAG 工作流。

```typescript
// src/dag/integration/tools/DAGCreateTool.ts

import { Tool } from '@/tool'
import { Schema } from 'effect'

const Parameters = Schema.Struct({
  // 工作流模板（可选预定义或自定义）
  template: Schema.optional(Schema.String).annotate({
    description: '预定义 DAG 模板名（如 "refactor-module", "implement-feature", "investigate-bug"）',
  }),
  // 用户意图描述
  description: Schema.String.annotate({
    description: '创建工作流的原因描述（1-2 句）',
  }),
  // 自定义 DAG 配置（高级用法）
  custom_config: Schema.optional(Schema.Unknown).annotate({
    description: '自定义 DAG 配置（JSON）。如果不提供，则使用 template 预设配置。',
  }),
})

export const DAGCreateTool = Tool.define(
  'dag_create',
  Parameters,
  Effect.fn('DAGCreateTool.execute')(function* (params, ctx) {
    const dagSession = yield* DAGSession.Service

    // 1. 决定使用模板还是自定义配置
    const config = params.template
      ? yield* resolveTemplate(params.template)
      : params.custom_config ?? yield* inferFromContext(params.description, ctx)

    // 2. 验证 required_nodes 约束（偏离4）
    validateRequiredNodes(config)

    // 3. 创建 Workflow Session
    const workflow = yield* dagSession.createWorkflow({
      source_chat_session_id: ctx.sessionID,  // ⭐ 关联触发 Chat
      name: params.template ?? 'custom',
      config,
      description: params.description,
    })

    // 4. 异步启动工作流（不阻塞 Chat）
    yield* Effect.forkIn(
      dagSession.startWorkflow(workflow.id),
      scope
    )

    // 5. 返回工作流 ID 给 LLM（用于后续查询）
    return output(`
      DAG workflow created and started.
      workflow_id: ${workflow.id}
      name: ${workflow.name}
      nodes: ${workflow.config.nodes.length}
      progress: ${workflow.progress.completed_nodes}/${workflow.progress.total_nodes}

      Use dag_status to check progress or navigate to workflow in the UI.
    `)
  })
)
```

### 3.2 预定义模板系统

```typescript
// src/dag/integration/templates/index.ts

export interface DAGTemplate {
  name: string
  description: string
  config: WorkflowConfig               // 预定义的 DAG 配置
  prompt_template: string              // 自动生成的初始 prompt
}

export const templates: Record<string, DAGTemplate> = {
  'refactor-module': {
    name: 'Refactor Module',
    description: '重构指定模块（包含分析、设计、实施、测试阶段）',
    config: {
      nodes: [
        { id: 'analyze', name: 'Analyze', type: 'code', config: {} },
        { id: 'design', name: 'Design', type: 'code', config: {} },
        { id: 'implement', name: 'Implement', type: 'code', config: {} },
        { id: 'test', name: 'Test', type: 'code', config: {} },
        { id: 'review', name: 'Review', type: 'code', config: {} },
      ],
      dependencies: {
        analyze: [],
        design: ['analyze'],
        implement: ['design'],
        test: ['implement'],
        review: ['test'],
      },
      required_nodes: ['analyze', 'implement', 'test', 'review'],
      max_concurrency: 2,
    },
    prompt_template: 'Refactor the following module with comprehensive analysis and testing...',
  },

  'implement-feature': {
    name: 'Implement Feature',
    description: '实现新功能（并行探索方案 → 选择 → 实施）',
    config: {
      nodes: [
        { id: 'explore-1', name: 'Explore Option 1', type: 'code', config: {} },
        { id: 'explore-2', name: 'Explore Option 2', type: 'code', config: {} },
        { id: 'decide', name: 'Decide', type: 'code', config: {} },
        { id: 'implement', name: 'Implement', type: 'code', config: {} },
        { id: 'test', name: 'Test', type: 'code', config: {} },
      ],
      dependencies: {
        'explore-1': [],
        'explore-2': [],
        decide: ['explore-1', 'explore-2'],
        implement: ['decide'],
        test: ['implement'],
      },
      required_nodes: ['decide', 'implement', 'test'],
      max_concurrency: 3,
    },
    prompt_template: 'Explore multiple approaches and implement the best one with tests...',
  },
}
```

### 3.3 上下文传递

```typescript
// src/dag/integration/context-passing.ts

/**
 * 从 Chat Session 提取上下文，传递给 DAG Workflow
 */
export interface DAGContext {
  source_chat_session_id: string
  chat_summary: string                 // Chat 历史摘要
  relevant_messages: ChatMessage[]     // 相关消息（最近 N 条 + 关键消息）
  mentioned_files: string[]            // 讨论过的文件
  current_working_directory: string
  user_intent: string                  // 用户意图（最后一条用户消息）
  extracted_requirements: string[]     // 从 Chat 中提取的需求
}

export async function extractContext(
  chat_session_id: string,
  sessionService: OpenCodeSessionService,
  messageService: MessageService,
): Promise<DAGContext> {
  const chat = await sessionService.get(chat_session_id)
  const messages = await messageService.listBySession(chat_session_id, { limit: 50 })

  // 1. 用 LLM 生成摘要
  const summary = await summarizeChat(messages)

  // 2. 提取提到的文件
  const files = extractFilesFromMessages(messages)

  // 3. 提取需求（最后一条用户消息 + 关键 assistant 回复）
  const requirements = extractRequirements(messages)

  return {
    source_chat_session_id: chat_session_id,
    chat_summary: summary,
    relevant_messages: selectRelevantMessages(messages),
    mentioned_files: files,
    current_working_directory: chat.directory,
    user_intent: messages[messages.length - 1]?.content ?? '',
    extracted_requirements: requirements,
  }
}
```

---

## 4. 偏离 2 解决方案：跨模式视图查询

### 4.1 图查询 API

```typescript
// src/dag/session/query-api.ts

export interface DAGQueryAPI {
  /**
   * ⭐ 偏离2: 查询某个 Chat Session 触发的所有 Workflows
   */
  queryWorkflowsByChat(chat_session_id: string): Promise<WorkflowSession[]>

  /**
   * ⭐ 偏离2: 查询 Workflow 的所有 Node Sessions
   */
  queryNodesByWorkflow(workflow_id: string): Promise<NodeSession[]>

  /**
   * ⭐ 偏离2: 查询完整关联图（支持任意 Session ID 作为入口）
   *
   * 返回：
   * - 如果输入是 Chat Session ID → 返回该 Chat + 它触发的所有 Workflow + 所有 Node
   * - 如果输入是 Workflow ID → 返回 Workflow + 它的 Chat 父级 + 所有 Node
   * - 如果输入是 Node ID → 返回 Node + 它的 Workflow + Workflow 的 Chat 父级 + 所有兄弟 Nodes
   */
  queryGraph(session_id: string): Promise<SessionGraph>
}

/**
 * Session 关联图结构
 */
export interface SessionGraph {
  root_chat_session?: {
    id: string
    title: string
    status: string
    created_at: number
  }
  workflows: Array<{
    workflow: WorkflowSession
    nodes: NodeSession[]
  }>
  total: {
    chat_sessions: number
    workflow_sessions: number
    node_sessions: number
  }
}
```

### 4.2 OpenCode SDK 集成

```typescript
// src/dag/integration/opencode-bridge.ts

export interface OpenCodeBridge {
  /**
   * 获取 Chat Session 信息（跨限界上下文调用）
   */
  getChatSession(session_id: string): Promise<OpenCodeSessionInfo | null>

  /**
   * 在 OpenCode Session 中注入一条消息（告知用户工作流已创建）
   */
  injectMessage(session_id: string, message: ChatMessage): Promise<void>
}

// 实现示例：通过 SDK 或数据库直接读取（只读访问）
export class OpenCodeBridgeImpl implements OpenCodeBridge {
  async getChatSession(session_id: string): Promise<OpenCodeSessionInfo | null> {
    // 直接读取 OpenCode 的 SQLite 数据库（只读）
    const db = new Database('/path/to/opencode.db')
    const row = db.prepare(
      'SELECT * FROM sessions WHERE id = ?'
    ).get(session_id)
    return row ? mapRowToInfo(row) : null
  }
}
```

> **注意**: 这里违反了我们"不共享 OpenCode 数据库"的原则。**建议实现**:
>
> - **短期**: 使用 OpenCode 暴露的 SDK（HTTP/本地 IPC）
> - **长期**: 通过 OpenCode 的 Hook 机制订阅 Session 创建事件
>
> 避免直接读取 OpenCode 的 SQLite（数据格式可能变化）。

### 4.3 TUI 导航支持

```typescript
// src/dag/integration/tui-navigation.ts

export interface DAGNavigation {
  /**
   * 从当前 Chat Session 跳转到关联的 Workflow
   */
  navigateToWorkflow(workflow_id: string): void

  /**
   * 从 Workflow 跳转回触发它的 Chat
   */
  navigateToChat(chat_session_id: string): void

  /**
   * 从 Node 跳转到它所属的 Workflow
   */
  navigateToWorkflowFromNode(node_id: string): void
}
```

---

## 5. 偏离 3 解决方案：Worker 级执行追踪

### 5.1 事件记录机制

```typescript
// src/dag/session/event-recording.ts

/**
 * 包装 WorkerExecutor，自动记录执行细节
 */
export function wrapExecutorWithRecording(
  original: WorkerExecutor,
  nodeSession: NodeSession,
  persister: DAGSessionPersister,
): WorkerExecutor {
  return async (worker: WorkerInfo, context: unknown) => {
    const startTime = Date.now()

    // 1. 捕获 stdout/stderr
    const logCapture = new LogCapture()
    const stdoutSpy = logCapture.spyStdout()
    const stderrSpy = logCapture.spyStderr()

    try {
      // 2. 启动 CPU/内存监控（可选）
      const metricsCapture = new MetricsCapture()
      metricsCapture.start()

      // 3. 执行原 Worker
      const result = await original(worker, context)

      // 4. 停止监控
      const metrics = metricsCapture.stop()

      // 5. 记录成功执行信息
      await persister.updateNodeSession(nodeSession.id, {
        status: 'completed',
        output: result,
        execution_log: logCapture.getLogs(),
        metrics: {
          duration_ms: Date.now() - startTime,
          cpu_usage_avg: metrics.cpu_avg,
          cpu_usage_peak: metrics.cpu_peak,
          memory_mb_avg: metrics.memory_avg,
          memory_mb_peak: metrics.memory_peak,
          tokens_input: extractTokenUsage(result),
          tokens_output: extractTokenOutput(result),
        },
        state_history: [
          ...nodeSession.state_history,
          {
            from_status: nodeSession.status,
            to_status: 'completed',
            timestamp: Date.now(),
            reason: 'execution_succeeded',
          },
        ],
        completed_at: Date.now(),
      })

      return result
    } catch (error) {
      // 6. 记录错误执行信息
      await persister.updateNodeSession(nodeSession.id, {
        status: 'failed',
        execution_log: logCapture.getLogs(),
        error_info: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          retry_attempt: nodeSession.retry_count,
        },
        metrics: {
          duration_ms: Date.now() - startTime,
        },
        state_history: [
          ...nodeSession.state_history,
          {
            from_status: nodeSession.status,
            to_status: 'failed',
            timestamp: Date.now(),
            reason: `execution_failed: ${error instanceof Error ? error.message : 'unknown'}`,
          },
        ],
        completed_at: Date.now(),
      })

      throw error
    }
  }
}
```

### 5.2 状态历史自动记录

```typescript
// src/dag/session/state-history-recorder.ts

/**
 * 监听 Worker 状态变化，自动记录到 state_history
 */
export class StateHistoryRecorder {
  constructor(
    private scheduler: Scheduler,
    private persister: DAGSessionPersister,
  ) {}

  register() {
    // 订阅 Scheduler 的 worker 状态变更事件
    this.scheduler.on('worker.state_changed', async (event) => {
      const nodeSession = await this.findNodeByWorkerId(event.workerId)
      if (!nodeSession) return

      const historyEntry: StateTransition = {
        from_status: event.old_status,
        to_status: event.new_status,
        timestamp: Date.now(),
        reason: event.reason ?? 'unknown',
      }

      await this.persister.appendChildStateHistory(
        nodeSession.id,
        historyEntry
      )
    })
  }
}
```

### 5.3 日志捕获实现

```typescript
// src/dag/session/log-capture.ts

export class LogCapture {
  private logs: string[] = []
  private originalStdoutWrite?: typeof process.stdout.write
  private originalStderrWrite?: typeof process.stderr.write

  spyStdout() {
    this.originalStdoutWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: any, ...args: any[]) => {
      this.logs.push(`[stdout] ${chunk}`)
      return this.originalStdoutWrite!(chunk, ...args)
    }
  }

  spyStderr() {
    this.originalStderrWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk: any, ...args: any[]) => {
      this.logs.push(`[stderr] ${chunk}`)
      return this.originalStderrWrite!(chunk, ...args)
    }
  }

  getLogs(): string {
    // 恢复原始 write
    if (this.originalStdoutWrite) {
      process.stdout.write = this.originalStdoutWrite
    }
    if (this.originalStderrWrite) {
      process.stderr.write = this.originalStderrWrite
    }

    return this.logs.join('\n')
  }
}
```

### 5.4 Metrics 监控实现

```typescript
// src/dag/session/metrics-capture.ts

import * as os from 'os'
import * as process from 'process'

export interface ExecutionMetrics {
  cpu_avg: number
  cpu_peak: number
  memory_avg: number
  memory_peak: number
}

export class MetricsCapture {
  private cpuSamples: number[] = []
  private memorySamples: number[] = []
  private interval?: NodeJS.Timeout
  private startTime = 0

  start() {
    this.startTime = Date.now()
    this.cpuSamples = []
    this.memorySamples = []

    // 每 500ms 采样一次
    this.interval = setInterval(() => {
      this.sample()
    }, 500)
  }

  stop(): ExecutionMetrics {
    if (this.interval) {
      clearInterval(this.interval)
    }

    const cpu_avg = this.avg(this.cpuSamples)
    const cpu_peak = Math.max(...this.cpuSamples, 0)
    const memory_avg = this.avg(this.memorySamples)
    const memory_peak = Math.max(...this.memorySamples, 0)

    return {
      cpu_avg,
      cpu_peak,
      memory_avg: this.toMB(memory_avg),
      memory_peak: this.toMB(memory_peak),
    }
  }

  private sample() {
    // CPU 使用率（简化版，实际实现应该用 pidusage 等库）
    const cpuUsage = process.cpuUsage()
    const cpuPercent = ((cpuUsage.user + cpuUsage.system) / 1000) / (Date.now() - this.startTime)
    this.cpuSamples.push(cpuPercent * 100)

    // 内存使用
    const memUsage = process.memoryUsage()
    this.memorySamples.push(memUsage.rss)
  }

  private avg(arr: number[]): number {
    return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
  }

  private toMB(bytes: number): number {
    return Math.round(bytes / (1024 * 1024) * 100) / 100
  }
}
```

---

## 6. 偏离 4 解决方案：required_nodes 约束验证

### 6.1 创建时验证

```typescript
// src/dag/session/required-nodes-validator.ts

export class RequiredNodesValidator {
  /**
   * 在 Workflow 创建时验证 required_nodes 配置
   *
   * ⭐ 偏离4: 提前发现配置错误
   */
  validate(config: WorkflowConfig): ValidationResult {
    const nodeIds = new Set(config.nodes.map(n => n.id))
    const errors: string[] = []

    // 1. required_nodes 必须是 nodes 的子集
    for (const reqId of config.required_nodes) {
      if (!nodeIds.has(reqId)) {
        errors.push(`Required node "${reqId}" not found in nodes list`)
      }
    }

    // 2. required_nodes 之间不应形成循环（依赖检查）
    const requiredGraph = this.buildRequiredGraph(config)
    if (this.hasCycle(requiredGraph)) {
      errors.push('Required nodes form a cyclic dependency')
    }

    // 3. required_nodes 不应包含所有 nodes（否则 max_concurrency 无意义）
    if (config.required_nodes.length === config.nodes.length) {
      // 警告，不是错误
      return {
        valid: true,
        warnings: [
          'All nodes are marked as required. Consider if some nodes can be optional.',
        ],
        errors: [],
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings: [],
    }
  }

  private buildRequiredGraph(config: WorkflowConfig): Map<string, string[]> {
    const graph = new Map<string, string[]>()
    for (const nodeId of config.required_nodes) {
      const deps = config.dependencies[nodeId] ?? []
      graph.set(nodeId, deps.filter(dep => config.required_nodes.includes(dep)))
    }
    return graph
  }

  private hasCycle(graph: Map<string, string[]>): boolean {
    const visited = new Set<string>()
    const inStack = new Set<string>()

    const dfs = (nodeId: string): boolean => {
      if (inStack.has(nodeId)) return true  // 循环
      if (visited.has(nodeId)) return false

      visited.add(nodeId)
      inStack.add(nodeId)

      for (const dep of graph.get(nodeId) ?? []) {
        if (dfs(dep)) return true
      }

      inStack.delete(nodeId)
      return false
    }

    for (const nodeId of graph.keys()) {
      if (dfs(nodeId)) return true
    }

    return false
  }
}

interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}
```

### 6.2 执行时监控

```typescript
// src/dag/session/required-nodes-monitor.ts

export class RequiredNodesMonitor {
  constructor(
    private scheduler: Scheduler,
    private persister: DAGSessionPersister,
  ) {}

  /**
   * ⭐ 偏离4: 监控 required_nodes 的执行
   */
  register() {
    // 1. 监听 Node 跳过事件
    this.scheduler.on('node.skipped', async (event) => {
      const workflow = await this.persister.getWorkflowByNodeId(event.nodeId)
      if (!workflow) return

      // 检查是否 required node
      if (workflow.config.required_nodes.includes(event.nodeId)) {
        // 标记为 failed_with_violation
        await this.markViolation(workflow.id, event.nodeId, 'skipped')
      }
    })

    // 2. 监听 Workflow 完成事件
    this.scheduler.on('workflow.completed', async (event) => {
      const workflow = await this.persister.getWorkflow(event.workflowId)
      if (!workflow) return

      // 检查所有 required nodes 是否完成
      const missingRequired = workflow.config.required_nodes.filter(reqId => {
        const node = workflow.nodes.find(n => n.id === reqId)
        return !node || node.status !== 'completed'
      })

      if (missingRequired.length > 0) {
        // 标记为 failed_with_violation
        await this.markViolation(workflow.id, missingRequired.join(','), 'required_not_completed')
      }
    })
  }

  private async markViolation(
    workflow_id: string,
    node_id: string,
    reason: string,
  ) {
    const workflow = await this.persister.getWorkflow(workflow_id)
    if (!workflow) return

    // 1. 更新 workflow status
    await this.persister.updateWorkflow(workflow_id, {
      status: 'failed_with_violation',
      required_nodes_status: {
        ...workflow.required_nodes_status,
        skipped_ids: [...workflow.required_nodes_status.skipped_ids, node_id],
      },
    })

    // 2. 记录违规事件
    await this.persister.recordViolationEvent(workflow_id, {
      node_id,
      reason,
      timestamp: Date.now(),
    })
  }
}
```

### 6.3 违规状态查询

```typescript
// src/dag/session/violation-query.ts

export interface ViolationQueryAPI {
  /**
   * 查询所有有违规的 Workflows
   */
  queryViolatedWorkflows(): Promise<WorkflowSession[]>

  /**
   * 查询某个 Workflow 的违规历史
   */
  getViolationHistory(workflow_id: string): Promise<ViolationEvent[]>

  /**
   * 检查某个 required node 是否被跳过
   */
  isNodeSkipped(workflow_id: string, node_id: string): Promise<boolean>
}

export interface ViolationEvent {
  workflow_id: string
  node_id: string
  reason: string
  timestamp: number
}
```

### 6.5 状态注入策略（新偏离 A）⭐

DAG 执行期间，如何将状态同步到触发它的 Chat Session，让 LLM 能"看到" DAG 在做什么？

#### 设计目标

- **Token 效率**：避免每条消息都注入，防止 Chat Session Token 暴涨
- **关键可见**：重要节点（开始、完成、失败）必须及时注入
- **可查询**：LLM 可以通过 Tool 主动查询 DAG 状态

#### 推荐方案：关键节点注入

| 注入时机 | 注入内容 | 触发条件 |
|---------|---------|---------|
| **DAG 启动** | workflow_id、节点数量、配置参数 | `/dag-worker create` 执行后 |
| **节点开始** | 节点名、节点 ID、开始时间 | 每个 required node 启动时 |
| **节点完成/失败** | 节点名、状态、输出摘要、耗时 | 每个 required node 完成或失败时 |
| **DAG 完成/失败** | 总耗时、完成的节点、失败的节点、违规信息（如有） | DAG workflow 状态变为 completed 或 failed |

#### 实现机制

```typescript
// src/dag/integration/status-injection.ts

export class StatusInjector {
  constructor(
    private sessionService: Session.Service,
    private partService: MessagePart.Service,
  ) {}

  /**
   * ⭐ 关键节点注入：DAG 启动时
   */
  async onWorkflowStarted(workflow: WorkflowSession): Promise<void> {
    if (!workflow.source_chat_session_id) return

    const syntheticMessage = this.formatWorkflowStart(workflow)

    // 复用 TaskTool.injectBackgroundResult 的模式
    await this.sessionService.addMessage(
      workflow.source_chat_session_id,
      syntheticMessage,
    )
  }

  /**
   * ⭐ 关键节点注入：required node 开始/完成/失败时
   */
  async onNodeStateChanged(
    workflow: WorkflowSession,
    node: NodeSession,
  ): Promise<void> {
    // 只注入 required nodes 的状态变化
    if (!workflow.config.required_nodes.includes(node.node_id)) return
    if (!workflow.source_chat_session_id) return

    const syntheticMessage = this.formatNodeState(workflow, node)

    await this.sessionService.addMessage(
      workflow.source_chat_session_id,
      syntheticMessage,
    )
  }

  /**
   * ⭐ 关键节点注入：DAG 完成/失败时
   */
  async onWorkflowCompleted(workflow: WorkflowSession): Promise<void> {
    if (!workflow.source_chat_session_id) return

    const syntheticMessage = this.formatWorkflowCompletion(workflow)

    await this.sessionService.addMessage(
      workflow.source_chat_session_id,
      syntheticMessage,
    )
  }

  /**
   * 格式化 DAG 启动消息
   */
  private formatWorkflowStart(workflow: WorkflowSession): {
    role: 'user'
    content: string
    metadata: { synthetic: true; timestamp: number }
  } {
    return {
      role: 'user',
      content: `<DAG_WORKFLOW_STARTED>\n` +
               `workflow_id: ${workflow.id}\n` +
               `name: ${workflow.name}\n` +
               `nodes: ${workflow.config.nodes.length} (${workflow.config.required_nodes.length} required)\n` +
               `max_concurrency: ${workflow.config.max_concurrency}\n` +
               `</DAG_WORKFLOW_STARTED>`,
      metadata: { synthetic: true, timestamp: Date.now() },
    }
  }

  /**
   * 格式化 node 状态消息
   */
  private formatNodeState(
    workflow: WorkflowSession,
    node: NodeSession,
  ): {
    role: 'user'
    content: string
    metadata: { synthetic: true; timestamp: number }
  } {
    if (node.status === 'running') {
      return {
        role: 'user',
        content: `<DAG_NODE_STARTED>\n` +
                 `workflow_id: ${workflow.id}\n` +
                 `node_id: ${node.node_id}\n` +
                 `node_name: ${node.name}\n` +
                 `progress: ${workflow.progress.completed_nodes}/${workflow.progress.total_nodes}\n` +
                 `</DAG_NODE_STARTED>`,
      }
    }

    // completed 或 failed
    const status_tag = node.status === 'completed'
      ? 'DAG_NODE_COMPLETED'
      : 'DAG_NODE_FAILED'

    const output_summary = node.execution_output
      ? `output_summary: ${this.truncate(node.execution_output, 500)}`
      : node.error_info
      ? `error: ${node.error_info.message}`
      : ''

    return {
      role: 'user',
      content: `<${status_tag}>\n` +
               `workflow_id: ${workflow.id}\n` +
               `node_id: ${node.node_id}\n` +
               `node_name: ${node.name}\n` +
               `duration_ms: ${node.metrics.duration_ms}\n` +
               `${output_summary}\n` +
               `progress: ${workflow.progress.completed_nodes}/${workflow.progress.total_nodes}\n` +
               `</${status_tag}>`,
    }
  }

  /**
   * 格式化 DAG 完成/失败消息
   */
  private formatWorkflowCompletion(workflow: WorkflowSession): {
    role: 'user'
    content: string
    metadata: { synthetic: true; timestamp: number }
  } {
    const final_status = workflow.status === 'failed'
      ? `<DAG_WORKFLOW_FAILED>`
      : workflow.status === 'failed_with_violation'
      ? `<DAG_WORKFLOW_VIOLATED>`
      : '<DAG_WORKFLOW_COMPLETED>'

    const completed_list = workflow.config.required_nodes
      .filter(id => workflow.node_states[id]?.status === 'completed')
      .join(', ')

    const failed_list = workflow.config.required_nodes
      .filter(id => workflow.node_states[id]?.status === 'failed')
      .join(', ')

    const violation_info = workflow.violations.length > 0
      ? `\nviolations:\n${workflow.violations.map(v => `  - ${v.node_id}: ${v.reason}`).join('\n')}`
      : ''

    return {
      role: 'user',
      content: `${final_status}\n` +
               `workflow_id: ${workflow.id}\n` +
               `total_duration_ms: ${workflow.total_duration_ms}\n` +
               `completed_nodes: ${completed_list}\n` +
               `failed_nodes: ${failed_list || '(none)'}\n` +
               `${violation_info}\n` +
               `</${final_status.slice(1, -1)}>`,
    }
  }

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text
    return text.slice(0, maxLength - 3) + '...'
  }
}
```

#### EventBus 与 StatusInjector 的桥接

```typescript
// src/dag/integration/event-injection-bridge.ts

export class EventInjectionBridge {
  constructor(
    private eventBus: EventBus,
    private statusInjector: StatusInjector,
    private dagSessionService: DAGSession.Service,
  ) {}

  register() {
    // 监听 DAG 事件并触发注入
    this.eventBus.on('workflow.started', async (event) => {
      const workflow = await this.dagSessionService.get(event.workflow_id)
      await this.statusInjector.onWorkflowStarted(workflow)
    })

    this.eventBus.on('node.state_changed', async (event) => {
      const { workflow_id, node_id, new_state } = event
      const workflow = await this.dagSessionService.get(workflow_id)
      const node = workflow.node_states[node_id]
      await this.statusInjector.onNodeStateChanged(workflow, node)
    })

    this.eventBus.on('workflow.completed', async (event) => {
      const workflow = await this.dagSessionService.get(event.workflow_id)
      await this.statusInjector.onWorkflowCompleted(workflow)
    })

    this.eventBus.on('workflow.failed', async (event) => {
      const workflow = await this.dagSessionService.get(event.workflow_id)
      await this.statusInjector.onWorkflowCompleted(workflow)
    })
  }
}
```

### 6.6 DAGContext 提取规则（新偏离 C）

从 Chat Session 提取什么信息给 DAG Worker？

#### 设计原则

- **最小原则**：只提取 DAG 需要的信息，减少上下文噪声
- **确定性**：提取规则明确，避免 LLM 每次推断
- **安全**：权限从 Chat Session 继承或从 DAG config 获取

#### 提取规则

| 字段 | 来源 | 规则 |
|------|------|------|
| **最近 N 条消息** | MessageService | 默认 N=10，从后往前取 |
| **关键消息摘要** | LLM 总结 | 提取用户意图、关键决策、文件路径 |
| **相关文件列表** | 提取自消息内容 | 所有 `@path/to/file` 引用 + git 工作区变更文件 |
| **用户意图** | 最后一条 user message | 直接复制，不处理 |
| **触发原因** | `/dag-worker` 的参数 | 如 `/dag-worker create refactor-module` |
| **工作目录** | OpenCode Context | 从 Chat Session 的 InstanceContext 获取 |
| **权限配置** | Chat Session.permission | 透传，DAG Worker 使用相同的权限规则 |

#### 提取流程

```typescript
// src/dag/integration/context-extraction.ts

export interface DAGContext {
  chat_session_id: string
  recent_messages: Array<{
    role: 'user' | 'assistant'
    content: string
    timestamp: number
  }>
  critical_summary: string             // LLM 总结的关键信息
  referenced_files: string[]           // 被 @ 引用的文件路径
  user_intent: string                  // 最后 user message 原文
  trigger_reason: string               // /dag-worker 的参数
  working_directory: string
  permissions: PermissionRules
  environment: {
    platform: string                   // 如 'darwin', 'linux'
    node_version: string
    opencode_version: string
  }
}

export class DAGContextExtractor {
  constructor(
    private messageService: MessagePart.Service,
    private contextService: InstanceContext.Service,
  ) {}

  async extract(chat_session_id: string, trigger_args: string): Promise<DAGContext> {
    // 1. 获取最近 10 条消息（确定性规则）
    const recent_messages = await this.messageService.listBySession(
      chat_session_id,
      { limit: 10 },
    )

    // 2. 提取最后一条 user message（用户意图）
    const last_user_message = recent_messages
      .filter(m => m.role === 'user')
      .at(-1)

    const user_intent = last_user_message?.content ?? ''

    // 3. 提取被 @ 引用的文件
    const referenced_files = [...new Set(
      recent_messages.flatMap(m =>
        m.content.match(/@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-/]+/g) ?? []
      )
    )]

    // 4. 用 LLM 总结关键信息（如需求背景、关键决策）
    const critical_summary = await this.summarizeWithLLM(recent_messages)

    // 5. 获取 InstanceContext（工作目录、环境信息）
    const ctx = await this.contextService.get(chat_session_id)

    // 6. 获取权限配置
    const permissions = ctx.permissions

    return {
      chat_session_id,
      recent_messages: recent_messages.map(m => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
      })),
      critical_summary,
      referenced_files,
      user_intent,
      trigger_reason: trigger_args,
      working_directory: ctx.worktree,
      permissions,
      environment: {
        platform: process.platform,
        node_version: process.version,
        opencode_version: await InstallationVersion.fetch(),
      },
    }
  }

  private async summarizeWithLLM(messages: Array<Message>): Promise<string> {
    // 简单的 LLM 调用，提取：
    // - 用户的核心需求
    // - 讨论过的文件
    // - 任何已做出的决策
    // 实现时可以用 opencode 提供的 LLM 服务
    const prompt = `
      总结以下对话的关键信息：
      1. 用户的核心需求
      2. 讨论过的文件路径
      3. 已做出的关键决策
      
      对话内容：
      ${messages.map(m => `${m.role}: ${m.content}`).join('\n')}
    `

    // TODO: 实际调用 LLM
    return '(LLM 总结待定)'
  }
}
```

#### 传递给 DAG Worker

```typescript
// src/dag/integration/worker-context-binder.ts

export class WorkerContextBinder {
  /**
   * 将 DAGContext 转换为每个 Worker 的 context
   */
  bindToWorker(dag_context: DAGContext, node_id: string): WorkerContext {
    return {
      // 透传信息
      chat_session_id: dag_context.chat_session_id,
      user_intent: dag_context.user_intent,
      trigger_reason: dag_context.trigger_reason,
      working_directory: dag_context.working_directory,
      permissions: dag_context.permissions,
      environment: dag_context.environment,

      // 每个 worker 可见的信息
      recent_messages: dag_context.recent_messages,
      critical_summary: dag_context.critical_summary,
      referenced_files: dag_context.referenced_files,

      // 当前节点的上下文（如果有前驱节点的输出）
      predecessor_outputs: {},  // 由 DAGScheduler 在执行时填充

      // 节点 ID（供 Worker 标识自己）
      node_id,
    }
  }
}
```

### 6.7 LLM 查询 API（新偏离 B）

LLM 在对话中主动查询 DAG 状态。

#### 设计目标

- LLM 能回答："我刚才启动了哪些工作流？"
- LLM 能回答："工作流 abc 现在什么情况？"
- LLM 能回答："工作流 abc 的第 3 个节点完成了吗？"

#### Tool 设计

```typescript
// src/dag/integration/tools/dag-list.ts

export const DAGList = Tool.define({
  name: 'dag_list',
  description: '列出当前 Chat Session 关联的所有 DAG 工作流',
  parameters: {
    properties: {
      status_filter: {
        type: 'string',
        enum: ['all', 'running', 'completed', 'failed'],
        default: 'all',
        description: '按状态过滤工作流',
      },
    },
    required: [],
  },
  handler: async (ctx, params) => {
    const dagSessionService = ctx.dagSessionService
    const source_chat_session_id = ctx.chat_session_id

    const workflows = await dagSessionService
      .listByChatSession(source_chat_session_id)

    const filtered = params.status_filter === 'all'
      ? workflows
      : workflows.filter(wf => wf.status === params.status_filter)

    return JSON.stringify(
      filtered.map(wf => ({
        workflow_id: wf.id,
        name: wf.name,
        status: wf.status,
        created_at: wf.created_at,
        total_duration_ms: wf.total_duration_ms,
        progress: {
          completed: wf.progress.completed_nodes,
          total: wf.progress.total_nodes,
        },
        failed_nodes: wf.failed_nodes,
        violated: wf.violations.length > 0,
      })),
    )
  },
})
```

```typescript
// src/dag/integration/tools/dag-status.ts

export const DAGStatus = Tool.define({
  name: 'dag_status',
  description: '查询指定 DAG 工作流的详细状态',
  parameters: {
    properties: {
      workflow_id: {
        type: 'string',
        description: '要查询的工作流 ID',
      },
    },
    required: ['workflow_id'],
  },
  handler: async (ctx, params) => {
    const dagSessionService = ctx.dagSessionService

    const workflow = await dagSessionService.get(params.workflow_id)

    return JSON.stringify({
      workflow_id: workflow.id,
      name: workflow.name,
      status: workflow.status,
      source_chat_session_id: workflow.source_chat_session_id,
      config: workflow.config,
      progress: {
        completed: workflow.progress.completed_nodes,
        total: workflow.progress.total_nodes,
      },
      nodes: Object.entries(workflow.node_states).map(([id, state]) => ({
        node_id: id,
        name: state.name,
        status: state.status,
        duration_ms: state.metrics?.duration_ms,
        error: state.error_info?.message,
      })),
      violations: workflow.violations.map(v => ({
        node_id: v.node_id,
        reason: v.reason,
        timestamp: v.timestamp,
      })),
      total_duration_ms: workflow.total_duration_ms,
    })
  },
})
```

---

## 7. 模块总体结构

```
src/dag/
├── state-machine/                     # 已有模块（不变动）
├── scheduler/                         # 已有模块（不变动）
├── worktree-manager/                  # 已有模块（不变动）
├── group-manager/                     # 已有模块（不变动）
│
├── session/                           # ⭐ NEW: DAG Session 模块
│   ├── types.ts                       # 类型定义（WorkflowSession, NodeSession 等）
│   ├── schema.sql                     # SQLite 表结构
│   ├── persister.ts                   # 持久化（SQLite）
│   ├── service.ts                     # 核心 Service API
│   ├── events.ts                      # 内部事件
│   ├── query-api.ts                   # 图查询 API
│   ├── log-capture.ts                 # 日志捕获（§5 偏离3）
│   ├── metrics-capture.ts             # 资源监控（§5 偏离3）
│   ├── state-history-recorder.ts      # 状态历史记录（§5 偏离3）
│   ├── required-nodes-validator.ts    # 配置验证（§6 偏离4）
│   ├── required-nodes-monitor.ts      # 执行监控（§6 偏离4）
│   └── violation-query.ts             # 违规查询（§6 偏离4）
│
├── integration/                       # ⭐ NEW: 与 OpenCode 集成
│   ├── tools/
│   │   └── dag-worker-command.ts      # /dag-worker slashcommand handler（§3 偏离1）
│   ├── status-injection.ts            # 状态注入策略（§6.5 新偏离A）
│   │                                  #   - StatusInjector 类
│   │                                  #   - 关键节点注入逻辑
│   │                                  #   - synthetic message 格式化
│   ├── event-injection-bridge.ts      # 事件桥接（§6.5 新偏离A）
│   │                                  #   - EventInjectionBridge 类
│   │                                  #   - 监听 DAG EventBus → 调用 StatusInjector
│   ├── context-extractor.ts           # 上下文提取（§6.6 新偏离C）
│   │                                  #   - ContextExtractor 接口
│   │                                  #   - 确定性规则实现
│   ├── worker-context-builder.ts      # WorkerContext 构建器（§6.6 新偏离C）
│   │                                  #   - WorkerContextBuilder 类
│   │                                  #   - 将 DAGContext + 前驱输出 → WorkerContext
│   ├── opencode-bridge.ts             # 跨上下文调用（SDK 或 HTTP）
│   └── tui-navigation.ts              # TUI 导航支持
│
├── __tests__/
│   ├── session/                       # Session 模块单测
│   │   ├── persister.test.ts          # 持久化测试
│   │   ├── service.test.ts            # Service API 测试
│   │   ├── required-nodes-validator.test.ts      # 配置验证测试
│   │   ├── required-nodes-monitor.test.ts        # 执行监控测试
│   │   ├── log-capture.test.ts        # 日志捕获测试
│   │   ├── metrics-capture.test.ts    # 资源监控测试
│   │   └── query-api.test.ts          # 图查询测试
│   │
│   └── integration/                   # 集成测试
│       ├── status-injection.test.ts   # 新偏离A: 状态注入测试
│       ├── event-injection-bridge.test.ts  # 新偏离A: 事件桥接测试
│       ├── context-extractor.test.ts  # 新偏离C: 上下文提取测试
│       ├── worker-context-builder.test.ts  # 新偏离C: WorkerContext 构建测试
│       ├── dag-worker-command.test.ts # 偏离1: /dag-worker 触发器测试
│       ├── graph-query.test.ts        # 偏离2: 图查询
│       ├── worker-tracing.test.ts     # 偏离3: Worker 追踪
│       └── required-nodes-enforcement.test.ts  # 偏离4: 约束执行
```

---

## 8. 实现阶段计划

### Phase 8.1：Session 基础框架（2-3 天） ⭐ 优先实现

**目标**: DAG Session 核心数据层

**交付**:
1. ✅ `src/dag/session/types.ts` - 完整类型定义
2. ✅ `src/dag/session/schema.sql` - SQLite 表 + 索引
3. ✅ `src/dag/session/persister.ts` - SQLite CRUD + 事务
4. ✅ `src/dag/session/service.ts` - 核心 API（create/get/update/delete）
5. ✅ `src/dag/session/events.ts` - 内部事件定义
6. ✅ 单元测试覆盖 80%+

**验收标准**:
- [ ] 独立创建 Workflow Session，存入 SQLite
- [ ] 创建 Node Session，建立 parent-child 关系
- [ ] 查询 Workflow 的所有 Nodes
- [ ] 更新状态时记录 state_history

### Phase 8.2：约束验证与监控（1-2 天）

**目标**: 补齐偏离 4（required_nodes 约束）

**交付**:
1. ✅ `required-nodes-validator.ts` + 测试
2. ✅ `required-nodes-monitor.ts` + 测试
3. ✅ `violation-query.ts` + 测试
4. ✅ Workflow 创建时自动验证
5. ✅ 执行过程自动监控违规

**验收标准**:
- [ ] 创建 Workflow 时验证 required_nodes 配置正确性
- [ ] Node 被跳过时标记 Workflow 为 `failed_with_violation`
- [ ] Workflow 完成时检查所有 required_nodes 是否完成
- [ ] 违规查询 API 返回正确列表

### Phase 8.3：Worker 级执行追踪（2-3 天）

**目标**: 补齐偏离 3（Worker 追踪）

**交付**:
1. ✅ `log-capture.ts` + 测试
2. ✅ `metrics-capture.ts` + 测试
3. ✅ `state-history-recorder.ts` + 测试
4. ✅ `wrapExecutorWithRecording` 集成到 Scheduler
5. ✅ 单元测试 + 集成测试

**验收标准**:
- [ ] Node 执行后 `execution_log` 包含完整 stdout/stderr
- [ ] `metrics` 包含 CPU/内存/token 使用
- [ ] `state_history` 自动记录每次状态变化
- [ ] 错误堆栈正确捕获

### Phase 8.4：Chat → Workflow 触发机制（2-3 天）

**目标**: 补齐偏离 1（触发器）

**交付**:
1. ✅ `DAGCreateTool.ts` + 测试
2. ✅ `templates/index.ts` - 至少 2 个预定义模板
3. ✅ `context-passing.ts` + 测试
4. ✅ `opencode-bridge.ts`（只读访问 OpenCode Session）
5. ✅ 集成测试：从 Chat 创建 Workflow 全流程

**验收标准**:
- [ ] LLM 在 Chat 中调用 `dag_create` 工具
- [ ] Workflow 关联到触发它的 Chat Session
- [ ] Chat 上下文被传递到 Workflow metadata
- [ ] 模板配置正确加载

### Phase 8.5：图查询与跨模式视图（2-3 天）

**目标**: 补齐偏离 2（跨模式视图）

**交付**:
1. ✅ `query-api.ts` + 测试
2. ✅ `tui-navigation.ts` - TUI 导航支持
3. ✅ `OpenCodeBridgeImpl` - 跨上下文查询
4. ✅ 单元测试 + 集成测试

**验收标准**:
- [ ] `queryWorkflowsByChat(chat_id)` 返回所有关联 Workflow
- [ ] `queryNodesByWorkflow(workflow_id)` 返回所有 Nodes
- [ ] `queryGraph(any_session_id)` 返回完整关联图
- [ ] 从 Chat 跳转到关联 Workflow（TUI）
- [ ] 从 Workflow 跳转回触发 Chat（TUI）

### Phase 8.6：端到端集成测试（1-2 天）

**目标**: 验证所有偏离都解决

**交付**:
1. ✅ 完整的 E2E 测试：Chat → Workflow 创建 → 执行 → 追踪 → 查询
2. ✅ 性能基准测试
3. ✅ 文档更新（AGENTS.md + README）

**验收标准**:
- [ ] 所有功能在 TUI 中可操作
- [ ] 100 节点工作流更新延迟 < 50ms
- [ ] 内存占用 < 50MB
- [ ] 测试覆盖率 > 90%

---

## 9. 实施优先级

| 优先级 | 工作内容 | 偏离 | 预估 | 备注 |
|--------|---------|------|------|------|
| 🔴 P0 | Phase 8.1 | - | 2-3 天 | 所有后续的基础 |
| 🔴 P0 | Phase 8.2 | 偏离4 | 1-2 天 | 约束验证是核心需求 |
| 🟡 P1 | Phase 8.3 | 偏离3 | 2-3 天 | 调试体验关键 |
| 🟡 P1 | Phase 8.4 | 偏离1 | 2-3 天 | 产品入口体验 |
| 🟢 P2 | Phase 8.5 | 偏离2 | 2-3 天 | 跨模式视图可渐进 |
| 🟢 P2 | Phase 8.6 | - | 1-2 天 | 集成测试 |

**总计**: 10-16 天（含 6 个 Phase）

**建议**: P0 工作（8.1 + 8.2）必须先完成，再实施 P1/P2。

---

## 10. 风险评估

### 10.1 高风险 🔴

| 风险 | 原因 | 缓解措施 |
|------|------|----------|
| **跨上下文查询延迟** | Chat + Workflow + Node 数据量大 | 建立索引 + 查询缓存 |
| **LogCapture 与多 Worker 冲突** | stdout 是全局的 | 使用 worker 线程隔离，或自定义 Logger |
| **required_nodes 验证复杂度** | 配置错误难以提前发现 | 增加配置检查工具，生成验证报告 |

### 10.2 中风险 🟡

| 风险 | 原因 | 缓解措施 |
|------|------|----------|
| **Chat→Workflow 意图提取不准** | 用户意图模糊 | 提供交互式确认（用户选择模板） |
| **Metrics 影响性能** | 监控开销 | 可配置开关，默认关闭 |
| **OpenCodeBridge 数据访问** | 跨库查询 | 短期使用 SDK，长期 Hook 机制 |

### 10.3 低风险 🟢

| 风险 | 原因 | 缓解措施 |
|------|------|----------|
| **TUI 导航体验差** | 界面复杂度 | 渐进实现，先支持基础跳转 |
| **模板不够用** | 场景有限 | 支持自定义配置作为 fallback |

---

## 11. 验收标准

### 11.1 功能验收

- [ ] **偏离 1**: LLM 在 Chat 中通过 `dag_create` 工具创建 Workflow ✅
- [ ] **偏离 1**: Workflow 配置可来自模板或自定义 ✅
- [ ] **偏离 1**: Chat 上下文正确传递到 Workflow ✅
- [ ] **偏离 2**: `queryWorkflowsByChat` 返回正确列表 ✅
- [ ] **偏离 2**: `queryGraph` 支持任意 Session ID 作为入口 ✅
- [ ] **偏离 2**: TUI 可导航到关联 Session ✅
- [ ] **偏离 3**: Node 执行后 `execution_log` 完整记录 ✅
- [ ] **偏离 3**: `metrics` 包含 CPU/内存/token 数据 ✅
- [ ] **偏离 3**: `state_history` 自动追踪状态变化 ✅
- [ ] **偏离 3**: 错误堆栈正确捕获 ✅
- [ ] **偏离 4**: 创建时验证 required_nodes 配置 ✅
- [ ] **偏离 4**: 跳过 required node 时标记违规 ✅
- [ ] **偏离 4**: Workflow 完成时检查 required_nodes ✅
- [ ] **偏离 4**: 违规查询 API 返回正确列表 ✅

### 11.2 质量验收

- [ ] 所有类型通过 TypeScript 编译（无 any）
- [ ] 所有模块单元测试覆盖率 > 80%
- [ ] 集成测试覆盖全流程
- [ ] 100 节点工作流查询延迟 < 100ms
- [ ] 内存占用 < 50MB（稳定运行）

### 11.3 架构验收

- [ ] DAG Session 不 import `src/session/*` 或 `src/sync/*` 代码
- [ ] DAG Session 独立可测试（无需 mock OpenCode）
- [ ] DAG Session 与 OpenCode Session 只通过标识符引用

---

## 12. 后续优化方向（非本期范围）

1. **DAG 可视化** - 在 TUI 中展示 DAG 依赖图
2. **工作流恢复** - 支持从失败点继续执行
3. **工作流模板市场** - 社区共享 DAG 模板
4. **分布式 DAG 执行** - 多节点并行

---

## 附录 A：与 v1.0 的差异

| 维度 | v1.0 设计 | v2.0 设计 |
|------|---------|---------|
| **复用策略** | 复用 OpenCode Session | 独立 DAG Session |
| **数据共享** | 共享 SessionTable | 独立 SQLite 表，标识符引用 |
| **事件集成** | 接入 SyncEvent 系统 | 独立 EventBus（DAG 已有） |
| **实现复杂度** | 高（Effect + SyncEvent） | 低（SQLite + EventBus） |
| **演化自由** | 受 OpenCode Session 约束 | 完全独立 |
| **故障隔离** | 共享风险 | 隔离风险 |

## 附录 B：关键决策记录

### ADR-1: 独立 DAG Session 模块

**状态**: Accepted
**日期**: 2026-06-05
**动机**:
- 避免耦合 OpenCode Session 的演化路径
- 简化实现（无 Effect、SyncEvent）
- 提高故障隔离
- 独立性能和测试控制

**后果**:
- DAG Session 不复用 OpenCode Session 代码
- OpenCode Session 变更不影响 DAG
- 跨上下文数据通过标识符引用

---

**文档版本**: 2.0（v1.0 已废弃）
**最后更新**: 2026-06-05
**审批状态**: ⭐ 待评审
