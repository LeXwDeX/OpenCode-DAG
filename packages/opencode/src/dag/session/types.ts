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
 *                   → failed (某个 required node 失败且 no fallback)
 *                   → failed_with_violations (有 skipped required nodes)
 *
 * 任何状态 → cancelled (用户取消)
 */
export type DAGWorkflowStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'failed_with_violations';

/**
 * DAG 节点状态
 *
 * 状态转换规则：
 * pending → queued → running → completed (执行成功)
 *                            → failed (执行失败)
 *                            → skipped (required node 被跳过 = 违规)
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
 * DAG 节点定义
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
}

/**
 * DAG 工作流配置
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
  /** 节点元数据 */
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
 * 违规类型
 */
export type DAGViolationType =
  | 'required_node_skipped'
  | 'required_node_failed'
  | 'max_nodes_exceeded'
  | 'max_concurrency_exceeded'
  | 'timeout_exceeded';

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
  return ['completed', 'failed', 'cancelled', 'failed_with_violations'].includes(status);
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
