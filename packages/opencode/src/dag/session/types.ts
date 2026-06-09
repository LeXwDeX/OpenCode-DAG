// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * DAG Session 核心数据结构
 *
 * 独立于 OpenCode Session 系统，提供 DAG Workflow 的持久化存储。
 * 设计原则：
 * - 完全独立：有自己的 SQLite 表，不依赖 OpenCode Session
 * - 通过 chat_session_id 关联：保留原始对话上下文
 * - 工具调用集成：状态变化以 tool_call 形式注入消息流
 */

// ============================================================================
// 1. 基础类型
// ============================================================================

/**
 * DAG 工作流状态
 *
 * 状态转换规则：
 * pending → running → completed (所有 required nodes 完成)
 *                   → failed (某个 required node 失败 / 有 skipped required nodes)
 *
 * 任何状态 → cancelled (用户取消)
 */
export type DAGWorkflowStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'paused';

/**
 * DAG 节点状态
 *
 * 状态转换规则：
 * pending → queued → running → completed (执行成功)
 *                            → failed (执行失败)
 *                            → skipped (required node 被跳过 = 违规)
 *                            → pending (recovery reset — orphaned running node, WP-A3)
 *
 * queued: 已满足依赖关系，等待执行槽位
 */
export type DAGNodeStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

// ============================================================================
// 2. 配置类型
// ============================================================================

/**
 * 条件表达式运算符（WP-B1 声明式条件语法）。
 *
 * - `eq` / `ne` — 值相等/不等
 * - `gt` / `lt` / `gte` / `lte` — 数值/字典序比较
 * - `exists` / `not_exists` — 检查上游 output 是否存在（忽略 value）
 *
 * 所有运算符作用于上游节点的 output（WP-B2 求值），value 为比较基准。
 * 缺省/缺省 value 的语义由 WP-B2 定义（运行时），schema 阶段仅校验结构合法性。
 */
export type DAGConditionOp = 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'exists' | 'not_exists'

/**
 * 所有合法的 DAGConditionOp 值（schema 校验白名单）。
 * 与 `DAGConditionOp` 类型同步维护；修改类型时必须同步更新此常量。
 */
export const DAG_CONDITION_OPS: readonly string[] = [
  'eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'exists', 'not_exists',
] as const

/**
 * 声明式条件表达式（WP-B1）。
 *
 * 用于 `DAGNodeConfig.condition` 字段，决定节点是否执行（WP-B2 求值）。
 * 必须是纯结构化对象，**禁止闭包/函数/代码注入**。
 *
 * 字段语义：
 * - `ref_node: string` — 引用的上游节点 ID，**必须是当前节点 `dependencies` 的子集**（schema 强制）。
 * - `op: DAGConditionOp` — 比较运算符。
 * - `value?: unknown` — 比较基准值。`exists` / `not_exists` 运算符忽略此字段。
 *
 * **与 `group-manager/types.ts:FallbackConfig.condition?:string` 的区别**：
 * - `DAGNodeCondition`（本类型）是**节点级**条件，结构化对象，声明式可序列化，
 *   影响节点是否执行（skip vs ready）。
 * - `FallbackConfig.condition` 是 **group 级**概念，string 形态，用于 shadow 节点
 *   的 custom trigger，与节点执行条件无关。两者语义完全不同，不可混淆。
 */
export interface DAGNodeCondition {
  /** 引用的上游节点 ID（必须是当前节点 dependencies 的子集） */
  ref_node: string;
  /** 比较运算符 */
  op: DAGConditionOp;
  /** 比较基准值（exists/not_exists 运算符忽略此字段） */
  value?: unknown;
}

/**
 * 单条输入映射记录（WP-C1 数据流声明语法）。
 *
 * 描述"从哪里获取数据"：
 * - `ref_node: string` — 数据来源的上游节点 ID，**必须是当前节点 `dependencies` 的子集**（schema 强制）。
 * - `ref_path?: string` — 可选的 JSON 路径，指向 ref_node output 的子字段。
 *   缺省语义 = 取整个 output 对象（运行时语义由 WP-C2 实现，C1 仅做静态结构校验）。
 *
 * 出处：`docs/design/009-dag-capability-expansion.md` §7 WP-C1。
 */
