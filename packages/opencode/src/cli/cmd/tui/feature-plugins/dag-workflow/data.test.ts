/**
 * WP3 data.ts hooks 测试
 *
 * 测试策略：
 * - Phase 2: 测试断言 hooks 应返回 mock 数据（初始 FAIL，因为 stub 返回 [] / null）
 * - Phase 3: 填充 mock 数据后，测试应 PASS
 *
 * 测试不在此阶段运行（由 verify agent 统一执行）。
 */
import { describe, it, expect } from "bun:test"
import {
  useWorkflowList,
  useWorkflow,
  useNodes,
  useViolations,
  useTimeline,
  kvKeys,
} from "./data"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type {
  DAGNodeSession,
  DAGViolation,
  DAGWorkflowSession,
} from "@/dag/session/types"

const mockKv = (): TuiPluginApi["kv"] => {
  return {
    get: () => undefined,
    set: () => {},
    signal: () => [() => undefined, () => {}],
  } as unknown as TuiPluginApi["kv"]
}

describe("WP3 data.ts — useWorkflowList", () => {
  it("should return an array of workflow sessions", () => {
    const { list } = useWorkflowList({
      kv: mockKv(),
      session_id: () => "session-123",
    })
    const result = list()
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBeGreaterThan(0)
    const first = result[0]
    expect(first).toHaveProperty("id")
    expect(first).toHaveProperty("status")
    expect(first).toHaveProperty("config")
    expect(first).toHaveProperty("node_sessions")
  })
})

describe("WP3 data.ts — useWorkflow", () => {
  it("should return a single workflow or null", () => {
    const { workflow } = useWorkflow({
      kv: mockKv(),
      workflowId: () => "wf-123",
    })
    const result = workflow()
    expect(result).not.toBeNull()
    expect(result?.id).toBe("wf-123")
    expect(result?.status).toBeDefined()
  })

  it("should return null when workflowId is undefined", () => {
    const { workflow } = useWorkflow({
      kv: mockKv(),
      workflowId: () => undefined,
    })
    expect(workflow()).toBeNull()
  })
})

describe("WP3 data.ts — useNodes", () => {
  it("should return nodes for a workflow", () => {
    const { nodes } = useNodes({
      kv: mockKv(),
      workflowId: () => "wf-123",
    })
    const result = nodes()
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBeGreaterThan(0)
    const first = result[0]
    expect(first).toHaveProperty("node_id")
    expect(first).toHaveProperty("status")
    expect(first).toHaveProperty("dependencies")
  })
})

describe("WP3 data.ts — useViolations", () => {
  it("should return violations for a workflow", () => {
    const { violations } = useViolations({
      kv: mockKv(),
      workflowId: () => "wf-456",
    })
    const result = violations()
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBeGreaterThan(0)
    const first = result[0]
    expect(first).toHaveProperty("id")
    expect(first).toHaveProperty("type")
    expect(first).toHaveProperty("severity")
    expect(first).toHaveProperty("message")
  })
})

describe("WP3 data.ts — useTimeline", () => {
  it("should return timeline events for a workflow", () => {
    const { events } = useTimeline({
      kv: mockKv(),
      workflowId: () => "wf-123",
    })
    const result = events()
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBeGreaterThan(0)
    const first = result[0]
    expect(first).toHaveProperty("id")
    expect(first).toHaveProperty("type")
    expect(first).toHaveProperty("timestamp")
    expect(first).toHaveProperty("label")
  })
})

describe("WP3 data.ts — kvKeys helper", () => {
  it("should produce expected KV key prefixes", () => {
    expect(kvKeys.workflowList("s1")).toContain("s1")
    expect(kvKeys.workflow("w1")).toContain("w1")
    expect(kvKeys.nodes("w1")).toContain("w1")
    expect(kvKeys.violations("w1")).toContain("w1")
    expect(kvKeys.timeline("w1")).toContain("w1")
  })
})
