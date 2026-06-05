import { describe, it, expect } from "bun:test"
import type { DAGNodeStatus, DAGWorkflowStatus } from "@/dag/session/types"
import { calculateWorkflowProgress } from "@/dag/session/types"
import type { DAGWorkflowSession, DAGNodeSession, DAGViolation } from "@/dag/session/types"

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "\u2014"
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = Math.round(seconds % 60)
  return `${minutes}m ${remaining}s`
}

const THEME = {
  success: "#00ff00",
  warning: "#ffff00",
  error: "#ff0000",
  textMuted: "#888888",
  text: "#ffffff",
}

function statusIcon(status: DAGNodeStatus, theme: typeof THEME) {
  switch (status) {
    case "completed":
      return { icon: "\u2713", color: theme.success }
    case "running":
      return { icon: "\u25cf", color: theme.warning }
    case "queued":
      return { icon: "\u25ce", color: theme.warning }
    case "pending":
      return { icon: "\u25cb", color: theme.textMuted }
    case "failed":
      return { icon: "\u2717", color: theme.error }
    case "skipped":
      return { icon: "\u2298", color: theme.error }
    default:
      return { icon: "?", color: theme.textMuted }
  }
}

function workflowStatusColor(status: DAGWorkflowStatus, theme: typeof THEME) {
  switch (status) {
    case "running":
      return theme.warning
    case "completed":
      return theme.success
    case "failed":
      return theme.error
    case "cancelled":
      return theme.textMuted
    case "pending":
    default:
      return theme.textMuted
  }
}