export interface DAGInputMappingEntry {
  /** 数据来源的上游节点 ID（必须是当前节点 dependencies 的子集） */
  ref_node: string;
  /** 可选路径，指向 ref_node output 的子字段（缺省 = 整个 output 对象） */
  ref_path?: string;
}

/**
 * 节点输入映射表（WP-C1）。
 *
 * **Record 形式**（非数组），INFO 1 选型理由：
 * - Record key（inputKey）天然唯一，无需额外重复校验。
 * - 查找 O(1)（下游 WP-C2/C3 按 inputKey 取值）。
 * - Schema 迭代简洁（Object.entries）。
 *
 * 与数组形式 `[{inputKey, ref_node, ref_path?}]` 相比，Record 避免了 inputKey
 * 重复声明和线性查找开销，同时保持完全可序列化/可校验。
 *
 * 出处：`docs/design/009-dag-capability-expansion.md` §7 WP-C1 INFO 1。
 */
export type DAGInputMapping = Record<string, DAGInputMappingEntry>

/**
 * DAG 节点定义
 *
 * **Architectural note** — `DAGNodeConfig` and `DAGConfig` (below) are the single
 * canonical sources of truth for DAG configuration shape. Every other document
 * (USER_GUIDE.md YAML examples, dagworker-reference.md, dag-worker.txt) MUST stay
 * consistent with these interfaces.
 *
 * Field semantics worth highlighting:
 *
 * - `worker_type` — free-form string routed via `Agent.Service.get(worker_type)`
 *   in workflow-engine.ts:spawnReadyNode. MUST match a registered agent. Built-in
 *   agents: `build`, `plan`, `general`, `explore`, `scout`. Users can register
 *   custom agents via opencode.json `agents: Record<string, AgentInfo>`. Many
 *   documented examples use `implement`, `verify`, `review` which are NOT
 *   built-in — they are custom agent names users would configure.
 *
 * - `dependencies: string[]` — bare `cfg.id` values (NOT namespaced with
 *   `workflowId::`). Namespacing happens at node materialization time in
 *   dagworker.ts, not in the config.
 *
 * - `required: boolean` — when `false`, node failure/skip does NOT cause
 *   workflow-level failure per `maybeFinalizeWorkflow`.
 *
 * - `worker_config: Record<string, unknown>` — opaque bag passed to workers.
 *   Known recognized keys: `prompt` (string), `agent` (agent name override),
 *   `use_worktree: true` (opt-in worktree isolation per B4-WP1),
 *   `subDagConfig` (WP-D2: nested DAGConfig when `worker_type === "dag"`).
 *
 * - `worker_type === "dag"` — **reserved word** (WP-D2). Triggers sub-DAG
 *   dispatch: spawnReadyNode short-circuits before agent resolution (workflow-
 *   engine.ts L528), extracts `worker_config.subDagConfig`, and recursively
 *   calls `bootstrapWorkflowFromConfig` to start the sub-workflow. Recursion
 *   depth capped at 3 (MAX_SUB_DAG_DEPTH, §3.3). "dag" MUST NOT be registered
 *   as an agent name — doing so causes reserved-word conflict.
 *
 * - `condition?: DAGNodeCondition` — (WP-B1) 声明式条件表达式。条件不满足时节点跳过（WP-B2/B3）。
 *   **required 节点禁止声明 condition**（§3.2 方案 1，schema 校验拒绝）。
 *   缺省 = 无条件执行（向后兼容，现有配置不受影响）。
 *
 * - `input_mapping?: DAGInputMapping` — (WP-C1) 声明式数据映射。控制"执行时注入什么上游数据"。
 *   ref_node ⊆ dependencies（schema 强制）。缺省 = 无数据注入（向后兼容）。
 *   与 `condition` 正交：condition 控制"是否执行"（skip vs ready），input_mapping 控制"执行时注入什么"。
 *   运行时数据收集由 WP-C2 实现（纯读 DB，无写）。
 */
