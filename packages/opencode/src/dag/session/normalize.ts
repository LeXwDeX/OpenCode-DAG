// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * DAG 配置归一化层 —— 防御 LLM 生成 JSON 时的字段缺省与类型漂移。
 *
 * 背景：`dagworker.ts` 入口和 `core-start.ts:bootstrapWorkflowFromConfig`
 * 之前直接消费 `JSON.parse` 的产物。`JSON.parse` 只能抓语法错误，无法
 * 保证产物的字段形状与 `DAGConfig` / `DAGNodeConfig` 类型声明一致。
 * LLM 常见错误模式：
 *   1. 漏写 `dependencies` → 下游 `node.dependencies.filter(...)` 崩溃
 *      （`required-nodes-validator.ts:71`、`limits.ts:156` 等）。
 *   2. 漏写 `required` → 后续把 undefined 当 falsy 容忍，但状态机判定不一致。
 *   3. `worker_type` 漏写 → worker 路由阶段才炸，错误信息离根因十万八千里。
 *   4. `worker_config` 漏写 → 子会话 spawn 时拿不到 prompt。
 *
 * 本模块在解析后、引擎消费前做两件事：
 *   - **归一化**：对可安全补缺省的字段（`dependencies: []`、`required: false`、
 *     `max_concurrency: 1`）原地补齐，避免运行时 undefined。
 *   - **硬校验**：对不可缺省的关键字段（`id`、`name`、`worker_type`、
 *     `worker_config`、`nodes` 非空等）返回明确的 `{ ok: false, errors }`，
 *     把"运行时崩溃"转成"入口即拒绝并指名道姓"。
 *
 * 返回的 `normalized` 对象保证满足 `DAGConfig` 的最小结构契约，
 * 后续 validator（RequiredNodesValidator / validateWorkflowConfigLimits /
 * validateWorkerTypes）可以安全地直接读字段。
 *
 * 设计纪律：
 *   - 纯函数，无 Effect / 无 DB / 无副作用。
 *   - 只补"安全缺省"，绝不猜测语义（不替 LLM 编 `worker_type`）。
 *   - 错误信息面向 agent 可读：列出具体节点 id + 缺失字段名。
 */

import type { DAGConfig, DAGNodeConfig } from "./types"

/**
 * 归一化结果。
 * - `ok: true` 时 `config` 已补齐安全缺省，可直接传给下游 validator。
 * - `ok: false` 时 `errors` 列出所有阻断性问题（可能多条），调用方应整体拒绝。
 */
export type NormalizeResult =
  | { ok: true; config: DAGConfig }
  | { ok: false; errors: string[] }

/**
 * 归一化 DAG 工作流配置。
 *
 * 调用时机：`dagworker.ts` `JSON.parse` 之后、`bootstrapWorkflowFromConfig` 之前。
 * 也适用于 HTTP mutation 入口和任何从外部 JSON 构造 DAGConfig 的路径。
 *
 * @param raw `JSON.parse` 的原始产物，类型不保证
 */
