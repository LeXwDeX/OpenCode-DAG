import { describe, it, expect } from "bun:test"
import type { DAGWorkflowSession, DAGWorkflowStatus } from "@/dag/session/types"
import { calculateWorkflowProgress } from "@/dag/session/types"

function workflowStatusIcon(status: DAGWorkflowStatus): string {
  switch (status) {
    case "running":
      return "●"
    case "completed":
      return "✓"
    case "failed":
    case "failed_with_violations":
      return "✗"
    case "cancelled":
      return "⊘"
    case "pending":
    default:
      return "○"
  }
}

function createMockWorkflow(overrides: Partial<DAGWorkflowSession> = {}): DAGWorkflowSession {
  return {
    id: "wf-1",
    chat_session_id: "chat-1",
    config: {
      name: "Test Workflow",
      nodes: [],
      max_concurrency: 3,
    },
    status: "pending",
    node_sessions: {},
    violations: [],
    metadata: {},
    start_time: Date.now(),
    end_time: null,
    current_node: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    completed_at: null,
    duration_ms: null,
    ...overrides,
  }
}

describe("DAG Sidebar — workflowStatusIcon", () => {
  it("should return filled circle for running", () => {
    expect(workflowStatusIcon("running")).toBe("●")
  })

  it("should return check mark for completed", () => {
    expect(workflowStatusIcon("completed")).toBe("✓")
  })

  it("should return cross for failed and failed_with_violations", () => {
    expect(workflowStatusIcon("failed")).toBe("✗")
    expect(workflowStatusIcon("failed_with_violations")).toBe("✗")
  })

  it("should return slashed circle for cancelled", () => {
    expect(workflowStatusIcon("cancelled")).toBe("⊘")
  })

  it("should return empty circle for pending", () => {
    expect(workflowStatusIcon("pending")).toBe("○")
  })

  it("should return empty circle for unknown status", () => {
    expect(workflowStatusIcon("unknown" as DAGWorkflowStatus)).toBe("○")
  })
})

describe("DAG Sidebar — workflow list display", () => {
  it("should handle empty workflow list", () => {
    const workflows: DAGWorkflowSession[] = []
    expect(workflows.length).toBe(0)
    expect(workflows.filter((w) => w.status === "running").length).toBe(0)
  })

  it("should count running workflows", () => {
    const workflows: DAGWorkflowSession[] = [
      createMockWorkflow({ id: "wf-1", status: "running" }),
      createMockWorkflow({ id: "wf-2", status: "completed" }),
      createMockWorkflow({ id: "wf-3", status: "running" }),
      createMockWorkflow({ id: "wf-4", status: "failed" }),
    ]
    const runningCount = workflows.filter((w) => w.status === "running").length
    expect(runningCount).toBe(2)
  })

  it("should determine collapsible (>2 workflows)", () => {
    const twoWorkflows = [createMockWorkflow({ id: "1" }), createMockWorkflow({ id: "2" })]
    const threeWorkflows = [createMockWorkflow({ id: "1" }), createMockWorkflow({ id: "2" }), createMockWorkflow({ id: "3" })]

    expect(twoWorkflows.length > 2).toBe(false)
    expect(threeWorkflows.length > 2).toBe(true)
  })

  it("should use config name with fallback to id", () => {
    const wfWithName = createMockWorkflow({ config: { name: "Build Pipeline", nodes: [], max_concurrency: 3 } })
    const wfWithoutName = createMockWorkflow({ config: undefined as any })

    expect(wfWithName.config?.name ?? wfWithName.id).toBe("Build Pipeline")
    expect(wfWithoutName.config?.name ?? wfWithoutName.id).toBe("wf-1")
  })
})

describe("DAG Sidebar — progress display", () => {
  it("should show completed/total count", () => {
    const wf = createMockWorkflow({
      node_sessions: {
        "n1": {
          node_id: "n1", workflow_id: "wf-1", status: "completed", output: null,
          retry_count: 0, max_retries: 3, timeout_ms: 60000, required_nodes: [],
          dependencies: [], metadata: {}, start_time: null, completed_at: null,
          end_time: null, duration_ms: null, parent_node: null, created_at: Date.now(),
          updated_at: Date.now(), logs: [],
          config: { id: "n1", name: "N1", dependencies: [], required: true, worker_type: "code", worker_config: {} },
        },
        "n2": {
          node_id: "n2", workflow_id: "wf-1", status: "running", output: null,
          retry_count: 0, max_retries: 3, timeout_ms: 60000, required_nodes: [],
          dependencies: ["n1"], metadata: {}, start_time: Date.now(), completed_at: null,
          end_time: null, duration_ms: null, parent_node: null, created_at: Date.now(),
          updated_at: Date.now(), logs: [],
          config: { id: "n2", name: "N2", dependencies: ["n1"], required: true, worker_type: "test", worker_config: {} },
        },
        "n3": {
          node_id: "n3", workflow_id: "wf-1", status: "pending", output: null,
          retry_count: 0, max_retries: 3, timeout_ms: 60000, required_nodes: [],
          dependencies: ["n1"], metadata: {}, start_time: null, completed_at: null,
          end_time: null, duration_ms: null, parent_node: null, created_at: Date.now(),
          updated_at: Date.now(), logs: [],
          config: { id: "n3", name: "N3", dependencies: ["n1"], required: false, worker_type: "review", worker_config: {} },
        },
      },
    })
    const progress = calculateWorkflowProgress(wf)
    expect(progress.all_nodes.completed).toBe(1)
    expect(progress.all_nodes.total).toBe(3)
  })
})

describe("DAG Sidebar — export validation", () => {
  it("should export DAGSidebarView", async () => {
    const mod = await import("./sidebar")
    expect(mod.DAGSidebarView).toBeDefined()
    expect(typeof mod.DAGSidebarView).toBe("function")
  })
})
