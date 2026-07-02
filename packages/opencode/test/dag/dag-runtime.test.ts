import { describe, expect, it } from "bun:test"
import { evaluateCondition, resolveInputMapping } from "@/dag/runtime/eval"
import { WorktreeManager } from "@/dag/runtime/worktree-manager"
import { DependencyGraph } from "@opencode-ai/core/dag/core/graph"
import { planReplan, computeOrphanCascade } from "@opencode-ai/core/dag/core/replan"
import { NodeStatus } from "@opencode-ai/core/dag/core/types"

describe("evaluateCondition", () => {
  it("returns true when condition is empty/undefined (fail-open)", () => {
    expect(evaluateCondition(undefined, {})).toBe(true)
    expect(evaluateCondition("", {})).toBe(true)
    expect(evaluateCondition("   ", {})).toBe(true)
  })

  it("returns true on unrecognized syntax (fail-open)", () => {
    expect(evaluateCondition("garbage syntax !! @#$", {})).toBe(true)
  })

  it("evaluates numeric comparisons", () => {
    const outputs = { "explore-src": { output: { count: 3 } } }
    expect(evaluateCondition("explore-src.output.count > 0", outputs)).toBe(true)
    expect(evaluateCondition("explore-src.output.count > 5", outputs)).toBe(false)
  })

  it("evaluates equality", () => {
    const outputs = { node: { output: { status: "ok" } } }
    expect(evaluateCondition('node.output.status == "ok"', outputs)).toBe(true)
    expect(evaluateCondition('node.output.status == "fail"', outputs)).toBe(false)
  })

  it("returns true when path resolves to undefined with != (fail-open)", () => {
    // When the path is missing, undefined != "something" → true
    expect(evaluateCondition('missing.path != "expected"', {})).toBe(true)
  })
})

describe("resolveInputMapping", () => {
  it("returns empty object for undefined mapping", () => {
    expect(resolveInputMapping(undefined, () => null)).toEqual({})
  })

  it("resolves node output reference", () => {
    const getOutput = (id: string) => (id === "refactor-core" ? { diff: "abc" } : undefined)
    const result = resolveInputMapping({ core_diff: "refactor-core.output" }, getOutput)
    expect(result).toEqual({ core_diff: { diff: "abc" } })
  })

  it("resolves nested field from output", () => {
    const getOutput = (id: string) => (id === "plan" ? { steps: ["a", "b"] } : undefined)
    const result = resolveInputMapping({ steps: "plan.output.steps" }, getOutput)
    expect(result).toEqual({ steps: ["a", "b"] })
  })
})

describe("WorktreeManager", () => {
  it("reads use_worktree flag preserving the canonical pattern", () => {
    expect(WorktreeManager.readUseWorktree({ use_worktree: true })).toBe(true)
    expect(WorktreeManager.readUseWorktree({ use_worktree: false })).toBe(false)
    expect(WorktreeManager.readUseWorktree({})).toBe(false)
    expect(WorktreeManager.readUseWorktree(undefined)).toBe(false)
  })
})

describe("planReplan integration (replan from runtime)", () => {
  it("classifies a mixed replan fragment correctly", () => {
    const plan = planReplan(
      {
        nodes: [
          { id: "a", status: NodeStatus.COMPLETED, depends_on: [] },
          { id: "b", status: NodeStatus.RUNNING, depends_on: ["a"] },
          { id: "c", status: NodeStatus.PENDING, depends_on: ["a"] },
          { id: "d", status: NodeStatus.PENDING, depends_on: ["c"] },
        ],
      },
      {
        nodes: [
          { id: "b", depends_on: ["a"], restart: true }, // restart running
          { id: "c", depends_on: ["a"] }, // replace pending
          { id: "e", depends_on: ["c"] }, // add new
        ],
      },
    )
    expect(plan.errors).toEqual([])
    expect(plan.restart).toContain("b")
    expect(plan.replace).toContain("c")
    expect(plan.add).toContain("e")
    expect(plan.cancel).toContain("d") // d is pending-not-in-fragment → cancelled
  })

  it("orphan cascade cancels downstream of cancelled nodes", () => {
    const g = new DependencyGraph()
    for (const id of ["a", "b", "c", "d"]) g.addNode(id)
    g.addEdge("b", "a")
    g.addEdge("c", "b")
    g.addEdge("d", "c")
    const orphans = computeOrphanCascade(g, ["a"])
    expect(orphans.sort()).toEqual(["b", "c", "d"])
  })
})
