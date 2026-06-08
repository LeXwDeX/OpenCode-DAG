/**
 * WP4 data.ts hooks 测试
 *
 * data.ts 已从 WP3 mock 升级为 SDK（client.dag.*）只读拉取 + 事件总线实时刷新。
 * 测试覆盖：
 * - mapNode / mapWorkflow: SDK→领域类型映射（数字联合收敛、node_sessions 构建、violations 置空）
 * - useWorkflowList / useWorkflow / useNodes: 通过 fake client 异步加载后填充 signal
 * - useViolations: 无 server 路由，恒返回空集合
 */
import { describe, it, expect } from "bun:test"
import { createRoot } from "solid-js"
import {
  mapNode,
  mapWorkflow,
  mapViolation,
  filterWorkflows,
  nextIndex,
  pauseWorkflow,
  resumeWorkflow,
  useWorkflowList,
  useWorkflowDetail,
  useViolations,
} from "./data"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { DAGWorkflowSession } from "@/dag/session/types"

// ── SDK 样本数据（含 number|"NaN"|"Infinity" 等序列化产物） ──────────────────

const sdkNode = {
  node_id: "n1",
  workflow_id: "wf-1",
  config: { id: "n1", name: "收集" },
  status: "failed" as const,
  output: null,
  error_info: { type: "TimeoutError", message: "node timed out", retryable: true },
  retry_count: 0,
  max_retries: 3,
  timeout_ms: 60_000,
  required_nodes: ["dep0"],
  dependencies: ["dep0"],
  metadata: { chat_session_id: "chat-n1" },
  start_time: 1000,
  completed_at: "1500",
  end_time: 1500,
  duration_ms: 500,
  parent_node: null,
  created_at: 1000,
  updated_at: 1500,
  logs: ["line 1", "line 2"],
  metrics: { cpu_percent: 12, memory_mb: 256 },
}

const sdkWorkflow = {
  id: "wf-1",
  chat_session_id: "chat-1",
  config: { name: "Build Flow", nodes: [] },
  status: "running" as const,
  metadata: {},
  start_time: 1000,
  end_time: "Infinity" as const, // 非有限值 → null
  current_node: "n1",
  created_at: 1000,
  updated_at: 2000,
  completed_at: "NaN" as const, // 非有限值 → null
  duration_ms: "NaN" as const,
}

// ── fake client / event ────────────────────────────────────────────────────

function fakeClient(overrides?: {
  list?: unknown[]
  detail?: { workflow: unknown; nodes: unknown[] } | null
  violations?: unknown[]
}): TuiPluginApi["client"] {
  return {
    dag: {
      listWorkflows: async () => ({ data: overrides?.list ?? [sdkWorkflow] }),
      getWorkflow: async () => ({
        data:
          overrides?.detail === undefined
            ? { workflow: sdkWorkflow, nodes: [sdkNode] }
            : overrides.detail,
      }),
      getViolations: async () => ({ data: overrides?.violations ?? [] }),
    },
  } as unknown as TuiPluginApi["client"]
}

const fakeEvent = { on: () => () => {} } as unknown as TuiPluginApi["event"]

/** 在 reactive root 内运行 fn，等待 createEffect 调度 + fake client 异步 resolve */
async function withRoot<T>(fn: () => T): Promise<{ value: T; dispose: () => void }> {
  let value!: T
  let dispose!: () => void
  createRoot((d) => {
    dispose = d
    value = fn()
  })
  await new Promise<void>((r) => setTimeout(r, 20))
  return { value, dispose }
}

// ── mapping ─────────────────────────────────────────────────────────────────

describe("WP4 data.ts — mapNode", () => {
  it("maps SDK node to domain node session", () => {
    const n = mapNode(sdkNode)
    expect(n.node_id).toBe("n1")
    expect(n.status).toBe("failed")
    expect(n.dependencies).toEqual(["dep0"])
    expect(n.completed_at).toBe("1500")
    expect(n.duration_ms).toBe(500)
  })

  it("preserves error_info, metrics and logs (B2 regression)", () => {
    const n = mapNode(sdkNode)
    expect(n.error_info).toEqual({ type: "TimeoutError", message: "node timed out", retryable: true })
    expect(n.metrics).toEqual({ cpu_percent: 12, memory_mb: 256 })
    expect(n.logs).toEqual(["line 1", "line 2"])
  })

  it("omits error_info/metrics when absent and defaults logs to []", () => {
    const { error_info, metrics, logs, ...bare } = sdkNode
    const n = mapNode(bare)
    expect(n.error_info).toBeUndefined()
    expect(n.metrics).toBeUndefined()
    expect(n.logs).toEqual([])
  })
})

