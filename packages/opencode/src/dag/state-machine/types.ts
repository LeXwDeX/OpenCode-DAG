/**
 * @file State Machine Types
 * @description DAG 状态机核心类型定义
 * 
 * 参考：workflow-dag-architecture.md §3B.1 - §3B.4
 * 
 * 铁律检查：
 * - 状态转移必须通过引擎 API
 * - 事件必须广播
 * - 状态持久化优先
 */

// ============================================================================
// 1. 状态枚举
// ============================================================================

/**
 * Workflow 级状态
 * 
 * @description 工作流整体状态，决定引擎的调度行为
 * @see §3B.1
 */
export enum WorkflowStatus {
  /** 等待启动 */
  PENDING = 'pending',
  /** 至少一个节点正在执行 */
  RUNNING = 'running',
  /** 用户暂停，所有执行中的节点等待恢复 */
  PAUSED = 'paused',
  /** 所有 required_nodes 成功完成 */
  COMPLETED = 'completed',
  /** 关键节点失败且无法恢复 */
  FAILED = 'failed',
  /** 用户主动取消 */
  CANCELLED = 'cancelled',
  /** 长期存储，不再活跃 */
  ARCHIVED = 'archived',
}

/**
 * Node 级状态（普通节点）
 * 
 * @description 普通节点的执行状态
 * @see §3B.1
 */
export enum NodeStatus {
  /** 等待上游依赖完成 */
  PENDING = 'pending',
  /** agent session 正在执行 */
  RUNNING = 'running',
  /** 节点暂停（仅当 workflow paused 时传播） */
  PAUSED = 'paused',
  /** 成功调用 dag_completed 且通过所有校验 */
  COMPLETED = 'completed',
  /** 执行失败（exec_failed / push_exhausted / verdict_fail） */
  FAILED = 'failed',
  /** shadow 节点决定终止（decision: "abort"） */
  ABORTED = 'aborted',
  /** 由于上游失败或条件跳过而未执行 */
  SKIPPED = 'skipped',
}

/**
 * Shadow 节点状态（简化版）
 * 
 * @description Shadow 节点的特殊状态（不支持 paused/skipped/aborted）
 * 
 * 特殊规则：
 * - 无 `paused` 状态（shadow 不参与暂停传播）
 * - 无 `skipped` 状态（shadow 只在触发条件满足时执行）
 * - 无 `aborted` 状态（shadow 的 decision 决定**被诊断节点**的状态，而非自身）
 * 
 * @see §3B.1
 */
export enum ShadowNodeStatus {
  /** 等待触发 */
  PENDING = 'pending',
  /** shadow session 正在执行 */
  RUNNING = 'running',
  /** 调用 dag_completed 并返回 decision */
  COMPLETED = 'completed',
  /** shadow 自身执行失败 */
  FAILED = 'failed',
}

/**
 * 节点类型
 */
export enum NodeType {
  NORMAL = 'normal',
  SHADOW = 'shadow',
}

// ============================================================================
// 2. 状态转移触发条件
// ============================================================================

/**
 * 节点失败的触发原因
 * 
 * @description 记录导致节点进入 failed 状态的具体原因
 * @see §3B.3
 */
export enum FallbackTrigger {
  /** agent 输出错误/非零退出码 */
  EXEC_FAILED = 'exec_failed',
  /** push_count >= max_pushes */
  PUSH_EXHAUSTED = 'push_exhausted',
  /** dag_completed.output 关键字段判定失败 */
  VERDICT_FAIL = 'verdict_fail',
  /** 节点执行超时 */
  TIMEOUT = 'timeout',
}

/**
 * Workflow 状态转移触发条件
 * 
 * @see §3B.3
 */
export enum WorkflowTransition {
  /** DAG 实例创建 */
  DAG_EXECUTE = 'dag_execute',
  /** 引擎启动调度循环 */
  ENGINE_START = 'engine_start',
  /** 用户调用 dag_pause(workflow_id) */
  DAG_PAUSE = 'dag_pause',
  /** 用户调用 dag_resume(workflow_id) */
  DAG_RESUME = 'dag_resume',
  /** 所有 required_nodes 的 status == "completed" */
  ALL_REQUIRED_COMPLETED = 'all_required_completed',
  /** 关键节点失败 + fallback chain 耗尽 */
  CRITICAL_NODE_FAILED = 'critical_node_failed',
  /** 用户调用 dag_cancel(workflow_id) */
  DAG_CANCEL = 'dag_cancel',
  /** 自动归档（延迟配置） */
  AUTO_ARCHIVE = 'auto_archive',
  /** 用户手动归档 */
  USER_ARCHIVE = 'user_archive',
}

/**
 * Node 状态转移触发条件
 * 
 * @see §3B.3
 */
export enum NodeTransition {
  /** DAG 解析时注册节点 */
  NODE_REGISTER = 'node_register',
  /** 所有上游节点 status == "completed" + 引擎调度 */
  DEPENDENCIES_MET = 'dependencies_met',
  /** dag_completed 调用 + output 校验通过 + LSP clean */
  DAG_COMPLETED = 'dag_completed',
  /** exec_failed / push_exhausted / verdict_fail */
  EXEC_FAILED = 'exec_failed',
  /** workflow status → "paused" 传播 */
  WORKFLOW_PAUSED = 'workflow_paused',
  /** workflow status → "running" 传播 */
  WORKFLOW_RESUMED = 'workflow_resumed',
  /** fallback decision == "rerun" */
  FALLBACK_RERUN = 'fallback_rerun',
  /** fallback decision == "abort" */
  FALLBACK_ABORT = 'fallback_abort',
  /** 上游节点 failed/aborted + skip_on_failure == true */
  SKIP_ON_FAILURE = 'skip_on_failure',
}