export interface DAGNodeConfig {
  /** 节点唯一标识 */
  id: string;
  /** 节点显示名称 */
  name: string;
  /** 节点描述 */
  description?: string;
  /** 依赖的节点 ID 列表 */
  dependencies: string[];
  /** 是否为必需节点（跳过会触发违规） */
  required: boolean;
  /** 节点超时（毫秒） */
  timeout_ms?: number;
  /** 重试策略 */
  retry?: {
    max_attempts: number;
    delay_ms: number;
  };
  /** Worker 类型（用于路由到具体执行器） */
  worker_type: string;
  /** Worker 特定配置 */
  worker_config: Record<string, unknown>;
  /**
   * 声明式条件表达式（WP-B1）。
   *
   * - 缺省（undefined）= 节点无条件执行（向后兼容）。
   * - required 节点禁止声明此字段（schema 校验拒绝）。
   * - `ref_node` 必须是当前节点 `dependencies` 的子集（schema 校验拒绝越界引用）。
   * - 运行时求值由 WP-B2 实现（纯函数，无副作用）。
   */
  condition?: DAGNodeCondition;
  /**
   * 声明式数据映射（WP-C1）。
   *
   * - 缺省（undefined）= 节点无数据注入（向后兼容）。
   * - Record 形式：每个 key 为注入目标键，value 描述数据来源。
   * - `ref_node` 必须是当前节点 `dependencies` 的子集（schema 校验拒绝越界引用）。
   * - `ref_path` 可选，缺省 = 取整个 output 对象（运行时语义在 WP-C2）。
   * - 与 `condition` 正交：condition 控制"是否执行"，input_mapping 控制"执行时注入什么"。
   *
   * 运行时数据收集由 WP-C2 实现（纯读 DB，无写）。
   */
  input_mapping?: DAGInputMapping;
}

/**
 * WP-D2: Typed shape for `worker_config` when `worker_type === "dag"`.
 *
 * `DAGNodeConfig.worker_config` is `Record<string, unknown>` (opaque bag).
 * When the node is a sub-DAG dispatcher, it must carry `subDagConfig: DAGConfig`
 * — the full configuration of the child workflow. Other keys are ignored.
 *
 * The parent node (`worker_type="dag"`) remains in `running` state until the
 * sub-workflow converges (WP-D3: parent-child lifecycle bridge decides
 * completion semantics). WP-D2 only starts the sub-workflow; it does not
 * await completion.
 *
 * Validation chain for "dag" nodes:
 * - `validateWorkerTypes` (core-start.ts): skips agent registry resolution,
 *   checks that `subDagConfig` is present.
 * - `validateWorkflowConfigLimits` (limits.ts): applied to `subDagConfig`
 *   independently at `createWorkflow` time (nodes ≤20, concurrency ∈ [1,10]).
 * - `bootstrapWorkflowFromConfig` (core-start.ts): rejects depth > 3
 *   (`MAX_SUB_DAG_DEPTH`) before any DB writes.
 */
export interface SubDagWorkerConfig {
  /** Full configuration of the sub-DAG workflow (required for worker_type="dag") */
  subDagConfig: DAGConfig;
}

/**
 * DAG 工作流配置
 *
 * See `DAGNodeConfig` JSDoc above for the "canonical source of truth" contract
 * and field-level semantics that apply equally at the workflow level.
 */
export interface DAGConfig {
  /** 工作流名称（用于显示） */
  name: string;
  /** 工作流描述 */
  description?: string;
  /** 所有节点定义 */
  nodes: DAGNodeConfig[];
  /** 最大并发 worker 数 */
  max_concurrency: number;
  /** 工作流级别的超时（毫秒） */
  timeout_ms?: number;
}

// ============================================================================
// 3. 运行时状态
// ============================================================================

/**
 * DAG 工作流会话
 */