describe("WP4 data.ts — mapViolation", () => {
  it("maps SDK violation and drops empty optional fields", () => {
    const v = mapViolation({
      id: "v-1",
      workflowId: "wf-1",
      type: "timeout_exceeded",
      severity: "critical",
      message: "boom",
      timestamp: "2026-01-01T00:00:00.000Z",
    })
    expect(v.id).toBe("v-1")
    expect(v.nodeId).toBeUndefined()
    expect(v.details).toBeUndefined()
    expect(v.severity).toBe("critical")
  })
})

describe("WP4 data.ts — mapWorkflow", () => {
  it("coerces non-finite numeric unions to null and builds node_sessions", () => {
    const wf = mapWorkflow(sdkWorkflow, [mapNode(sdkNode)])
    expect(wf.id).toBe("wf-1")
    expect(wf.status).toBe("running")
    expect(wf.start_time).toBe(1000)
    expect(wf.end_time).toBeNull()
    expect(wf.completed_at).toBeNull()
    expect(wf.duration_ms).toBeNull()
    expect(wf.violations).toEqual([])
    expect(Object.keys(wf.node_sessions)).toEqual(["n1"])
    expect(wf.node_sessions["n1"]!.node_id).toBe("n1")
  })

  it("defaults node_sessions to empty when no nodes given", () => {
    const wf = mapWorkflow(sdkWorkflow)
    expect(wf.node_sessions).toEqual({})
  })
})

// ── hooks ─────────────────────────────────────────────────────────────────

describe("WP4 data.ts — useWorkflowList", () => {
  it("loads workflows from the SDK client", async () => {
    const { value, dispose } = await withRoot(() =>
      useWorkflowList({ client: fakeClient(), event: fakeEvent, session_id: () => "session-123" }),
    )
    const list = value.list()
    expect(Array.isArray(list)).toBe(true)
    expect(list.length).toBe(1)
    expect(list[0]!.id).toBe("wf-1")
    expect(list[0]!.status).toBe("running")
    dispose()
  })
})

describe("WP4 data.ts — useWorkflowDetail", () => {
  it("loads a single workflow with node_sessions and nodes from one fetch", async () => {
    const { value, dispose } = await withRoot(() =>
      useWorkflowDetail({ client: fakeClient(), event: fakeEvent, workflowId: () => "wf-1" }),
    )
    const wf = value.workflow()
    expect(wf).not.toBeNull()
    expect(wf!.id).toBe("wf-1")
    expect(Object.keys(wf!.node_sessions)).toEqual(["n1"])
    expect(value.nodes().length).toBe(1)
    expect(value.nodes()[0]!.node_id).toBe("n1")
    expect(value.error()).toBeNull()
    dispose()
  })

  it("issues exactly one getWorkflow call per load (dedupe)", async () => {
    let calls = 0
    const client = {
      dag: {
        listWorkflows: async () => ({ data: [sdkWorkflow] }),
        getWorkflow: async () => {
          calls++
          return { data: { workflow: sdkWorkflow, nodes: [sdkNode] } }
        },
        getViolations: async () => ({ data: [] }),
      },
    } as unknown as TuiPluginApi["client"]
    const { dispose } = await withRoot(() =>
      useWorkflowDetail({ client, event: fakeEvent, workflowId: () => "wf-1" }),
    )
    expect(calls).toBe(1)
    dispose()
  })

  it("returns null/[] when workflowId is undefined", async () => {
    const { value, dispose } = await withRoot(() =>
      useWorkflowDetail({ client: fakeClient(), event: fakeEvent, workflowId: () => undefined }),
    )
    expect(value.workflow()).toBeNull()
    expect(value.nodes()).toEqual([])
    dispose()
  })

  it("surfaces an error message when the client rejects", async () => {
    const client = {
      dag: {
        listWorkflows: async () => ({ data: [] }),
        getWorkflow: async () => {
          throw new Error("network down")
        },
        getViolations: async () => ({ data: [] }),
      },
    } as unknown as TuiPluginApi["client"]
    const { value, dispose } = await withRoot(() =>
      useWorkflowDetail({ client, event: fakeEvent, workflowId: () => "wf-1" }),
    )
    expect(value.error()).toBe("network down")
    expect(value.workflow()).toBeNull()
    dispose()
  })
})