export function normalizeDagConfig(raw: unknown): NormalizeResult {
  const errors: string[] = []

  // ── 顶层结构 ──
  if (!isObject(raw)) {
    return { ok: false, errors: ["workflow config must be a JSON object"] }
  }

  // name：必填字符串
  if (typeof raw.name !== "string" || raw.name.length === 0) {
    errors.push("workflow 'name' is required and must be a non-empty string")
  }

  // nodes：必填数组
  if (!Array.isArray(raw.nodes)) {
    errors.push("workflow 'nodes' must be an array")
    return { ok: false, errors } // 没 nodes 后面没法继续，直接返回
  }
  if (raw.nodes.length === 0) {
    errors.push("workflow 'nodes' must contain at least one node")
  }

  // max_concurrency：可缺省补 1，但若提供必须合法
  let maxConcurrency = 1
  if (raw.max_concurrency !== undefined) {
    if (typeof raw.max_concurrency !== "number" || !Number.isInteger(raw.max_concurrency)) {
      errors.push(`workflow 'max_concurrency' must be an integer, got ${typeof raw.max_concurrency}`)
    } else {
      maxConcurrency = raw.max_concurrency
    }
  }

  // ── 逐节点归一化 + 校验 ──
  const seenIds = new Set<string>()
  const normalizedNodes: DAGNodeConfig[] = []

  for (let i = 0; i < raw.nodes.length; i++) {
    const rawNode = raw.nodes[i]
    const prefix = `node[${i}]`

    if (!isObject(rawNode)) {
      errors.push(`${prefix} must be a JSON object`)
      continue
    }

    // id：必填非空字符串，且全局唯一
    const nodeId = rawNode.id
    if (typeof nodeId !== "string" || nodeId.length === 0) {
      errors.push(`${prefix} 'id' is required and must be a non-empty string`)
    } else if (seenIds.has(nodeId)) {
      errors.push(`${prefix} 'id'='${nodeId}' is duplicated`)
    } else {
      seenIds.add(nodeId)
    }

    // name：必填非空字符串
    if (typeof rawNode.name !== "string" || rawNode.name.length === 0) {
      errors.push(`${prefix} 'name' is required and must be a non-empty string`)
    }

    // worker_type：必填非空字符串（不在此校验是否已注册，那是后续 validator 的职责）
    if (typeof rawNode.worker_type !== "string" || rawNode.worker_type.length === 0) {
      errors.push(`${prefix} 'worker_type' is required and must be a non-empty string`)
    }

    // worker_config：必填对象
    if (!isObject(rawNode.worker_config)) {
      errors.push(`${prefix} 'worker_config' is required and must be a JSON object`)
    }

    // 归一化节点：补安全缺省
    const normalizedNode: DAGNodeConfig = {
      id: typeof nodeId === "string" ? nodeId : `<invalid-${i}>`,
      name: typeof rawNode.name === "string" ? rawNode.name : `<invalid-${i}>`,
      // 安全缺省：无依赖就是 []
      dependencies: Array.isArray(rawNode.dependencies)
        ? (rawNode.dependencies.filter((d: unknown) => typeof d === "string") as string[])
        : [],
      // 安全缺省：未声明 required 视为 false（非必需）
      required: rawNode.required === true,
      worker_type: typeof rawNode.worker_type === "string" ? rawNode.worker_type : "",
      worker_config: isObject(rawNode.worker_config) ? rawNode.worker_config : {},
      ...(rawNode.description !== undefined ? { description: String(rawNode.description) } : {}),
      ...(rawNode.timeout_ms !== undefined ? { timeout_ms: rawNode.timeout_ms as number } : {}),
      ...(rawNode.retry !== undefined ? { retry: rawNode.retry as DAGNodeConfig["retry"] } : {}),
      ...(rawNode.condition !== undefined ? { condition: rawNode.condition as DAGNodeConfig["condition"] } : {}),
      ...(rawNode.input_mapping !== undefined ? { input_mapping: rawNode.input_mapping as DAGNodeConfig["input_mapping"] } : {}),
      ...(rawNode.timeout_policy !== undefined ? { timeout_policy: rawNode.timeout_policy as DAGNodeConfig["timeout_policy"] } : {}),
      ...(rawNode.failure_policy !== undefined ? { failure_policy: rawNode.failure_policy as DAGNodeConfig["failure_policy"] } : {}),
    }
    normalizedNodes.push(normalizedNode)
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  // 组装归一化后的 config（浅拷贝顶层 + 替换 nodes）
  const config: DAGConfig = {
    name: raw.name as string,
    nodes: normalizedNodes,
    max_concurrency: maxConcurrency,
    ...(raw.description !== undefined ? { description: String(raw.description) } : {}),
    ...(raw.timeout_ms !== undefined ? { timeout_ms: raw.timeout_ms as number } : {}),
    ...(raw.timeout_policy !== undefined ? { timeout_policy: raw.timeout_policy as DAGConfig["timeout_policy"] } : {}),
    ...(raw.failure_handler !== undefined ? { failure_handler: raw.failure_handler as DAGConfig["failure_handler"] } : {}),
  }

  return { ok: true, config }
}

/**
 * 归一化单个 `DAGNodeConfig`（用于 replan 的 add_nodes）。
 *
 * 与 `normalizeDagConfig` 的节点级逻辑一致：补安全缺省 + 硬校验关键字段。
 * 不校验 id 唯一性（replan 场景下唯一性由引擎保证）。
 *
 * @param rawNode `JSON.parse` 的原始节点产物
 * @param index 节点在 add_nodes 数组中的位置（错误信息用）
 */
export function normalizeDagNode(rawNode: unknown, index: number): { ok: true; node: DAGNodeConfig } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const prefix = `add_nodes[${index}]`

  if (!isObject(rawNode)) {
    return { ok: false, errors: [`${prefix} must be a JSON object`] }
  }

  const nodeId = rawNode.id
  if (typeof nodeId !== "string" || nodeId.length === 0) {
    errors.push(`${prefix} 'id' is required and must be a non-empty string`)
  }
  if (typeof rawNode.name !== "string" || rawNode.name.length === 0) {
    errors.push(`${prefix} 'name' is required and must be a non-empty string`)
  }
  if (typeof rawNode.worker_type !== "string" || rawNode.worker_type.length === 0) {
    errors.push(`${prefix} 'worker_type' is required and must be a non-empty string`)
  }
  if (!isObject(rawNode.worker_config)) {
    errors.push(`${prefix} 'worker_config' is required and must be a JSON object`)
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  const node: DAGNodeConfig = {
    id: nodeId as string,
    name: rawNode.name as string,
    dependencies: Array.isArray(rawNode.dependencies)
      ? (rawNode.dependencies.filter((d: unknown) => typeof d === "string") as string[])
      : [],
    required: rawNode.required === true,
    worker_type: rawNode.worker_type as string,
    worker_config: (rawNode.worker_config as Record<string, unknown>) ?? {},
    ...(rawNode.description !== undefined ? { description: String(rawNode.description) } : {}),
    ...(rawNode.timeout_ms !== undefined ? { timeout_ms: rawNode.timeout_ms as number } : {}),
    ...(rawNode.retry !== undefined ? { retry: rawNode.retry as DAGNodeConfig["retry"] } : {}),
    ...(rawNode.condition !== undefined ? { condition: rawNode.condition as DAGNodeConfig["condition"] } : {}),
    ...(rawNode.input_mapping !== undefined ? { input_mapping: rawNode.input_mapping as DAGNodeConfig["input_mapping"] } : {}),
    ...(rawNode.timeout_policy !== undefined ? { timeout_policy: rawNode.timeout_policy as DAGNodeConfig["timeout_policy"] } : {}),
    ...(rawNode.failure_policy !== undefined ? { failure_policy: rawNode.failure_policy as DAGNodeConfig["failure_policy"] } : {}),
  }

  return { ok: true, node }
}

// ── 内部工具 ──

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