export interface DAGWorkflowSession {
  /** 工作流 ID（UUID v4 格式） */
  id: string;
  /** 关联的 Chat Session ID */
  chat_session_id: string;
  /** 工作流配置 */
  config: DAGConfig;
  /** 当前工作流状态 */
  status: DAGWorkflowStatus;
  /** 节点 ID → 节点会话映射 */
  node_sessions: Record<string, DAGNodeSession>;
  /** 违规记录 */
  violations: DAGViolation[];
  /** 元数据 */
  metadata: Record<string, unknown>;
  /** 开始时间戳（毫秒） */
  start_time: number;
  /** 结束时间戳（毫秒，未完成时为 null） */
  end_time: number | null;
  /** 当前正在执行的节点 ID */
  current_node: string | null;
  /** 创建时间戳（毫秒） */
  created_at: number;
  /** 更新时间戳（毫秒） */
  updated_at: number;
  /** 完成时间戳（毫秒，未完成时为 null） */
  completed_at: number | null;
  /** 总耗时（毫秒，未完成时为 null） */
  duration_ms: number | null;
}

/**
 * DAG 节点会话
 */
export interface DAGNodeSession {
  /** 节点 ID */
  node_id: string;
  /** 所属工作流 ID */
  workflow_id: string;
  /** 节点配置（从 config.nodes 复制） */
  config: DAGNodeConfig;
  /** 当前状态 */
  status: DAGNodeStatus;
  /** 节点输出（执行完成时的结果） */
  output: unknown;
  /** 错误信息（执行失败时的详情） */
  error_info?: DAGNodeError;
  /** 重试次数（0 表示首次执行，>0 表示已重试） */
  retry_count: number;
  /** 最大重试次数 */
  max_retries: number;
  /** 节点超时时间（毫秒） */
  timeout_ms: number;
  /** 必需节点依赖 */
  required_nodes: string[];
  /** 依赖节点 */
  dependencies: string[];
  /**
   * 节点元数据
   *
   * 已知字段：
   * - `chat_session_id?: string` — 由 worker spawn subagent 时写入，在节点进入 RUNNING 前（或同时）必填。
   *   用于 bridge 层将 DAG node 事件关联到平台 Chat Session（§10）。
   */
  metadata: Record<string, unknown>;
  /** 开始时间（毫秒时间戳，未开始时为 null） */
  start_time: number | null;
  /** 完成时间（毫秒时间戳，未完成时为 null） */
  completed_at: string | null;
  /** 结束时间（毫秒时间戳，未完成时为 null） */
  end_time: number | null;
  /** 执行耗时（毫秒，未完成时为 null） */
  duration_ms: number | null;
  /** 父节点 ID（如果有） */
  parent_node: string | null;
  /** 创建时间（毫秒时间戳） */
  created_at: number;
  /** 更新时间（毫秒时间戳） */
  updated_at: number;
  /** 捕获的日志 */
  logs: string[];
  /** 资源使用指标 */
  metrics?: DAGNodeMetrics;
}

/**
 * DAG 节点错误信息
 */
export interface DAGNodeError {
  /** 错误类型 */
  type: string;
  /** 错误消息 */
  message: string;
  /** 错误详情 */
  details?: Record<string, unknown>;
  /** 是否可重试 */
  retryable: boolean;
}

/**
 * DAG 节点资源指标
 */
export interface DAGNodeMetrics {
  /** CPU 使用率（0-100） */
  cpu_percent?: number;
  /** 内存使用（MB） */
  memory_mb?: number;
  /** 磁盘 I/O（MB） */
  disk_io_mb?: number;
  /** 网络 I/O（MB） */
  network_io_mb?: number;
}

// ============================================================================
// 4. 违规检测
// ============================================================================

/**
 * DAG violation categories:
 * - required_node_skipped / required_node_failed: required-node lifecycle
 * - max_nodes_exceeded / max_concurrency_exceeded / timeout_exceeded: capacity / time limits
 * - execution_failed: runtime failures during node spawn or execution
 * - subdag_depth_exceeded: WP-D2 — sub-DAG nesting exceeds MAX_SUB_DAG_DEPTH (3)
 * - subdag_timeout: WP-D3 — sub-DAG node never converged within timeout (§7 WP-D3)
 */