describe("WP4 data.ts — useViolations", () => {
  it("loads violations from the SDK client", async () => {
    const sampleViolation = {
      id: "v-1",
      workflowId: "wf-1",
      nodeId: "n1",
      type: "required_node_failed",
      severity: "error",
      message: "Node n1 failed",
      timestamp: "2026-01-01T00:00:00.000Z",
    }
    const { value, dispose } = await withRoot(() =>
      useViolations({
        client: fakeClient({ violations: [sampleViolation] }),
        event: fakeEvent,
        workflowId: () => "wf-1",
      }),
    )
    const v = value.violations()
    expect(Array.isArray(v)).toBe(true)
    expect(v.length).toBe(1)
    expect(v[0]!.id).toBe("v-1")
    expect(v[0]!.type).toBe("required_node_failed")
    dispose()
  })

  it("returns [] when workflowId is undefined", async () => {
    const { value, dispose } = await withRoot(() =>
      useViolations({
        client: fakeClient({ violations: [] }),
        event: fakeEvent,
        workflowId: () => undefined,
      }),
    )
    expect(value.violations()).toEqual([])
    dispose()
  })
})

describe("WP1.1 data.ts — mutation wrappers", () => {
  it("pauseWorkflow calls client.dag.pause with workflowId", async () => {
    const calls: unknown[] = []
    const client = {
      dag: {
        pause: async (input: unknown) => {
          calls.push(input)
          return { data: { ok: true } }
        },
      },
    } as unknown as TuiPluginApi["client"]

    await pauseWorkflow(client, "wf-1")

    expect(calls).toEqual([{ workflowId: "wf-1" }])
  })

  it("resumeWorkflow calls client.dag.resume with workflowId", async () => {
    const calls: unknown[] = []
    const client = {
      dag: {
        resume: async (input: unknown) => {
          calls.push(input)
          return { data: { ok: true } }
        },
      },
    } as unknown as TuiPluginApi["client"]

    await resumeWorkflow(client, "wf-1")

    expect(calls).toEqual([{ workflowId: "wf-1" }])
  })
})

// ── pure helpers: filterWorkflows / nextIndex ────────────────────────────────

function wf(id: string, status: DAGWorkflowSession["status"], name?: string): DAGWorkflowSession {
  return { id, status, config: name ? { name } : undefined } as unknown as DAGWorkflowSession
}

describe("WP4 data.ts — filterWorkflows", () => {
  const list = [
    wf("a", "running", "Build Flow"),
    wf("b", "completed", "Deploy"),
    wf("c", "running", "Test Suite"),
    wf("orphan-x", "failed"), // no config.name → falls back to id
  ]

  it("returns all when no filter and empty search", () => {
    expect(filterWorkflows(list, null, "").map((w) => w.id)).toEqual(["a", "b", "c", "orphan-x"])
  })

  it("filters by status", () => {
    expect(filterWorkflows(list, "running", "").map((w) => w.id)).toEqual(["a", "c"])
  })

  it("filters by name substring, case-insensitive", () => {
    expect(filterWorkflows(list, null, "deploy").map((w) => w.id)).toEqual(["b"])
  })

  it("falls back to id when config.name is absent", () => {
    expect(filterWorkflows(list, null, "orphan").map((w) => w.id)).toEqual(["orphan-x"])
  })

  it("combines status + search (AND)", () => {
    expect(filterWorkflows(list, "running", "test").map((w) => w.id)).toEqual(["c"])
  })

  it("trims whitespace-only search to no-op", () => {
    expect(filterWorkflows(list, null, "   ").map((w) => w.id)).toEqual(["a", "b", "c", "orphan-x"])
  })
})

describe("WP4 data.ts — nextIndex", () => {
  it("returns -1 for empty list", () => {
    expect(nextIndex(0, -1, 1)).toBe(-1)
  })

  it("no selection + forward → first item", () => {
    expect(nextIndex(3, -1, 1)).toBe(0)
  })

  it("no selection + backward → last item", () => {
    expect(nextIndex(3, -1, -1)).toBe(2)
  })

  it("moves forward and clamps at end", () => {
    expect(nextIndex(3, 1, 1)).toBe(2)
    expect(nextIndex(3, 2, 1)).toBe(2)
  })

  it("moves backward and clamps at start", () => {
    expect(nextIndex(3, 1, -1)).toBe(0)
    expect(nextIndex(3, 0, -1)).toBe(0)
  })
})