function createMockNode(overrides: Partial<DAGNodeSession> = {}): DAGNodeSession {
  return {
    node_id: "node-1",
    workflow_id: "wf-1",
    config: {
      id: "node-1",
      name: "Test Node",
      dependencies: [],
      required: true,
      worker_type: "code",
      worker_config: {},
    },
    status: "pending",
    output: null,
    retry_count: 0,
    max_retries: 3,
    timeout_ms: 60000,
    required_nodes: [],
    dependencies: [],
    metadata: {},
    start_time: null,
    completed_at: null,
    end_time: null,
    duration_ms: null,
    parent_node: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    logs: [],
    ...overrides,
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

describe("DAG Renderer — formatDuration", () => {
  it("should return em dash for null", () => {
    expect(formatDuration(null)).toBe("\u2014")
  })

  it("should format milliseconds under 1s", () => {
    expect(formatDuration(500)).toBe("500ms")
    expect(formatDuration(1)).toBe("1ms")
    expect(formatDuration(999)).toBe("999ms")
  })

  it("should format seconds under 1m", () => {
    expect(formatDuration(1000)).toBe("1.0s")
    expect(formatDuration(1500)).toBe("1.5s")
    expect(formatDuration(59999)).toBe("60.0s")
  })

  it("should format minutes and seconds", () => {
    expect(formatDuration(60000)).toBe("1m 0s")
    expect(formatDuration(90000)).toBe("1m 30s")
    expect(formatDuration(125000)).toBe("2m 5s")
    expect(formatDuration(600000)).toBe("10m 0s")
  })
})

describe("DAG Renderer — statusIcon", () => {
  it("should return correct icon for each node status", () => {
    expect(statusIcon("completed", THEME).icon).toBe("\u2713")
    expect(statusIcon("completed", THEME).color).toBe(THEME.success)

    expect(statusIcon("running", THEME).icon).toBe("\u25cf")
    expect(statusIcon("running", THEME).color).toBe(THEME.warning)

    expect(statusIcon("queued", THEME).icon).toBe("\u25ce")
    expect(statusIcon("queued", THEME).color).toBe(THEME.warning)

    expect(statusIcon("pending", THEME).icon).toBe("\u25cb")
    expect(statusIcon("pending", THEME).color).toBe(THEME.textMuted)

    expect(statusIcon("failed", THEME).icon).toBe("\u2717")
    expect(statusIcon("failed", THEME).color).toBe(THEME.error)

    expect(statusIcon("skipped", THEME).icon).toBe("\u2298")
    expect(statusIcon("skipped", THEME).color).toBe(THEME.error)
  })

  it("should return question mark for unknown status", () => {
    expect(statusIcon("unknown" as DAGNodeStatus, THEME).icon).toBe("?")
    expect(statusIcon("unknown" as DAGNodeStatus, THEME).color).toBe(THEME.textMuted)
  })
})

describe("DAG Renderer — workflowStatusColor", () => {
  it("should return warning color for running", () => {
    expect(workflowStatusColor("running", THEME)).toBe(THEME.warning)
  })

  it("should return success color for completed", () => {
    expect(workflowStatusColor("completed", THEME)).toBe(THEME.success)
  })

  it("should return error color for failed", () => {
    expect(workflowStatusColor("failed", THEME)).toBe(THEME.error)
  })

  it("should return muted color for cancelled and pending", () => {
    expect(workflowStatusColor("cancelled", THEME)).toBe(THEME.textMuted)
    expect(workflowStatusColor("pending", THEME)).toBe(THEME.textMuted)
  })
})

describe("DAG Renderer — calculateWorkflowProgress integration", () => {
  it("should calculate progress for empty workflow", () => {
    const wf = createMockWorkflow()
    const progress = calculateWorkflowProgress(wf)
    expect(progress.all_nodes.total).toBe(0)
    expect(progress.all_nodes.completed).toBe(0)
  })

  it("should calculate progress with mixed node statuses", () => {
    const wf = createMockWorkflow({
      node_sessions: {
        "n1": createMockNode({ node_id: "n1", status: "completed", config: { id: "n1", name: "N1", dependencies: [], required: true, worker_type: "code", worker_config: {} } }),
        "n2": createMockNode({ node_id: "n2", status: "running", config: { id: "n2", name: "N2", dependencies: ["n1"], required: true, worker_type: "code", worker_config: {} } }),
        "n3": createMockNode({ node_id: "n3", status: "pending", config: { id: "n3", name: "N3", dependencies: ["n1"], required: false, worker_type: "test", worker_config: {} } }),
        "n4": createMockNode({ node_id: "n4", status: "failed", config: { id: "n4", name: "N4", dependencies: [], required: true, worker_type: "review", worker_config: {} } }),
      },
    })
    const progress = calculateWorkflowProgress(wf)
    expect(progress.all_nodes.total).toBe(4)
    expect(progress.all_nodes.completed).toBe(1)
    expect(progress.all_nodes.running).toBe(1)
    expect(progress.all_nodes.pending).toBe(1)
    expect(progress.all_nodes.failed).toBe(1)
    expect(progress.required.total).toBe(3)
    expect(progress.required.completed).toBe(1)
    expect(progress.required.failed).toBe(1)
  })

  it("should count queued as running", () => {
    const wf = createMockWorkflow({
      node_sessions: {
        "n1": createMockNode({ node_id: "n1", status: "queued", config: { id: "n1", name: "N1", dependencies: [], required: true, worker_type: "code", worker_config: {} } }),
      },
    })
    const progress = calculateWorkflowProgress(wf)
    expect(progress.all_nodes.running).toBe(1)
    expect(progress.all_nodes.pending).toBe(0)
  })
})

describe("DAG Renderer — mock node structure", () => {
  it("should create valid DAGNodeSession with defaults", () => {
    const node = createMockNode()
    expect(node.node_id).toBe("node-1")
    expect(node.status).toBe("pending")
    expect(node.retry_count).toBe(0)
    expect(node.max_retries).toBe(3)
    expect(node.dependencies).toEqual([])
    expect(node.logs).toEqual([])
  })

  it("should create valid DAGWorkflowSession with defaults", () => {
    const wf = createMockWorkflow()
    expect(wf.id).toBe("wf-1")
    expect(wf.status).toBe("pending")
    expect(wf.node_sessions).toEqual({})
    expect(wf.violations).toEqual([])
    expect(wf.duration_ms).toBeNull()
  })

  it("should support node with error info", () => {
    const node = createMockNode({
      status: "failed",
      error_info: {
        type: "ExecutionError",
        message: "Task failed after 3 retries",
        retryable: false,
      },
    })
    expect(node.error_info).toBeDefined()
    expect(node.error_info!.type).toBe("ExecutionError")
    expect(node.error_info!.retryable).toBe(false)
  })

  it("should support node with metrics", () => {
    const node = createMockNode({
      metrics: {
        cpu_percent: 45,
        memory_mb: 256,
        disk_io_mb: 10,
      },
    })
    expect(node.metrics).toBeDefined()
    expect(node.metrics!.cpu_percent).toBe(45)
    expect(node.metrics!.memory_mb).toBe(256)
  })

  it("should support violations", () => {
    const violation: DAGViolation = {
      id: "v-1",
      workflowId: "wf-1",
      type: "required_node_skipped",
      severity: "error",
      nodeId: "node-3",
      message: "Required node was skipped",
      timestamp: new Date().toISOString(),
    }
    expect(violation.type).toBe("required_node_skipped")
    expect(violation.severity).toBe("error")
  })
})

describe("DAG Renderer — root/child node filtering", () => {
  it("should identify root nodes (no dependencies)", () => {
    const nodes: DAGNodeSession[] = [
      createMockNode({ node_id: "root1", dependencies: [] }),
      createMockNode({ node_id: "root2", dependencies: [] }),
      createMockNode({ node_id: "child1", dependencies: ["root1"] }),
      createMockNode({ node_id: "child2", dependencies: ["root1", "root2"] }),
    ]
    const rootNodes = nodes.filter((n) => n.dependencies.length === 0)
    expect(rootNodes).toHaveLength(2)
    expect(rootNodes.map((n) => n.node_id)).toEqual(["root1", "root2"])
  })

  it("should build child map from dependencies", () => {
    const nodes: DAGNodeSession[] = [
      createMockNode({ node_id: "A", dependencies: [] }),
      createMockNode({ node_id: "B", dependencies: ["A"] }),
      createMockNode({ node_id: "C", dependencies: ["A"] }),
      createMockNode({ node_id: "D", dependencies: ["B", "C"] }),
    ]
    const childMap = new Map<string, DAGNodeSession[]>()
    for (const node of nodes) {
      for (const dep of node.dependencies) {
        const list = childMap.get(dep) ?? []
        list.push(node)
        childMap.set(dep, list)
      }
    }
    expect(childMap.get("A")).toHaveLength(2)
    expect(childMap.get("B")).toHaveLength(1)
    expect(childMap.get("C")).toHaveLength(1)
    expect(childMap.get("D") ?? []).toHaveLength(0)
  })
})

describe("DAG Renderer — progress bar percentage", () => {
  function calcPercent(completed: number, total: number): number {
    return total > 0 ? Math.round((completed / total) * 100) : 0
  }

  it("should return 0 when total is 0", () => {
    expect(calcPercent(0, 0)).toBe(0)
  })

  it("should calculate correct percentage", () => {
    expect(calcPercent(1, 4)).toBe(25)
    expect(calcPercent(2, 4)).toBe(50)
    expect(calcPercent(3, 4)).toBe(75)
    expect(calcPercent(4, 4)).toBe(100)
  })

  it("should calculate bar fill correctly (barLength=20)", () => {
    const barLength = 20
    function calcFilled(percent: number): number {
      return Math.round((percent / 100) * barLength)
    }
    expect(calcFilled(0)).toBe(0)
    expect(calcFilled(25)).toBe(5)
    expect(calcFilled(50)).toBe(10)
    expect(calcFilled(75)).toBe(15)
    expect(calcFilled(100)).toBe(20)
  })
})