export const DAG_VIOLATION_TYPES = [
  "required_node_skipped",
  "required_node_failed",
  "max_nodes_exceeded",
  "max_concurrency_exceeded",
  "timeout_exceeded",
  "execution_failed",
  "process_orphan",
  "condition_skipped",
  "subdag_depth_exceeded",
  /** WP-D3: sub-DAG lifecycle bridge timeout fallback (§3.3 + §7 WP-D3). */
  "subdag_timeout",
] as const

export type DAGViolationType = (typeof DAG_VIOLATION_TYPES)[number]

/**
 * 违规严重性
 */
export type DAGViolationSeverity = 'info' | 'warning' | 'error' | 'critical';

/**
 * DAG 违规记录
 */
export interface DAGViolation {
  /** 违规 ID */
  id: string;
  /** 工作流 ID */
  workflowId: string;
  /** 违规类型 */
  type: DAGViolationType;
  /** 严重性 */
  severity: DAGViolationSeverity;
  /** 关联节点 ID */
  nodeId?: string;
  /** 违规消息 */
  message: string;
  /** 记录时间（ISO 8601） */
  timestamp: string;
  /** 附加信息 */
  details?: Record<string, unknown>;
}

// ============================================================================
// 5. 进度统计
// ============================================================================

/**
 * DAG 工作流进度
 */
export interface DAGWorkflowProgress {
  /** 必需节点统计 */
  required: {
    total: number;
    completed: number;
    failed: number;
    skipped: number;
    pending: number;
    running: number;
  };
  /** 所有节点统计 */
  all_nodes: {
    total: number;
    completed: number;
    failed: number;
    skipped: number;
    pending: number;
    running: number;
  };
  /** 当前并发数 */
  current_concurrency: number;
  /** 最大并发数 */
  max_concurrency: number;
  /** 预计剩余时间（毫秒，基于历史数据估算） */
  estimated_remaining_ms?: number;
}

// ============================================================================
// 6. API 请求/响应类型
// ============================================================================

/**
 * 创建 Workflow 请求
 */
