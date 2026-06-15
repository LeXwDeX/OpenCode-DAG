// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * §4.3 DAG 初始化检查 — 每次 DAG 任务开始前的配置可用性校验。
 *
 * 当 opencode.json 的 `dag.bootstrap_check === true` 时，
 * `bootstrapWorkflowFromConfig` 在创建工作流行之前调用此模块校验：
 *
 * 1. 读取 ConfigDAG（model_levels、默认超时、bootstrap_check 开关）
 * 2. 校验 model_levels 中每个 `provider/model` 路径的 provider 是否在已注册列表中
 * 3. 校验工作流配置中引用的 model_level 是否在 model_levels 中有定义
 * 4. 校验默认超时值为有效正整数
 *
 * 检查失败时的行为（由调用方决定）：
 * - 返回 `{ ok: false, errors, warnings, configSnapshot }` 给调用方
 * - 调用方（bootstrapWorkflowFromConfig）可选择：
 *   a) 直接 fail（严格模式）
 *   b) 通过 QA 机制让用户选择模型（agent 枚举可选模型）
 *   c) 降级继续（记录 warning）
 *
 * 设计原则：本模块是**纯校验函数**，不执行任何副作用（不写 DB、不发起 prompt）。
 * 所有 QA 交互由调用方驱动（保证 agent 的控制权，§4.3 总体逻辑）。
 */

import { Effect, Option } from "effect"
import { Config } from "@/config/config"
import type { DAGConfig, DAGNodeConfig } from "./types"

/**
 * 检查结果。`ok: true` 表示配置可用；`ok: false` 表示存在阻断性错误。
 * `warnings` 为非阻断性提示（如未声明的 model_level 回退到默认模型）。
 */
export type BootstrapCheckResult =
  | { ok: true; warnings: string[]; configSnapshot: ConfigDAGSnapshot }
  | { ok: false; errors: string[]; warnings: string[]; configSnapshot: ConfigDAGSnapshot }

/**
 * ConfigDAG 的快照（用于审计和 QA 提示）。
 */
export interface ConfigDAGSnapshot {
  /** model_levels 的 key 列表（如 ['low', 'medium', 'high']） */
  availableLevels: string[]
  /** model_levels 的完整映射 */
  modelLevels: Record<string, string>
  /** 默认超时策略 */
  defaultTimeoutPolicy: 'fail' | 'notify'
  /** 默认节点超时（ms） */
  defaultNodeTimeoutMs: number | undefined
  /** 默认工作流超时（ms） */
  defaultWorkflowTimeoutMs: number | undefined
  /** bootstrap_check 是否启用 */
  bootstrapCheckEnabled: boolean
}

/**
 * 读取 ConfigDAG 快照。当 dag 配置不存在时返回缺省值。
 */
export function readConfigDAGSnapshot(config: Config.Info | undefined): ConfigDAGSnapshot {
  const dagConfig = config?.dag as ConfigDAGSnapshotSource | undefined
  const modelLevels = dagConfig?.model_levels ?? {}
  return {
    availableLevels: Object.keys(modelLevels),
    modelLevels,
    defaultTimeoutPolicy: dagConfig?.default_timeout_policy ?? 'fail',
    defaultNodeTimeoutMs: dagConfig?.default_node_timeout_ms,
    defaultWorkflowTimeoutMs: dagConfig?.default_workflow_timeout_ms,
    bootstrapCheckEnabled: dagConfig?.bootstrap_check ?? false,
  }
}

/**
 * 从 Config.Service 读取 DAG 默认值（best-effort Effect helper）。
 *
 * 供 workflow-engine（节点级）和 core-start（工作流级）在 Effect 上下文中调用，
 * 用于将 ConfigDAG 的 `default_*` 字段接入引擎作为缺省回退。
 *
 * - Config.Service 不可用 → 返回全 undefined 快照（调用方回退到硬编码默认）。
 * - Config.Service 可用但 dag 字段缺失 → readConfigDAGSnapshot 返回 'fail'/undefined。
 * - 任何异常 → 静默回退（不阻塞调度）。
 *
 * 返回值字段语义：
 * - `defaultNodeTimeoutMs`：节点未声明 timeout_ms 时的回退（undefined = 用 DEFAULT_NODE_TIMEOUT_MS）
 * - `defaultWorkflowTimeoutMs`：工作流未声明 timeout_ms 时的回退（undefined = 用 executor 默认）
 * - `defaultTimeoutPolicy`：节点/工作流未声明 timeout_policy 时的回退（'fail' | 'notify'）
 */
export function readDagDefaultsFromService(): Effect.Effect<ConfigDAGSnapshot, never, never> {
  return Effect.gen(function* () {
    const configService = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
    if (!configService) {
      return readConfigDAGSnapshot(undefined)
    }
    const cfg = yield* configService.get().pipe(
      Effect.catchCause(() => Effect.succeed(undefined as Config.Info | undefined)),
    )
    return readConfigDAGSnapshot(cfg)
  })
}

/** ConfigDAG 的最小类型（从 Config.Info.dag 提取） */
interface ConfigDAGSnapshotSource {
  model_levels?: Record<string, string>
  default_timeout_policy?: 'fail' | 'notify'
  default_node_timeout_ms?: number
  default_workflow_timeout_ms?: number
  bootstrap_check?: boolean
}

