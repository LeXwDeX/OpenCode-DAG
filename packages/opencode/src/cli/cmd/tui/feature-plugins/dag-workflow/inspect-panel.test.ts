import { describe, it, expect } from "bun:test"
import { formatInspectList, inspectPanelSummary, InspectPanel } from "./inspect-panel"

const diagnostics = {
  block: [
    { nodeId: "build", blocked: true, unsatisfiedDependencies: ["fetch"], reason: "deps_unsatisfied" as const },
    { nodeId: "test", blocked: false, unsatisfiedDependencies: [], reason: "ready" as const },
  ],
  topology: { workflowId: "wf-1", layers: [{ depth: 0, nodeIds: ["fetch"] }, { depth: 1, nodeIds: ["build", "test"] }], hasCycle: false, totalDepth: 2 },
  snapshot: { workflowId: "wf-1", running: ["build"], queued: [], ready: ["test"], pending: ["deploy"], blocked: [], spawnBudget: 1 },
  cascade: { originNodeId: "build", affectedPendingNodeIds: ["deploy"] },
}

describe("WP-C InspectPanel", () => {
  it("is exported as a function component", () => {
    expect(typeof InspectPanel).toBe("function")
  })

  it("summarizes block/topology/snapshot/cascade diagnostics", () => {
    const summary = inspectPanelSummary(diagnostics)

    expect(summary).toContain("Block: build deps_unsatisfied [fetch]; test ready")
    expect(summary).toContain("Topology: depth 0: fetch | depth 1: build,test; cycle: no")
    expect(summary).toContain("Snapshot: running build; ready test; pending deploy; spawn 1")
    expect(summary).toContain("Cascade: build -> deploy")
  })

  it("renders graceful loading, error, and empty summaries", () => {
    expect(inspectPanelSummary({ ...diagnostics, loading: true })).toContain("Loading")
    expect(inspectPanelSummary({ ...diagnostics, error: "boom" })).toContain("Error: boom")
    expect(inspectPanelSummary({ block: [], topology: null, snapshot: null, cascade: null })).toContain("No diagnostics")
  })

  it("formats empty lists as an em dash", () => {
    expect(formatInspectList([])).toBe("—")
  })
})
