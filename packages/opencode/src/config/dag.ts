import { Schema } from "effect"
import { PositiveInt } from "@opencode-ai/core/schema"

/**
 * ConfigDAG — DAG 工作流引擎的全局配置模块（§4 DAG 配置仓库增强）。
 *
 * 承载以下配置项：
 * - model_levels: 模型分级（low / medium / high），路径格式为 `provider/model`，
 *   与 opencode.json 顶层 `model` / `small_model` 字段格式一致。
 *   DAG 节点可通过 worker_config.model_level 引用分级，引擎在 spawn 时解析为具体模型。
 * - default_timeout_policy: 默认超时策略（'fail' | 'notify'），作为未显式声明
 *   timeout_policy 的工作流/节点的回退值。
 * - default_node_timeout_ms / default_workflow_timeout_ms: 默认超时阈值。
 * - bootstrap_check: 初始化检查开关（§4.3），工作流启动前校验配置可用性。
 *
 * 配置示例（opencode.json）：
 * ```json
 * {
 *   "dag": {
 *     "model_levels": {
 *       "low": "local-proxy-compatible/deepseek-v4-flash",
 *       "medium": "local-proxy-compatible/deepseek-v4-pro",
 *       "high": "local-proxy-compatible/deepseek-v4-max"
 *     },
 *     "default_timeout_policy": "notify",
 *     "default_node_timeout_ms": 1800000,
 *     "default_workflow_timeout_ms": 3600000,
 *     "bootstrap_check": true
 *   }
 * }
 * ```
 *
 * 所有字段均可选；缺省时回退到 limits.ts 中的硬编码默认值。
 */
export const Info = Schema.Struct({
  /**
   * 模型分级（§4.2）。key 为分级名（low / medium / high 或自定义），
   * value 为 `provider/model` 格式的模型路径，与 opencode.json 的 model 字段格式一致。
   *
   * DAG 节点通过 `worker_config.model_level: "low" | "medium" | "high"` 引用，
   * 引擎在 spawnReadyNode 时解析为具体的 provider/model 对（覆盖 worker_config.model）。
   *
   * 缺省 = 无分级，节点回退到 worker_config.model 或 agent 默认模型。
   */
  model_levels: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description:
      "Model tiers for DAG nodes. Keys are tier names (e.g. 'low', 'medium', 'high'); values are 'provider/model' paths consistent with opencode.json model field. Nodes reference tiers via worker_config.model_level.",
  }),

  /**
   * 默认超时策略（§2.2）。作为未显式声明 timeout_policy 的工作流/节点的回退值。
   * 缺省 = 'fail'（向后兼容）。
   */
  default_timeout_policy: Schema.optional(Schema.Literals(["fail", "notify"])).annotate({
    description:
      "Default timeout policy for workflows/nodes that do not declare timeout_policy explicitly. 'fail' (default) cancels on timeout; 'notify' keeps running and notifies the agent.",
  }),

  /**
   * 默认节点超时（毫秒）。作为未声明 timeout_ms 的节点的回退值。
   * 缺省时引擎使用 limits.ts 的 DEFAULT_NODE_TIMEOUT_MS（30 分钟）。
   */
  default_node_timeout_ms: Schema.optional(PositiveInt).annotate({
    description: "Default node timeout in milliseconds. Falls back to DEFAULT_NODE_TIMEOUT_MS (30 min) when unset.",
  }),

  /**
   * 默认工作流超时（毫秒）。作为未声明 timeout_ms 的工作流的回退值。
   * 缺省时 executor 使用 DEFAULT_MAX_RUNTIME_MS（10 分钟）。
   */
  default_workflow_timeout_ms: Schema.optional(PositiveInt).annotate({
    description: "Default workflow timeout in milliseconds. Falls back to executor default (10 min) when unset.",
  }),

  /**
   * 初始化检查开关（§4.3）。为 true 时，每次 DAG 任务开始前执行配置可用性校验：
   * - 检查 model_levels 中引用的 provider/model 是否在已注册 provider 列表中
   * - 检查默认超时值是否为有效正整数
   * 如果检查发现错误，通过 QA 机制提示用户（agent 可枚举可选模型供用户选择）。
   * 缺省 = false（向后兼容，不执行额外检查）。
   */
  bootstrap_check: Schema.optional(Schema.Boolean).annotate({
    description:
      "When true, runs a config availability check before each DAG workflow starts. On failure, prompts the user to fix config or select models. Default: false.",
  }),
})

export type Info = Schema.Schema.Type<typeof Info>

export * as ConfigDAG from "./dag"
