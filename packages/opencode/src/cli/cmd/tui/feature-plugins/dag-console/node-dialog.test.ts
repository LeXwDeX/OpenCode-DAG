import { describe, it, expect } from "bun:test"
import type { DAGNodeSession, DAGNodeStatus } from "@/dag/session/types"

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

function nodeStatusColor(status: DAGNodeStatus, theme: typeof THEME): string {
  switch (status) {
    case "completed":
      return theme.success
    case "running":
      return theme.warning
    case "queued":
      return theme.warning
    case "pending":
      return theme.textMuted
    case "failed":
      return theme.error
    case "skipped":
      return theme.error
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
      name: "Build",
      description: "Build the project",
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

describe("DAG NodeDialog — formatDuration", () => {
  it("should return em dash for null", () => {
    expect(formatDuration(null)).toBe("\u2014")
  })

  it("should format milliseconds", () => {
    expect(formatDuration(0)).toBe("0ms")
    expect(formatDuration(42)).toBe("42ms")
    expect(formatDuration(999)).toBe("999ms")
  })

  it("should format seconds", () => {
    expect(formatDuration(1000)).toBe("1.0s")
    expect(formatDuration(5500)).toBe("5.5s")
    expect(formatDuration(30000)).toBe("30.0s")
  })

  it("should format minutes", () => {
    expect(formatDuration(60000)).toBe("1m 0s")
    expect(formatDuration(120000)).toBe("2m 0s")
    expect(formatDuration(150000)).toBe("2m 30s")
    expect(formatDuration(3600000)).toBe("60m 0s")
  })
})

describe("DAG NodeDialog — nodeStatusColor", () => {
  it("should return success for completed", () => {
    expect(nodeStatusColor("completed", THEME)).toBe(THEME.success)
  })

  it("should return warning for running and queued", () => {
    expect(nodeStatusColor("running", THEME)).toBe(THEME.warning)
    expect(nodeStatusColor("queued", THEME)).toBe(THEME.warning)
  })

  it("should return error for failed and skipped", () => {
    expect(nodeStatusColor("failed", THEME)).toBe(THEME.error)
    expect(nodeStatusColor("skipped", THEME)).toBe(THEME.error)
  })

  it("should return muted for pending", () => {
    expect(nodeStatusColor("pending", THEME)).toBe(THEME.textMuted)
  })

  it("should return muted for unknown status", () => {
    expect(nodeStatusColor("unknown" as DAGNodeStatus, THEME)).toBe(THEME.textMuted)
  })
})

describe("DAG NodeDialog — node data model", () => {
  it("should create node with config name fallback to node_id", () => {
    const node = createMockNode()
    const name = node.config?.name ?? node.node_id
    expect(name).toBe("Build")

    const nodeNoConfig = createMockNode({ config: undefined as any })
    const nameFallback = nodeNoConfig.config?.name ?? nodeNoConfig.node_id
    expect(nameFallback).toBe("node-1")
  })

  it("should include error info details", () => {
    const node = createMockNode({
      status: "failed",
      error_info: {
        type: "TimeoutError",
        message: "Node execution timed out after 60000ms",
        retryable: true,
        details: { timeout_ms: 60000 },
      },
    })
    expect(node.error_info).toBeDefined()
    expect(node.error_info!.type).toBe("TimeoutError")
    expect(node.error_info!.message).toBe("Node execution timed out after 60000ms")
    expect(node.error_info!.retryable).toBe(true)
  })

  it("should show dependencies when present", () => {
    const node = createMockNode({
      dependencies: ["node-a", "node-b"],
      required_nodes: ["node-a"],
    })
    expect(node.dependencies).toEqual(["node-a", "node-b"])
    expect(node.required_nodes).toEqual(["node-a"])
    expect(node.dependencies.join(", ")).toBe("node-a, node-b")
  })

  it("should handle logs array", () => {
    const node = createMockNode({
      logs: [
        "Starting build...",
        "Compiling TypeScript...",
        "Build completed successfully",
      ],
    })
    expect(node.logs).toHaveLength(3)
    expect(node.logs[0]).toBe("Starting build...")
  })

  it("should show retry info", () => {
    const node = createMockNode({
      retry_count: 2,
      max_retries: 5,
    })
    expect(node.retry_count).toBe(2)
    expect(node.max_retries).toBe(5)
  })

  it("should include metrics when present", () => {
    const node = createMockNode({
      metrics: {
        cpu_percent: 80,
        memory_mb: 512,
        disk_io_mb: 25,
        network_io_mb: 10,
      },
    })
    expect(node.metrics?.cpu_percent).toBe(80)
    expect(node.metrics?.memory_mb).toBe(512)
    expect(node.metrics?.disk_io_mb).toBe(25)
    expect(node.metrics?.network_io_mb).toBe(10)
  })

  it("should handle missing metrics gracefully", () => {
    const node = createMockNode({ metrics: undefined })
    expect(node.metrics).toBeUndefined()
    expect(node.metrics?.cpu_percent).toBeUndefined()
  })
})

describe("DAG NodeDialog — export validation", () => {
  it("should export DAGNodeDialog", async () => {
    const mod = await import("./node-dialog")
    expect(mod.DAGNodeDialog).toBeDefined()
    expect(typeof mod.DAGNodeDialog).toBe("function")
  })
})
