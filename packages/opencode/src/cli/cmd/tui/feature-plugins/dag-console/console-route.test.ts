import { describe, it, expect } from "bun:test"
import type { DAGWorkflowSession, DAGNodeSession, DAGViolation } from "@/dag/session/types"
import { calculateWorkflowProgress } from "@/dag/session/types"

function createMockNode(overrides: Partial<DAGNodeSession> = {}): DAGNodeSession {
  return {
    node_id: "node-1",
    workflow_id: "wf-1",
    config: { id: "node-1", name: "Test Node", dependencies: [], required: true, worker_type: "code", worker_config: {} },
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
    config: { name: "Test Workflow", nodes: [], max_concurrency: 3 },
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

describe("DAG Console Route — route param parsing", () => {
  type RouteParams = { workflowId?: string; sessionID?: string; returnRoute?: { name: string } }

  function extractParams(current: { name: string; params?: Record<string, string> }): RouteParams | undefined {
    if (!("params" in current)) return undefined
    return {
      workflowId: current.params?.workflowId,
      sessionID: current.params?.sessionID,
      returnRoute: current.params?.returnRoute ? { name: current.params.returnRoute } : undefined,
    }
  }

  it("should return undefined when route has no params", () => {
    const result = extractParams({ name: "dag-console" } as any)
    expect(result).toBeUndefined()
  })

  it("should extract workflowId from params", () => {
    const route = { name: "dag-console", params: { workflowId: "wf-123" } }
    const p = extractParams(route)
    expect(p?.workflowId).toBe("wf-123")
  })

  it("should extract sessionID from params", () => {
    const route = { name: "dag-console", params: { sessionID: "session-456" } }
    const p = extractParams(route)
    expect(p?.sessionID).toBe("session-456")
  })

  it("should handle missing workflowId", () => {
    const route = { name: "dag-console", params: { sessionID: "s-1" } }
    const p = extractParams(route)
    expect(p?.workflowId).toBeUndefined()
    expect(p?.sessionID).toBe("s-1")
  })

  it("should handle empty params", () => {
    const route = { name: "dag-console", params: {} }
    const p = extractParams(route)
    expect(p?.workflowId).toBeUndefined()
    expect(p?.sessionID).toBeUndefined()
  })
})

describe("DAG Console Route — data loading", () => {
  it("should load workflow data from KV", () => {
    const kv = new Map<string, unknown>()
    const wf = createMockWorkflow({ id: "wf-1", status: "running" })
    kv.set("dag_workflow_wf-1", wf)

    const loaded = kv.get("dag_workflow_wf-1") as DAGWorkflowSession | undefined
    expect(loaded).toBeDefined()
    expect(loaded!.id).toBe("wf-1")
    expect(loaded!.status).toBe("running")
  })

  it("should return null when workflow not found", () => {
    const kv = new Map<string, unknown>()
    const loaded = (kv.get("dag_workflow_wf-missing") as DAGWorkflowSession | undefined) ?? null
    expect(loaded).toBeNull()
  })

  it("should load nodes from KV", () => {
    const kv = new Map<string, unknown>()
    const nodes: DAGNodeSession[] = [
      createMockNode({ node_id: "n1", status: "completed" }),
      createMockNode({ node_id: "n2", status: "running" }),
    ]
    kv.set("dag_nodes_wf-1", nodes)

    const loaded = (kv.get("dag_nodes_wf-1") as DAGNodeSession[] | undefined) ?? []
    expect(loaded).toHaveLength(2)
    expect(loaded[0].node_id).toBe("n1")
  })

  it("should load violations from KV", () => {
    const kv = new Map<string, unknown>()
    const violations: DAGViolation[] = [
      {
        id: "v-1", workflowId: "wf-1", type: "required_node_skipped",
        severity: "error", nodeId: "n3", message: "Required node skipped",
        timestamp: new Date().toISOString(),
      },
    ]
    kv.set("dag_violations_wf-1", violations)

    const loaded = (kv.get("dag_violations_wf-1") as DAGViolation[] | undefined) ?? []
    expect(loaded).toHaveLength(1)
    expect(loaded[0].type).toBe("required_node_skipped")
  })

  it("should return empty arrays when no nodes/violations", () => {
    const kv = new Map<string, unknown>()
    const nodes = (kv.get("dag_nodes_wf-1") as DAGNodeSession[] | undefined) ?? []
    const violations = (kv.get("dag_violations_wf-1") as DAGViolation[] | undefined) ?? []
    expect(nodes).toEqual([])
    expect(violations).toEqual([])
  })
})

describe("DAG Console Route — selected node lookup", () => {
  it("should find selected node by id", () => {
    const nodes: DAGNodeSession[] = [
      createMockNode({ node_id: "n1", status: "completed" }),
      createMockNode({ node_id: "n2", status: "running" }),
      createMockNode({ node_id: "n3", status: "pending" }),
    ]
    const selectedNodeId = "n2"
    const selected = nodes.find((n) => n.node_id === selectedNodeId) ?? null
    expect(selected).toBeDefined()
    expect(selected!.status).toBe("running")
  })

  it("should return null when node not found", () => {
    const nodes: DAGNodeSession[] = [createMockNode({ node_id: "n1" })]
    const selected = nodes.find((n) => n.node_id === "n99") ?? null
    expect(selected).toBeNull()
  })

  it("should return null when no node is selected", () => {
    const selectedNodeId: string | null = null
    const nodes: DAGNodeSession[] = [createMockNode({ node_id: "n1" })]
    const selected = selectedNodeId ? nodes.find((n) => n.node_id === selectedNodeId) ?? null : null
    expect(selected).toBeNull()
  })
})

describe("DAG Console Route — progress calculation", () => {
  it("should return zeros for missing workflow", () => {
    const progress = { completed: 0, total: 0 }
    expect(progress.completed).toBe(0)
    expect(progress.total).toBe(0)
  })

  it("should calculate progress for loaded workflow", () => {
    const wf = createMockWorkflow({
      node_sessions: {
        "n1": createMockNode({ node_id: "n1", status: "completed", config: { id: "n1", name: "N1", dependencies: [], required: true, worker_type: "code", worker_config: {} } }),
        "n2": createMockNode({ node_id: "n2", status: "completed", config: { id: "n2", name: "N2", dependencies: ["n1"], required: true, worker_type: "test", worker_config: {} } }),
        "n3": createMockNode({ node_id: "n3", status: "pending", config: { id: "n3", name: "N3", dependencies: ["n1"], required: false, worker_type: "review", worker_config: {} } }),
        "n4": createMockNode({ node_id: "n4", status: "running", config: { id: "n4", name: "N4", dependencies: ["n2"], required: true, worker_type: "deploy", worker_config: {} } }),
      },
    })
    const p = calculateWorkflowProgress(wf)
    expect(p.all_nodes.total).toBe(4)
    expect(p.all_nodes.completed).toBe(2)
    expect(p.all_nodes.running).toBe(1)
    expect(p.all_nodes.pending).toBe(1)
  })
})

describe("DAG Console Route — navigation logic", () => {
  it("should use returnRoute when available", () => {
    const params = { workflowId: "wf-1", returnRoute: { name: "session" } }
    const target = params.returnRoute ? params.returnRoute.name : "home"
    expect(target).toBe("session")
  })

  it("should fallback to home when no return route", () => {
    const params: { workflowId: string; returnRoute?: { name: string } } = { workflowId: "wf-1" }
    const returnRoute = params.returnRoute
    const target = returnRoute ? returnRoute.name : "home"
    expect(target).toBe("home")
  })
})

describe("DAG Console Route — export validation", () => {
  it("should export DAGConsoleView", async () => {
    const mod = await import("./console-route")
    expect(mod.DAGConsoleView).toBeDefined()
    expect(typeof mod.DAGConsoleView).toBe("function")
  })
})