/**
 * 执行 DAG 初始化检查。
 *
 * @param dagConfig       即将启动的 DAG 工作流配置
 * @param opencodeConfig  opencode.json 配置（含 dag 字段）
 * @param registeredProviders  已注册的 provider ID 列表（用于校验 model_levels 路径）
 *
 * 纯函数，无副作用。调用方根据结果决定是否继续。
 */
export function runBootstrapCheck(args: {
  dagConfig: DAGConfig
  opencodeConfig: Config.Info | undefined
  registeredProviders: readonly string[]
}): Effect.Effect<BootstrapCheckResult> {
  return Effect.gen(function* () {
    const { dagConfig, opencodeConfig, registeredProviders } = args
    const snapshot = readConfigDAGSnapshot(opencodeConfig)
    const errors: string[] = []
    const warnings: string[] = []

    // 如果 bootstrap_check 未启用，直接返回 ok（向后兼容）。
    if (!snapshot.bootstrapCheckEnabled) {
      return { ok: true, warnings: [], configSnapshot: snapshot }
    }

    // 1. 校验 model_levels 中的 provider 是否已注册
    for (const [level, modelPath] of Object.entries(snapshot.modelLevels)) {
      const provider = modelPath.split("/")[0]
      if (!provider) {
        errors.push(`dag.model_levels.${level}: invalid model path '${modelPath}' (expected 'provider/model')`)
        continue
      }
      if (registeredProviders.length > 0 && !registeredProviders.includes(provider)) {
        errors.push(
          `dag.model_levels.${level}: provider '${provider}' is not registered. ` +
          `Available providers: ${registeredProviders.join(", ") || "<none>"}. ` +
          `Check opencode.json provider config or select a model via QA.`,
        )
      }
    }

    // 2. 校验工作流节点中引用的 model_level 是否在 model_levels 中有定义
    for (const node of dagConfig.nodes) {
      const modelLevel = (node.worker_config as { model_level?: string } | undefined)?.model_level
      if (modelLevel !== undefined) {
        if (!snapshot.modelLevels[modelLevel]) {
          errors.push(
            `node '${node.id}' references model_level '${modelLevel}' which is not defined in dag.model_levels. ` +
            `Available levels: ${snapshot.availableLevels.join(", ") || "<none>"}.`,
          )
        }
      }
    }

    // 3. 校验默认超时值（如果有设置且非正整数）
    if (
      snapshot.defaultNodeTimeoutMs !== undefined &&
      (!Number.isFinite(snapshot.defaultNodeTimeoutMs) || snapshot.defaultNodeTimeoutMs <= 0)
    ) {
      errors.push(`dag.default_node_timeout_ms must be a positive integer, got ${snapshot.defaultNodeTimeoutMs}`)
    }
    if (
      snapshot.defaultWorkflowTimeoutMs !== undefined &&
      (!Number.isFinite(snapshot.defaultWorkflowTimeoutMs) || snapshot.defaultWorkflowTimeoutMs <= 0)
    ) {
      errors.push(`dag.default_workflow_timeout_ms must be a positive integer, got ${snapshot.defaultWorkflowTimeoutMs}`)
    }

    // 4. 非阻断性 warnings
    // 4a. 节点声明了 model_level 但 model_levels 为空
    const nodesWithLevel = dagConfig.nodes.filter(
      (n: DAGNodeConfig) => (n.worker_config as { model_level?: string } | undefined)?.model_level !== undefined,
    )
    if (nodesWithLevel.length > 0 && snapshot.availableLevels.length === 0) {
      warnings.push(
        `${nodesWithLevel.length} node(s) declare worker_config.model_level but dag.model_levels is empty. ` +
        `Nodes will fall back to worker_config.model or agent default model.`,
      )
    }

    if (errors.length > 0) {
      return { ok: false, errors, warnings, configSnapshot: snapshot }
    }
    return { ok: true, warnings, configSnapshot: snapshot }
  })
}

/**
 * 构建一个 QA 提示消息，当初始化检查失败时展示给用户。
 * 包含错误列表、可用模型分级、可用 provider，供 agent 枚举给用户选择。
 *
 * 纯函数——只生成文本，不执行 prompt。
 */
export function buildBootstrapCheckQAPrompt(result: Extract<BootstrapCheckResult, { ok: false }>): string {
  const { errors, configSnapshot } = result
  const lines = [
    `<dag_bootstrap_check_failed>`,
    `DAG configuration check failed. Please fix the following errors or select models interactively.`,
    ``,
    `Errors:`,
    ...errors.map((e, i) => `  ${i + 1}. ${e}`),
    ``,
    `Available model levels:`,
    ...configSnapshot.availableLevels.map(
      (lvl) => `  - ${lvl}: ${configSnapshot.modelLevels[lvl]}`,
    ),
    `Available providers: check opencode.json provider config.`,
    ``,
    `You can:`,
    `  1. Fix dag.model_levels in opencode.json and retry`,
    `  2. Use the question tool to let the user select a model for each missing level`,
    `  3. Remove worker_config.model_level from nodes to use default models`,
    `</dag_bootstrap_check_failed>`,
  ]
  return lines.join("\n")
}