export interface CreateWorkflowRequest {
  /** Chat Session ID */
  chat_session_id: string;
  /** 工作流配置 */
  config: DAGConfig;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 更新节点请求
 */
export interface UpdateNodeRequest {
  /** 新状态 */
  status?: DAGNodeStatus;
  /** 节点输出 */
  output?: unknown;
  /** 错误信息 */
  error_info?: DAGNodeError;
  /** 重试次数 */
  retry_count?: number;
  /** 日志追加 */
  append_logs?: string[];
  /** 资源指标 */
  metrics?: DAGNodeMetrics;
}

/**
 * 查询违规工作流请求
 */
export interface QueryViolatedWorkflowsRequest {
  /** 违规类型过滤 */
  violation_types?: DAGViolationType[];
  /** 严重性过滤 */
  severities?: DAGViolationSeverity[];
  /** 时间范围（ISO 8601） */
  since?: string;
  until?: string;
}

// ============================================================================
// 7. 工具类型
// ============================================================================

/**
 * 类型守卫：判断状态是否为终态
 */
export function isTerminalStatus(status: DAGWorkflowStatus): boolean {
  return ['completed', 'failed', 'cancelled'].includes(status);
}

/**
 * 类型守卫：判断节点状态是否为终态
 */
export function isNodeTerminalStatus(status: DAGNodeStatus): boolean {
  return ['completed', 'failed', 'skipped'].includes(status);
}

/**
 * 计算工作流进度
 */
export function calculateWorkflowProgress(session: DAGWorkflowSession): DAGWorkflowProgress {
  const nodes = Object.values(session.node_sessions);
  const requiredNodes = nodes.filter(n => n.config.required);
  const allNodes = nodes;

  const countByStatus = (list: typeof nodes, status: DAGNodeStatus | DAGNodeStatus[]): number => {
    const statusArr = Array.isArray(status) ? status : [status];
    return list.filter(n => statusArr.includes(n.status)).length;
  };

  return {
    required: {
      total: requiredNodes.length,
      completed: countByStatus(requiredNodes, 'completed'),
      failed: countByStatus(requiredNodes, 'failed'),
      skipped: countByStatus(requiredNodes, 'skipped'),
      pending: countByStatus(requiredNodes, 'pending'),
      running: countByStatus(requiredNodes, ['queued', 'running']),
    },
    all_nodes: {
      total: allNodes.length,
      completed: countByStatus(allNodes, 'completed'),
      failed: countByStatus(allNodes, 'failed'),
      skipped: countByStatus(allNodes, 'skipped'),
      pending: countByStatus(allNodes, 'pending'),
      running: countByStatus(allNodes, ['queued', 'running']),
    },
    current_concurrency: countByStatus(allNodes, 'running'),
    max_concurrency: session.config.max_concurrency,
    estimated_remaining_ms: estimateRemainingTime(session),
  };
}

/**
 * 估算剩余时间（简单实现：基于已完成节点的平均耗时）
 */
function estimateRemainingTime(session: DAGWorkflowSession): number | undefined {
  const completedNodes = Object.values(session.node_sessions).filter(n => n.status === 'completed' && n.duration_ms);

  if (completedNodes.length === 0) {
    return undefined; // 没有历史数据
  }

  const avgDuration = completedNodes.reduce((sum, n) => sum + (n.duration_ms || 0), 0) / completedNodes.length;
  const pendingCount = Object.values(session.node_sessions).filter(n =>
    ['pending', 'queued'].includes(n.status)
  ).length;

  return Math.round(avgDuration * pendingCount / session.config.max_concurrency);
}

/**
 * 创建空的 Workflow 会话
 */
export function createEmptyWorkflowSession(
  chatSessionId: string,
  config: DAGConfig,
  metadata?: Record<string, unknown>
): DAGWorkflowSession {
  const now = new Date().toISOString();
  const nowMs = Date.now();

  return {
    id: generateWorkflowId(),
    chat_session_id: chatSessionId,
    config,
    status: 'pending',
    node_sessions: {},
    violations: [],
    created_at: nowMs,
    updated_at: nowMs,
    start_time: nowMs,
    end_time: null,
    current_node: null,
    completed_at: null,
    duration_ms: null,
    metadata: metadata || {},
  };
}

/**
 * 生成 Workflow ID（UUID v4）
 */
function generateWorkflowId(): string {
  // 简单实现：时间戳 + 随机数
  // 生产环境应使用 crypto.randomUUID() 或类似库
  return `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================================
// 8. Replan types
// ============================================================================

/**
 * Per-node patch applied during replan.
 * `node_id` is namespaced (${workflowId}::${cfg.id}).
 * `new_config` patches everything except `id` and `dependencies`.
 * `new_dependencies` replaces the node's dependency list (namespaced references).
 */
export interface ReplanNodePatch {
  node_id: string
  new_config?: Partial<Omit<DAGNodeConfig, 'id' | 'dependencies'>>
  new_dependencies?: string[]
}

/**
 * ReplanPatch is the input to `WorkflowEngine.replanWorkflow`.
 *
 * - `add_nodes`: array of DAGNodeConfig with `cfg.id` NOT namespaced (materialization
 *   prefixes with `${workflowId}::` inside the engine).
 * - `remove_nodes`: namespaced ids of pending nodes to drop.
 * - `update_nodes`: per-node patches (namespaced ids, applied to pending nodes only).
 * - `new_max_concurrency`: optional bump within 1..10.
 * - `changed_by`: free-form audit tag.
 */
export interface ReplanPatch {
  workflow_id: string
  add_nodes?: DAGNodeConfig[]
  remove_nodes?: string[]
  update_nodes?: ReplanNodePatch[]
  new_max_concurrency?: number
  changed_by?: string
}

/**
 * Result of a replan attempt.
 * `ok: true` carries the history_id and the diff counts; `ok: false` carries a reason
 * string and optional detail (typically the thrown Error).
 */
export type ReplanResult =
  | {
      ok: true
      workflow_id: string
      history_id: string
      nodes_added: number
      nodes_removed: number
      nodes_updated: number
      final_total: number
    }
  | { ok: false; reason: string; detail?: unknown }
