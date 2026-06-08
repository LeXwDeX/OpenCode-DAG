/**
 * renderer.ts 测试 — formatProgressSummary 纯函数测试
 *
 * 覆盖：
 * - null/undefined → "—"
 * - 全 0 节点 → "0/0 nodes"
 * - required 节点有进度
 * - required 节点有失败
 * - 并发 running 显示
 * - ETA 显示（有 estimated_remaining_ms 时）
 * - 全完成 fallback（无 required/concurrency/ETA）
 */
import { describe, it, expect } from "bun:test"
import type { DAGWorkflowProgress } from "@/dag/session/types"
import { formatProgressSummary } from "./renderer"

function makeProgress(overrides: Partial<DAGWorkflowProgress> = {}): DAGWorkflowProgress {
  return {
    required: { total: 0, completed: 0, failed: 0, skipped: 0, pending: 0, running: 0 },
    all_nodes: { total: 0, completed: 0, failed: 0, skipped: 0, pending: 0, running: 0 },
    current_concurrency: 0,
    max_concurrency: 0,
    ...overrides,
  }
}

describe("formatProgressSummary", () => {
  it("null → em-dash", () => {
    expect(formatProgressSummary(null, "en")).toBe("\u2014")
  })

  it("undefined → em-dash", () => {
    expect(formatProgressSummary(undefined, "en")).toBe("\u2014")
  })

  it("0 total nodes → '0/0 nodes'", () => {
    const p = makeProgress()
    expect(formatProgressSummary(p, "en")).toBe("0/0 nodes")
  })

  it("required progress shown when required.total > 0", () => {
    const p = makeProgress({
      required: { total: 5, completed: 3, failed: 0, skipped: 0, pending: 2, running: 0 },
      all_nodes: { total: 8, completed: 5, failed: 0, skipped: 0, pending: 3, running: 0 },
    })
    const out = formatProgressSummary(p, "en")
    expect(out).toContain("required: 3/5")
  })

  it("failed count shown when required.failed > 0", () => {
    const p = makeProgress({
      required: { total: 5, completed: 2, failed: 1, skipped: 0, pending: 2, running: 0 },
      all_nodes: { total: 5, completed: 2, failed: 1, skipped: 0, pending: 2, running: 0 },
    })
    const out = formatProgressSummary(p, "en")
    expect(out).toContain("required: 2/5")
    expect(out).toContain("failed: 1")
  })

  it("concurrency shown when current_concurrency > 0", () => {
    const p = makeProgress({
      required: { total: 3, completed: 1, failed: 0, skipped: 0, pending: 1, running: 1 },
      all_nodes: { total: 5, completed: 2, failed: 0, skipped: 0, pending: 2, running: 1 },
      current_concurrency: 2,
      max_concurrency: 3,
    })
    const out = formatProgressSummary(p, "en")
    expect(out).toContain("2/3 running")
  })

  it("ETA shown when estimated_remaining_ms > 0", () => {
    const p = makeProgress({
      all_nodes: { total: 10, completed: 5, failed: 0, skipped: 0, pending: 5, running: 0 },
      estimated_remaining_ms: 90_000,
    })
    const out = formatProgressSummary(p, "en")
    expect(out).toMatch(/ETA: 1m 30s/)
  })

  it("no ETA when estimated_remaining_ms is 0", () => {
    const p = makeProgress({
      required: { total: 3, completed: 1, failed: 0, skipped: 0, pending: 2, running: 0 },
      all_nodes: { total: 3, completed: 1, failed: 0, skipped: 0, pending: 2, running: 0 },
      estimated_remaining_ms: 0,
    })
    const out = formatProgressSummary(p, "en")
    expect(out).not.toContain("ETA")
  })

  it("fallback to X/Y nodes when no required/concurrency/ETA", () => {
    const p = makeProgress({
      all_nodes: { total: 5, completed: 5, failed: 0, skipped: 0, pending: 0, running: 0 },
    })
    const out = formatProgressSummary(p, "en")
    expect(out).toBe("5/5 nodes")
  })

  it("zh locale: nodes → 节点", () => {
    const p = makeProgress()
    expect(formatProgressSummary(p, "zh")).toBe("0/0 节点")
  })

  it("zh locale: required → 必需", () => {
    const p = makeProgress({
      required: { total: 4, completed: 2, failed: 0, skipped: 0, pending: 2, running: 0 },
      all_nodes: { total: 4, completed: 2, failed: 0, skipped: 0, pending: 2, running: 0 },
    })
    const out = formatProgressSummary(p, "zh")
    expect(out).toContain("必需: 2/4")
  })

  it("parts are joined by middle dot", () => {
    const p = makeProgress({
      required: { total: 5, completed: 3, failed: 1, skipped: 0, pending: 0, running: 1 },
      all_nodes: { total: 5, completed: 3, failed: 1, skipped: 0, pending: 0, running: 1 },
      current_concurrency: 1,
      max_concurrency: 2,
    })
    const out = formatProgressSummary(p, "en")
    expect(out.split(" \u00b7 ").length).toBeGreaterThanOrEqual(2)
  })
})
