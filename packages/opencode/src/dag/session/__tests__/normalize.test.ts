// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

import { describe, expect, it } from "bun:test"
import { normalizeDagConfig, normalizeDagNode } from "../normalize"
import type { DAGConfig, DAGNodeConfig } from "../types"

// ============================================================================
// 测试策略：覆盖 LLM 生成 JSON 时的真实失败模式
//
// 每个用例都模拟"LLM 会怎么写错"——字段缺失、类型错误、格式漂移。
// 归一化层的目标：把这些转成明确的、面向 agent 可读的错误信息，
// 而不是让引擎在运行时炸 undefined.filter。
// ============================================================================

describe("normalizeDagConfig — 结构性错误（必须拒绝）", () => {
  it("非对象顶层 → 拒绝", () => {
    expect(normalizeDagConfig(null).ok).toBe(false)
    expect(normalizeDagConfig("string").ok).toBe(false)
    expect(normalizeDagConfig(42).ok).toBe(false)
    expect(normalizeDagConfig([]).ok).toBe(false)
  })

  it("缺 name → 拒绝", () => {
    const r = normalizeDagConfig({ nodes: [], max_concurrency: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join("\n")).toContain("name")
  })

  it("name 为空字符串 → 拒绝", () => {
    const r = normalizeDagConfig({ name: "", nodes: [], max_concurrency: 1 })
    expect(r.ok).toBe(false)
  })

  it("缺 nodes → 拒绝", () => {
    const r = normalizeDagConfig({ name: "wf", max_concurrency: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join("\n")).toContain("nodes")
  })

  it("nodes 为空数组 → 拒绝", () => {
    const r = normalizeDagConfig({ name: "wf", nodes: [], max_concurrency: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join("\n")).toContain("at least one")
  })

  it("节点缺 id → 拒绝并指明位置", () => {
    const r = normalizeDagConfig({
      name: "wf",
      nodes: [{ name: "A", worker_type: "general", worker_config: { prompt: "x" } }],
      max_concurrency: 1,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join("\n")).toContain("node[0]")
  })

  it("节点缺 worker_type → 拒绝", () => {
    const r = normalizeDagConfig({
      name: "wf",
      nodes: [{ id: "a", name: "A", worker_config: {} }],
      max_concurrency: 1,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join("\n")).toContain("worker_type")
  })

  it("节点缺 worker_config → 拒绝", () => {
    const r = normalizeDagConfig({
      name: "wf",
      nodes: [{ id: "a", name: "A", worker_type: "general" }],
      max_concurrency: 1,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join("\n")).toContain("worker_config")
  })

  it("重复 id → 拒绝", () => {
    const r = normalizeDagConfig({
      name: "wf",
      nodes: [
        { id: "a", name: "A", worker_type: "g", worker_config: {} },
        { id: "a", name: "B", worker_type: "g", worker_config: {} },
      ],
      max_concurrency: 1,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join("\n")).toContain("duplicated")
  })

  it("max_concurrency 非整数 → 拒绝", () => {
    const r = normalizeDagConfig({
      name: "wf",
      nodes: [{ id: "a", name: "A", worker_type: "g", worker_config: {} }],
      max_concurrency: 2.5,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join("\n")).toContain("max_concurrency")
  })
})

describe("normalizeDagConfig — 安全缺省（必须补齐）", () => {
  it("缺 dependencies → 补 []", () => {
    // 这是 o.dependencies.filter 崩溃的直接根因
    const r = normalizeDagConfig({
      name: "wf",
      nodes: [{ id: "a", name: "A", worker_type: "g", worker_config: {} }],
      max_concurrency: 1,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.config.nodes[0].dependencies).toEqual([])
      // 补了 [] 后，后续的 .filter / .includes 都安全
      expect(r.config.nodes[0].dependencies.filter((d) => d.length > 0)).toEqual([])
    }
  })

  it("缺 required → 补 false", () => {
    const r = normalizeDagConfig({
      name: "wf",
      nodes: [{ id: "a", name: "A", worker_type: "g", worker_config: {} }],
      max_concurrency: 1,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.nodes[0].required).toBe(false)
  })

  it("缺 max_concurrency → 补 1", () => {
    const r = normalizeDagConfig({
      name: "wf",
      nodes: [{ id: "a", name: "A", worker_type: "g", worker_config: {} }],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.max_concurrency).toBe(1)
  })

  it("dependencies 含非字符串 → 过滤掉", () => {
    const r = normalizeDagConfig({
      name: "wf",
      nodes: [{
        id: "a", name: "A", worker_type: "g", worker_config: {},
        dependencies: ["b", 42, null, "c"] as unknown as string[],
      }],
      max_concurrency: 1,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.nodes[0].dependencies).toEqual(["b", "c"])
  })

  it("完整配置 → 原样通过，不丢字段", () => {
    const full: unknown = {
      name: "wf",
      description: "test wf",
      max_concurrency: 3,
      timeout_ms: 600000,
      nodes: [{
        id: "a", name: "A", description: "node a",
        dependencies: [], required: true,
        worker_type: "implement", worker_config: { prompt: "do it" },
        timeout_ms: 300000, failure_policy: "recoverable",
      }],
    }
    const r = normalizeDagConfig(full)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.config.name).toBe("wf")
      expect(r.config.description).toBe("test wf")
      expect(r.config.max_concurrency).toBe(3)
      expect(r.config.timeout_ms).toBe(600000)
      expect(r.config.nodes[0].required).toBe(true)
      expect(r.config.nodes[0].failure_policy).toBe("recoverable")
    }
  })
})

describe("normalizeDagNode — replan add_nodes 场景", () => {
  it("缺 dependencies → 补 []（replan 场景同样防御）", () => {
    const r = normalizeDagNode({ id: "x", name: "X", worker_type: "g", worker_config: {} }, 0)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.node.dependencies).toEqual([])
  })

  it("缺 id → 拒绝并指明 add_nodes 索引", () => {
    const r = normalizeDagNode({ name: "X", worker_type: "g", worker_config: {} }, 2)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join("\n")).toContain("add_nodes[2]")
  })

  it("非对象 → 拒绝", () => {
    expect(normalizeDagNode(null, 0).ok).toBe(false)
    expect(normalizeDagNode("string", 0).ok).toBe(false)
    expect(normalizeDagNode(42, 0).ok).toBe(false)
  })
})

describe("normalizeDagConfig — 模拟真实 LLM 失败模式", () => {
  it("LLM 漏 dependencies 字段（o.dependencies.filter 崩溃的根因）→ 补齐后不崩溃", () => {
    // 这是用户报告的 BUG 的精确复现：12 节点全无 dependencies 字段
    const llmOutput: unknown = {
      name: "go-to-rust-v3",
      max_concurrency: 4,
      nodes: Array.from({ length: 12 }, (_, i) => ({
        id: `node-${i}`,
        name: `Node ${i}`,
        worker_type: "implement",
        worker_config: { prompt: `task ${i}` },
        // 故意不写 dependencies
      })),
    }
    const r = normalizeDagConfig(llmOutput)
    expect(r.ok).toBe(true)
    if (r.ok) {
      // 所有节点的 dependencies 都被安全补齐为 []
      for (const n of r.config.nodes) {
        expect(n.dependencies).toEqual([])
        // 这行以前会崩溃：Cannot read properties of undefined (reading 'filter')
        expect(n.dependencies.filter((d) => d.length > 0)).toEqual([])
      }
    }
  })

  it("LLM 漏 worker_type → 明确报错而非运行时崩溃", () => {
    const llmOutput: unknown = {
      name: "wf",
      max_concurrency: 2,
      nodes: [{
        id: "a", name: "A", worker_config: { prompt: "x" },
        // 故意不写 worker_type
      }],
    }
    const r = normalizeDagConfig(llmOutput)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      // 错误信息面向 agent 可读：指名道姓
      expect(r.errors.join("\n")).toContain("node[0]")
      expect(r.errors.join("\n")).toContain("worker_type")
    }
  })
})

// ============================================================================
// C3 fix: timeout_ms 值域校验
// 历史 bug：normalize 透传 timeout_ms 但不校验，timeout_ms:0 会立即触发超时，
// 负数行为未定义。现在拒绝 0/负数/非整数/NaN。
// ============================================================================
describe("normalizeDagConfig — timeout_ms 值域校验 (C3)", () => {
  const baseNode = {
    id: "a", name: "A", worker_type: "general", worker_config: { prompt: "x" },
  }

  it("节点级 timeout_ms = 0 → 拒绝", () => {
    const r = normalizeDagConfig({
      name: "wf", max_concurrency: 1,
      nodes: [{ ...baseNode, timeout_ms: 0 }],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join("\n")).toContain("timeout_ms")
  })

  it("节点级 timeout_ms = -1 → 拒绝", () => {
    const r = normalizeDagConfig({
      name: "wf", max_concurrency: 1,
      nodes: [{ ...baseNode, timeout_ms: -1 }],
    })
    expect(r.ok).toBe(false)
  })

  it("节点级 timeout_ms = 1.5 (非整数) → 拒绝", () => {
    const r = normalizeDagConfig({
      name: "wf", max_concurrency: 1,
      nodes: [{ ...baseNode, timeout_ms: 1.5 }],
    })
    expect(r.ok).toBe(false)
  })

  it("节点级 timeout_ms = NaN → 拒绝", () => {
    const r = normalizeDagConfig({
      name: "wf", max_concurrency: 1,
      nodes: [{ ...baseNode, timeout_ms: NaN }],
    })
    expect(r.ok).toBe(false)
  })

  it("节点级 timeout_ms = 30000 (正整数) → 通过", () => {
    const r = normalizeDagConfig({
      name: "wf", max_concurrency: 1,
      nodes: [{ ...baseNode, timeout_ms: 30000 }],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.nodes[0].timeout_ms).toBe(30000)
  })

  it("工作流级 timeout_ms = 0 → 拒绝", () => {
    const r = normalizeDagConfig({
      name: "wf", max_concurrency: 1, timeout_ms: 0,
      nodes: [baseNode],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join("\n")).toContain("workflow")
  })

  it("工作流级 timeout_ms 缺省 → 通过（不写字段）", () => {
    const r = normalizeDagConfig({
      name: "wf", max_concurrency: 1,
      nodes: [baseNode],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.timeout_ms).toBeUndefined()
  })

  it("normalizeDagNode (replan add_nodes) timeout_ms = 0 → 拒绝", () => {
    const r = normalizeDagNode({ ...baseNode, timeout_ms: 0 }, 0)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join("\n")).toContain("timeout_ms")
  })
})