// ============================================================================
// 3. 事件类型
// ============================================================================

/**
 * Diff 统计信息
 */
export interface DiffStats {
  files_changed_count: number;
  lines_added: number;
  lines_removed: number;
  patch_file: string;
}

/**
 * Workflow 事件
 * 
 * @description 工作流状态转移时发出的事件
 * @see §3B.4
 */
export type WorkflowEvent =
  | {
      type: 'workflow.created';
      workflow_id: string;
      template: string;
      timestamp: Date;
    }
  | {
      type: 'workflow.started';
      workflow_id: string;
      timestamp: Date;
    }
  | {
      type: 'workflow.paused';
      workflow_id: string;
      paused_at: Date;
    }
  | {
      type: 'workflow.resumed';
      workflow_id: string;
      timestamp: Date;
    }
  | {
      type: 'workflow.completed';
      workflow_id: string;
      duration_ms: number;
      accumulated_diff: string;
    }
  | {
      type: 'workflow.failed';
      workflow_id: string;
      reason: string;
      failed_nodes: string[];
    }
  | {
      type: 'workflow.cancelled';
      workflow_id: string;
      cancelled_at: Date;
    }
  | {
      type: 'workflow.archived';
      workflow_id: string;
      archived_at: Date;
    };

/**
 * Node 事件
 * 
 * @description 节点状态转移时发出的事件
 * @see §3B.4
 */
export type NodeEvent =
  | {
      type: 'node.registered';
      workflow_id: string;
      node_name: string;
      node_type: NodeType;
    }
  | {
      type: 'node.started';
      workflow_id: string;
      node_name: string;
      worktree_path: string;
    }
  | {
      type: 'node.completed';
      workflow_id: string;
      node_name: string;
      output_summary: any;
      diff_stats: DiffStats;
    }
  | {
      type: 'node.failed';
      workflow_id: string;
      node_name: string;
      trigger_reason: FallbackTrigger;
      error?: string;
    }
  | {
      type: 'node.paused';
      workflow_id: string;
      node_name: string;
      paused_at: Date;
    }
  | {
      type: 'node.resumed';
      workflow_id: string;
      node_name: string;
      timestamp: Date;
    }
  | {
      type: 'node.restarted';
      workflow_id: string;
      node_name: string;
      retry_count: number;
    }
  | {
      type: 'node.aborted';
      workflow_id: string;
      node_name: string;
      reason: string;
    }
  | {
      type: 'node.skipped';
      workflow_id: string;
      node_name: string;
      upstream_failed_node: string;
    }
  | {
      type: 'node.pushed';
      workflow_id: string;
      node_name: string;
      push_count: number;
      reason: string;
    }
  | {
      type: 'node.progress';
      workflow_id: string;
      node_name: string;
      progress_data: any;
    }
  | {
      type: 'node.ask_main';
      workflow_id: string;
      node_name: string;
      question: string;
      context?: string;
    }
  | {
      type: 'node.timeout';
      workflow_id: string;
      node_name: string;
      timeout_sec: number;
    };

// ============================================================================
// 4. 状态数据结构
// ============================================================================

/**
 * Node 状态数据
 * 
 * @description 存储节点的运行时状态
 * @see §3B.5
 */
export interface NodeStateData {
  /** 节点名称（对应 DAG 中的 name 字段） */
  node_name: string;
  /** 节点类型 */
  node_type: NodeType;
  /** 当前状态 */
  status: NodeStatus | ShadowNodeStatus;
  /** 节点开始执行时间（仅 running/completed/failed 有值） */
  started_at: string | null;
  /** 节点完成时间（仅 completed 有值） */
  completed_at: string | null;
  /** push 机制计数器（记录被 push 的次数） */
  pushed_count: number;
  /** fallback 链深度（记录 fallback 重试次数） */
  fallback_count: number;
  /** fallback 触发原因（仅 failed 有值） */
  fallback_trigger_reason: FallbackTrigger | null;
  /** 节点输出摘要（仅 completed 有值） */
  output_summary: any | null;
  /** 上游失败的节点名称（仅 skipped 有值） */
  skipped_by: string | null;
}

/**
 * Branch 状态数据
 * 
 * @description 存储分支的运行时状态，聚合所有节点状态
 * @see §3B.5
 */
export interface BranchStateData {
  /** 分支名称 */
  branch_name: string;
  /** 分支状态（由节点状态聚合计算） */
  status: NodeStatus;
  /** 该分支下的所有节点状态 */
  nodes: Record<string, NodeStateData>;
}

/**
 * Workflow 状态数据（state.json 结构）
 * 
 * @description 存储工作流的完整运行时状态
 * @see §3B.5
 */
export interface WorkflowStateData {
  /** 工作流 ID */
  workflow_id: string;
  /** 工作流状态 */
  status: WorkflowStatus;
  /** 工作流开始时间 */
  started_at: string;
  /** 暂停时间（仅 paused 状态有值） */
  paused_at: string | null;
  /** 完成时间（仅 completed/failed/cancelled 状态有值） */
  completed_at: string | null;
  /** 所有分支的状态 */
  branches: Record<string, BranchStateData>;
  /** 累积的 diff 文件路径（仅 completed 状态有值） */
  accumulated_diff: string | null;
}
