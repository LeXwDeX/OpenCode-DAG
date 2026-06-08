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
import { createRoot, createSignal } from "solid-js"
import {
  mapNode,
  mapNodeLog,
  mapWorkflow,
  mapWorkflowHistory,
  mapViolation,
  mapTimeline,
  mapGraphStats,
  filterWorkflows,
  nextIndex,
  pauseWorkflow,
  resumeWorkflow,
  cancelWorkflow,
  replanWorkflow,
  createWorkflow,
  useWorkflowList,
  useWorkflowDetail,
  useViolations,
  useNodeLogs,
  useWorkflowHistory,
  useNodeAskMain,
  useWorkflowTimeline,
  useWorkflowStats,
  useNodeToolCounts,
  createPolledResource,
} from "./data"
import { countToolParts } from "./live-ticker"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { DAGNodeSession, DAGWorkflowSession } from "@/dag/session/types"

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

const sdkHistory = {
  history_id: "hist-1",
  workflow_id: "wf-1",
  chat_session_id: "chat-1",
  action: "replan",
  old_state: { nodes: 1 },
  new_state: { nodes: 2 },
  change_details: { added: ["n2"] },
  changed_by: "main",
  created_at: "2026-01-01T00:00:00.000Z",
}

const sdkNodeLog = {
  log_id: "log-1",
  node_id: "n1",
  workflow_id: "wf-1",
  chat_session_id: "chat-1",
  log_level: "info",
  log_message: "started execution",
  log_data: { step: 1 },
  execution_phase: "execute",
  created_at: "2026-01-01T00:00:01.000Z",
}

// ── fake client / event ────────────────────────────────────────────────────

function fakeClient(overrides?: {
  list?: unknown[]
  detail?: { workflow: unknown; nodes: unknown[] } | null
  violations?: unknown[]
  history?: unknown[]
  logs?: unknown[]
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
      getWorkflowHistory: async () => ({ data: overrides?.history ?? [sdkHistory] }),
      getNodeLogs: async () => ({ data: overrides?.logs ?? [sdkNodeLog] }),
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

describe("WP4 data.ts — observation mappers", () => {
  it("maps workflow history rows without dropping JSON details", () => {
    const row = mapWorkflowHistory(sdkHistory)
    expect(row.history_id).toBe("hist-1")
    expect(row.action).toBe("replan")
    expect(row.changed_by).toBe("main")
    expect(row.change_details).toEqual({ added: ["n2"] })
  })

  it("maps node log rows without dropping structured log data", () => {
    const row = mapNodeLog(sdkNodeLog)
    expect(row.log_id).toBe("log-1")
    expect(row.log_level).toBe("info")
    expect(row.execution_phase).toBe("execute")
    expect(row.log_data).toEqual({ step: 1 })
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

describe("WP4 data.ts — useWorkflowHistory", () => {
  it("loads workflow history from the SDK client", async () => {
    const { value, dispose } = await withRoot(() =>
      useWorkflowHistory({ client: fakeClient(), event: fakeEvent, workflowId: () => "wf-1" }),
    )
    expect(value.history()).toHaveLength(1)
    expect(value.history()[0]!.history_id).toBe("hist-1")
    expect(value.error()).toBeNull()
    dispose()
  })

  it("returns [] when workflowId is undefined", async () => {
    const { value, dispose } = await withRoot(() =>
      useWorkflowHistory({ client: fakeClient(), event: fakeEvent, workflowId: () => undefined }),
    )
    expect(value.history()).toEqual([])
    expect(value.loading()).toBe(false)
    dispose()
  })

  it("surfaces an error message when history loading fails", async () => {
    const client = {
      dag: {
        getWorkflowHistory: async () => {
          throw new Error("history unavailable")
        },
      },
    } as unknown as TuiPluginApi["client"]
    const { value, dispose } = await withRoot(() =>
      useWorkflowHistory({ client, event: fakeEvent, workflowId: () => "wf-1" }),
    )
    expect(value.error()).toBe("history unavailable")
    dispose()
  })
})

describe("WP4 data.ts — useNodeLogs", () => {
  it("loads node logs from the SDK client", async () => {
    const { value, dispose } = await withRoot(() =>
      useNodeLogs({ client: fakeClient(), event: fakeEvent, nodeId: () => "n1" }),
    )
    expect(value.logs()).toHaveLength(1)
    expect(value.logs()[0]!.log_id).toBe("log-1")
    expect(value.error()).toBeNull()
    dispose()
  })

  it("returns [] when nodeId is null", async () => {
    const { value, dispose } = await withRoot(() =>
      useNodeLogs({ client: fakeClient(), event: fakeEvent, nodeId: () => null }),
    )
    expect(value.logs()).toEqual([])
    expect(value.loading()).toBe(false)
    dispose()
  })

  it("surfaces an error message when logs loading fails", async () => {
    const client = {
      dag: {
        getNodeLogs: async () => {
          throw new Error("logs unavailable")
        },
      },
    } as unknown as TuiPluginApi["client"]
    const { value, dispose } = await withRoot(() =>
      useNodeLogs({ client, event: fakeEvent, nodeId: () => "n1" }),
    )
    expect(value.error()).toBe("logs unavailable")
    dispose()
  })
})

describe("WP1.1 data.ts — mutation wrappers", () => {
  it("pauseWorkflow calls client.dagMutation.pause with workflowId", async () => {
    const calls: unknown[] = []
    const client = {
      dagMutation: {
        pause: async (input: unknown) => {
          calls.push(input)
          return { data: { ok: true } }
        },
      },
    } as unknown as TuiPluginApi["client"]

    await pauseWorkflow(client, "wf-1")

    expect(calls).toEqual([{ workflowId: "wf-1" }])
  })

  it("resumeWorkflow calls client.dagMutation.resume with workflowId", async () => {
    const calls: unknown[] = []
    const client = {
      dagMutation: {
        resume: async (input: unknown) => {
          calls.push(input)
          return { data: { ok: true } }
        },
      },
    } as unknown as TuiPluginApi["client"]

    await resumeWorkflow(client, "wf-1")

    expect(calls).toEqual([{ workflowId: "wf-1" }])
  })

  it("cancelWorkflow calls client.dagMutation.cancel with workflowId", async () => {
    const calls: unknown[] = []
    const client = {
      dagMutation: {
        cancel: async (input: unknown) => {
          calls.push(input)
          return { data: { status: "cancelled" } }
        },
      },
    } as unknown as TuiPluginApi["client"]

    await cancelWorkflow(client, "wf-1")

    expect(calls).toEqual([{ workflowId: "wf-1" }])
  })

  it("replanWorkflow calls client.dagMutation.replan with workflowId + body", async () => {
    const calls: unknown[] = []
    const client = {
      dagMutation: {
        replan: async (input: unknown) => {
          calls.push(input)
          return { data: { ok: true } }
        },
      },
    } as unknown as TuiPluginApi["client"]

    await replanWorkflow(client, "wf-1", { new_max_concurrency: 5, changed_by: "user" })

    expect(calls).toEqual([
      { workflowId: "wf-1", dagReplanPatchBody: { new_max_concurrency: 5, changed_by: "user" } },
    ])
  })

  it("createWorkflow calls client.dagMutation.create with body", async () => {
    const calls: unknown[] = []
    const client = {
      dagMutation: {
        create: async (input: unknown) => {
          calls.push(input)
          return { data: { workflowId: "wf-new", nodeCount: 2, status: "pending" } }
        },
      },
    } as unknown as TuiPluginApi["client"]

    await createWorkflow(client, { name: "Flow", chatSessionId: "sess-1", config: { nodes: [] } })

    expect(calls).toEqual([
      { dagCreateWorkflowBody: { name: "Flow", chatSessionId: "sess-1", config: { nodes: [] } } },
    ])
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

// ── useNodeAskMain ──────────────────────────────────────────────────────────

function capturingEvent(): {
  event: TuiPluginApi["event"]
  fire: (type: string, properties: unknown) => void
} {
  const handlers: Record<string, (e: { properties: unknown }) => void> = {}
  return {
    event: {
      on: (type: string, handler: (e: { properties: unknown }) => void) => {
        handlers[type] = handler
        return () => {
          delete handlers[type]
        }
      },
    } as unknown as TuiPluginApi["event"],
    fire: (type, properties) => handlers[type]?.({ properties }),
  }
}

// ── WP-TUI-4: Timeline / GraphStats mappers & hooks ────────────────────────

const sdkTimeline = {
  workflowId: "wf-1",
  startTime: 1_700_000_000_000,
  endTime: "Infinity" as const, // non-finite → null
  events: [
    { type: "node_start" as const, nodeId: "n1", timestamp: 1_700_000_001_000, duration: 1500 },
    { type: "node_complete" as const, nodeId: "n1", timestamp: 1_700_000_002_500, duration: 1500 },
    {
      type: "node_failed" as const,
      nodeId: "n2",
      timestamp: 1_700_000_003_000,
      duration: "NaN" as const, // non-finite → null
      metadata: { reason: "timeout" },
    },
  ],
  totalDuration: 3000,
  nodeExecutionTimes: {
    n1: {
      nodeId: "n1",
      nodeName: "Collect",
      startTime: 1_700_000_001_000,
      endTime: 1_700_000_002_500,
      duration: 1500,
      status: "completed" as const,
    },
    n2: {
      nodeId: "n2",
      nodeName: "Build",
      startTime: 1_700_000_002_000,
      endTime: "Infinity" as const, // non-finite → num() fallback 0
      duration: "NaN" as const, // non-finite → num() fallback 0
      status: "failed" as const,
    },
  },
}

const sdkStats = {
  totalNodes: 5,
  totalEdges: 4,
  criticalPathLength: 12_000,
  parallelismDegree: 3,
  estimatedCompletionTime: "Infinity" as const, // non-finite → 0
}

describe("WP-TUI-4 data.ts — mapTimeline", () => {
  it("converges finite/non-finite numbers and preserves event metadata", () => {
    const t = mapTimeline(sdkTimeline)
    expect(t.workflowId).toBe("wf-1")
    expect(t.startTime).toBe(1_700_000_000_000)
    expect(t.endTime).toBeNull() // Infinity → null
    expect(t.totalDuration).toBe(3000)
    expect(t.events).toHaveLength(3)
    expect(t.events[0]!.duration).toBe(1500)
    expect(t.events[2]!.duration).toBeNull() // NaN → null
    expect(t.events[2]!.metadata).toEqual({ reason: "timeout" })
  })

  it("converges SdkNumber in nodeExecutionTimes (Infinity/NaN → num() fallback)", () => {
    const t = mapTimeline(sdkTimeline)
    const n2 = t.nodeExecutionTimes["n2"]!
    expect(n2.nodeId).toBe("n2")
    expect(n2.nodeName).toBe("Build")
    expect(n2.status).toBe("failed")
    expect(n2.endTime).toBe(0) // Infinity → fallback 0
    expect(n2.duration).toBe(0) // NaN → fallback 0
  })

  it("handles empty events and missing nodeExecutionTimes", () => {
    const t = mapTimeline({
      workflowId: "wf-empty",
      startTime: 1000,
      endTime: null,
      events: [],
      totalDuration: 0,
    })
    expect(t.events).toEqual([])
    expect(t.nodeExecutionTimes).toEqual({})
  })
})

describe("WP-TUI-4 data.ts — mapGraphStats", () => {
  it("converges SdkNumber → number (Infinity fallback to 0)", () => {
    const s = mapGraphStats(sdkStats)
    expect(s.totalNodes).toBe(5)
    expect(s.totalEdges).toBe(4)
    expect(s.criticalPathLength).toBe(12_000)
    expect(s.parallelismDegree).toBe(3)
    expect(s.estimatedCompletionTime).toBe(0) // Infinity → 0
  })

  it("treats null/undefined fields as 0", () => {
    const s = mapGraphStats({
      totalNodes: null as unknown as number,
      totalEdges: undefined as unknown as number,
      criticalPathLength: "NaN",
      parallelismDegree: 1,
      estimatedCompletionTime: 500,
    })
    expect(s.totalNodes).toBe(0)
    expect(s.totalEdges).toBe(0)
    expect(s.criticalPathLength).toBe(0)
    expect(s.parallelismDegree).toBe(1)
    expect(s.estimatedCompletionTime).toBe(500)
  })
})

function fakeTimelineClient(overrides?: {
  timeline?: unknown
  stats?: unknown
  error?: Error
}): TuiPluginApi["client"] {
  return {
    dag: {
      getTimeline: async () => {
        if (overrides?.error) throw overrides.error
        return { data: overrides?.timeline ?? sdkTimeline }
      },
      getStats: async () => {
        if (overrides?.error) throw overrides.error
        return { data: overrides?.stats ?? sdkStats }
      },
    },
  } as unknown as TuiPluginApi["client"]
}

describe("WP-TUI-4 data.ts — useWorkflowTimeline", () => {
  it("returns null initially when workflowId is undefined", async () => {
    const { value, dispose } = await withRoot(() =>
      useWorkflowTimeline({
        client: fakeTimelineClient(),
        event: fakeEvent,
        workflowId: () => undefined,
      }),
    )
    expect(value.timeline()).toBeNull()
    expect(value.loading()).toBe(false)
    expect(value.error()).toBeNull()
    dispose()
  })

  it("loads timeline from the SDK client", async () => {
    const { value, dispose } = await withRoot(() =>
      useWorkflowTimeline({
        client: fakeTimelineClient(),
        event: fakeEvent,
        workflowId: () => "wf-1",
      }),
    )
    const tl = value.timeline()
    expect(tl).not.toBeNull()
    expect(tl!.workflowId).toBe("wf-1")
    expect(tl!.events).toHaveLength(3)
    expect(tl!.nodeExecutionTimes["n1"]!.nodeName).toBe("Collect")
    expect(value.error()).toBeNull()
    dispose()
  })

  it("surfaces an error message when the client rejects", async () => {
    const { value, dispose } = await withRoot(() =>
      useWorkflowTimeline({
        client: fakeTimelineClient({ error: new Error("timeline unavailable") }),
        event: fakeEvent,
        workflowId: () => "wf-1",
      }),
    )
    expect(value.error()).toBe("timeline unavailable")
    expect(value.timeline()).toBeNull()
    dispose()
  })

  it("refetches on dag.node.updated matching workflowID", async () => {
    let calls = 0
    const client = {
      dag: {
        getTimeline: async () => {
          calls++
          return { data: sdkTimeline }
        },
      },
    } as unknown as TuiPluginApi["client"]
    const { fire, event } = capturingEvent()
    const { value, dispose } = await withRoot(() =>
      useWorkflowTimeline({ client, event, workflowId: () => "wf-1" }),
    )
    expect(calls).toBe(1) // initial load
    fire("dag.node.updated", { workflowID: "wf-1" })
    await new Promise<void>((r) => setTimeout(r, 20))
    expect(calls).toBe(2)
    dispose()
  })

  it("ignores dag.node.updated for non-matching workflowID", async () => {
    let calls = 0
    const client = {
      dag: {
        getTimeline: async () => {
          calls++
          return { data: sdkTimeline }
        },
      },
    } as unknown as TuiPluginApi["client"]
    const { fire, event } = capturingEvent()
    const { dispose } = await withRoot(() =>
      useWorkflowTimeline({ client, event, workflowId: () => "wf-1" }),
    )
    expect(calls).toBe(1)
    fire("dag.node.updated", { workflowID: "other-wf" })
    await new Promise<void>((r) => setTimeout(r, 20))
    expect(calls).toBe(1)
    dispose()
  })
})

describe("WP-TUI-4 data.ts — useWorkflowStats", () => {
  it("returns null when workflowId is undefined", async () => {
    const { value, dispose } = await withRoot(() =>
      useWorkflowStats({
        client: fakeTimelineClient(),
        event: fakeEvent,
        workflowId: () => undefined,
      }),
    )
    expect(value.stats()).toBeNull()
    expect(value.loading()).toBe(false)
    dispose()
  })

  it("loads stats from the SDK client", async () => {
    const { value, dispose } = await withRoot(() =>
      useWorkflowStats({
        client: fakeTimelineClient(),
        event: fakeEvent,
        workflowId: () => "wf-1",
      }),
    )
    const s = value.stats()
    expect(s).not.toBeNull()
    expect(s!.totalNodes).toBe(5)
    expect(s!.parallelismDegree).toBe(3)
    expect(value.error()).toBeNull()
    dispose()
  })

  it("surfaces an error message when the client rejects", async () => {
    const { value, dispose } = await withRoot(() =>
      useWorkflowStats({
        client: fakeTimelineClient({ error: new Error("stats unavailable") }),
        event: fakeEvent,
        workflowId: () => "wf-1",
      }),
    )
    expect(value.error()).toBe("stats unavailable")
    expect(value.stats()).toBeNull()
    dispose()
  })

  it("refetches on dag.workflow.updated matching workflowID", async () => {
    let calls = 0
    const client = {
      dag: {
        getStats: async () => {
          calls++
          return { data: sdkStats }
        },
      },
    } as unknown as TuiPluginApi["client"]
    const { fire, event } = capturingEvent()
    const { dispose } = await withRoot(() =>
      useWorkflowStats({ client, event, workflowId: () => "wf-1" }),
    )
    expect(calls).toBe(1)
    fire("dag.workflow.updated", { workflowID: "wf-1" })
    await new Promise<void>((r) => setTimeout(r, 20))
    expect(calls).toBe(2)
    dispose()
  })
})

describe("WP-TUI-2 data.ts — useNodeAskMain", () => {
  it("returns null initially", async () => {
    const { fire, event } = capturingEvent()
    const { value, dispose } = await withRoot(() =>
      useNodeAskMain({ event, workflowId: () => "wf-1" }),
    )
    expect(value.lastQuestion()).toBeNull()
    dispose()
  })

  it("captures dag.node.ask_main when workflowID matches current workflow", async () => {
    const { fire, event } = capturingEvent()
    const { value, dispose } = await withRoot(() =>
      useNodeAskMain({ event, workflowId: () => "wf-1" }),
    )
    fire("dag.node.ask_main", {
      workflowID: "wf-1",
      nodeID: "n-ask",
      chatSessionID: "chat-ask",
      question: "Need confirmation on branch",
      context: "node n-ask needs user input",
      timestamp: 1700000000000,
    })
    const q = value.lastQuestion()
    expect(q).not.toBeNull()
    expect(q!.nodeID).toBe("n-ask")
    expect(q!.chatSessionID).toBe("chat-ask")
    expect(q!.question).toBe("Need confirmation on branch")
    expect(q!.context).toBe("node n-ask needs user input")
    expect(q!.timestamp).toBe(1700000000000)
    dispose()
  })

  it("ignores dag.node.ask_main when workflowID does NOT match", async () => {
    const { fire, event } = capturingEvent()
    const { value, dispose } = await withRoot(() =>
      useNodeAskMain({ event, workflowId: () => "wf-1" }),
    )
    fire("dag.node.ask_main", {
      workflowID: "wf-other",
      nodeID: "n-ask",
      question: "Unrelated question",
      timestamp: 1700000000000,
    })
    expect(value.lastQuestion()).toBeNull()
    dispose()
  })

  it("clear() resets lastQuestion to null", async () => {
    const { fire, event } = capturingEvent()
    const { value, dispose } = await withRoot(() =>
      useNodeAskMain({ event, workflowId: () => "wf-1" }),
    )
    fire("dag.node.ask_main", {
      workflowID: "wf-1",
      nodeID: "n-ask",
      question: "Are you sure?",
      timestamp: 1700000000000,
    })
    expect(value.lastQuestion()).not.toBeNull()
    value.clear()
    expect(value.lastQuestion()).toBeNull()
    dispose()
  })
})

// ── WP-TUI-5: countToolParts ─────────────────────────────────────────────────

describe("WP-TUI-5 live-ticker.tsx — countToolParts", () => {
  it("returns 0 for empty array", () => {
    expect(countToolParts([])).toBe(0)
  })

  it("counts only tool parts with state=completed, ignoring other types and states", () => {
    const parts = [
      { type: "text", state: "completed" },
      { type: "tool", state: "completed" },
      { type: "tool", state: "running" },
      { type: "tool", state: "completed" },
    ]
    expect(countToolParts(parts)).toBe(2)
  })

  it("returns 0 when no tool parts are present", () => {
    const parts = [
      { type: "text", state: "completed" },
      { type: "reasoning", state: "completed" },
    ]
    expect(countToolParts(parts)).toBe(0)
  })

  it("returns 0 when all tool parts are non-completed", () => {
    const parts = [
      { type: "tool", state: "running" },
      { type: "tool", state: "pending" },
      { type: "tool" },
    ]
    expect(countToolParts(parts)).toBe(0)
  })
})

// ── WP-TUI-5: useNodeToolCounts ──────────────────────────────────────────────

describe("WP-TUI-5 data.ts — useNodeToolCounts", () => {
  it("returns empty record initially", async () => {
    const { fire, event } = capturingEvent()
    const { value, dispose } = await withRoot(() =>
      useNodeToolCounts({ event, nodes: () => [] }),
    )
    expect(value()).toEqual({})
    dispose()
  })

  it("increments count for matching session ID on tool completed events", async () => {
    const { fire, event } = capturingEvent()
    const nodes = (): DAGNodeSession[] =>
      [
        { node_id: "n1", metadata: { chat_session_id: "chat-n1" } },
        { node_id: "n2", metadata: { chat_session_id: "chat-n2" } },
      ] as unknown as DAGNodeSession[]
    const { value, dispose } = await withRoot(() =>
      useNodeToolCounts({ event, nodes }),
    )
    fire("message.part.updated", {
      sessionID: "chat-n1",
      part: { type: "tool", state: "completed", tool: "bash" },
    })
    fire("message.part.updated", {
      sessionID: "chat-n1",
      part: { type: "tool", state: "completed", tool: "grep" },
    })
    fire("message.part.updated", {
      sessionID: "chat-n2",
      part: { type: "tool", state: "completed", tool: "read" },
    })
    const counts = value()
    expect(counts["chat-n1"]).toBe(2)
    expect(counts["chat-n2"]).toBe(1)
    dispose()
  })

  it("ignores events for session IDs not in nodes list", async () => {
    const { fire, event } = capturingEvent()
    const nodes = (): DAGNodeSession[] =>
      [
        { node_id: "n1", metadata: { chat_session_id: "chat-n1" } },
      ] as unknown as DAGNodeSession[]
    const { value, dispose } = await withRoot(() =>
      useNodeToolCounts({ event, nodes }),
    )
    fire("message.part.updated", {
      sessionID: "unrelated-session",
      part: { type: "tool", state: "completed", tool: "bash" },
    })
    expect(value()).toEqual({})
    dispose()
  })

  it("ignores tool parts with non-completed state", async () => {
    const { fire, event } = capturingEvent()
    const nodes = (): DAGNodeSession[] =>
      [
        { node_id: "n1", metadata: { chat_session_id: "chat-n1" } },
      ] as unknown as DAGNodeSession[]
    const { value, dispose } = await withRoot(() =>
      useNodeToolCounts({ event, nodes }),
    )
    fire("message.part.updated", {
      sessionID: "chat-n1",
      part: { type: "tool", state: "running", tool: "bash" },
    })
    fire("message.part.updated", {
      sessionID: "chat-n1",
      part: { type: "text", state: "completed" },
    })
    expect(value()).toEqual({})
    dispose()
  })
})

// ── createPolledResource factory ──────────────────────────────────────────

describe("data.ts — createPolledResource", () => {
  it("fetches data and populates data/error/loading signals", async () => {
    const { value, dispose } = await withRoot(() =>
      createPolledResource({
        initial: [] as string[],
        fetch: () => Promise.resolve(["a", "b"]),
        params: () => "p1",
        skipWhen: (p) => !p,
        events: [],
        client: fakeClient(),
        event: fakeEvent,
      }),
    )
    expect(value.data()).toEqual(["a", "b"])
    expect(value.error()).toBeNull()
    expect(value.loading()).toBe(false)
    dispose()
  })

  it("resets to initial when skipWhen returns true", async () => {
    const { value, dispose } = await withRoot(() =>
      createPolledResource({
        initial: [] as string[],
        fetch: () => Promise.resolve(["a"]),
        params: () => undefined,
        skipWhen: (p) => !p,
        events: [],
        client: fakeClient(),
        event: fakeEvent,
      }),
    )
    expect(value.data()).toEqual([])
    expect(value.error()).toBeNull()
    expect(value.loading()).toBe(false)
    dispose()
  })

  it("surfaces an error message when fetch rejects", async () => {
    const { value, dispose } = await withRoot(() =>
      createPolledResource({
        initial: null as string | null,
        fetch: () => Promise.reject(new Error("network down")),
        params: () => "p1",
        events: [],
        client: fakeClient(),
        event: fakeEvent,
      }),
    )
    expect(value.error()).toBe("network down")
    expect(value.data()).toBeNull()
    dispose()
  })

  it("refresh() manually triggers a fetch", async () => {
    let calls = 0
    const { value, dispose } = await withRoot(() =>
      createPolledResource({
        initial: [] as number[],
        fetch: () => {
          calls++
          return Promise.resolve([calls])
        },
        params: () => "p1",
        events: [],
        client: fakeClient(),
        event: fakeEvent,
      }),
    )
    expect(calls).toBe(1)
    expect(value.data()).toEqual([1])
    value.refresh()
    await new Promise<void>((r) => setTimeout(r, 20))
    expect(calls).toBe(2)
    expect(value.data()).toEqual([2])
    dispose()
  })

  it("gen guard: fast params switch — old slow response does not overwrite new data", async () => {
    let resolveFirst: (v: string[]) => void
    let resolveSecond: (v: string[]) => void
    const first = new Promise<string[]>((r) => { resolveFirst = r })
    const second = new Promise<string[]>((r) => { resolveSecond = r })
    let callIndex = 0

    const { value, dispose } = await withRoot(() =>
      createPolledResource({
        initial: [] as string[],
        fetch: () => {
          callIndex++
          return callIndex === 1 ? first : second
        },
        params: () => "p1",
        skipWhen: (p) => !p,
        events: [],
        client: fakeClient(),
        event: fakeEvent,
      }),
    )

    // initial load is the first (slow) call
    expect(callIndex).toBe(1)

    // trigger a second call via refresh — simulates fast params switch
    value.refresh()
    expect(callIndex).toBe(2)

    // resolve second (newer) first — should update data
    resolveSecond!(["new"])
    await new Promise<void>((r) => setTimeout(r, 10))

    // resolve first (older) — should NOT overwrite
    resolveFirst!(["old"])
    await new Promise<void>((r) => setTimeout(r, 10))

    expect(value.data()).toEqual(["new"])
    dispose()
  })

  it("event subscription triggers refresh when filter matches", async () => {
    let calls = 0
    const { fire, event } = capturingEvent()
    const { value, dispose } = await withRoot(() =>
      createPolledResource({
        initial: [] as string[],
        fetch: () => {
          calls++
          return Promise.resolve([`call-${calls}`])
        },
        params: () => "wf-1",
        skipWhen: (p) => !p,
        events: [
          { name: "dag.workflow.updated", filter: (props) => props.workflowID === "wf-1" },
        ],
        client: fakeClient(),
        event,
      }),
    )
    expect(calls).toBe(1)
    fire("dag.workflow.updated", { workflowID: "wf-1" })
    await new Promise<void>((r) => setTimeout(r, 20))
    expect(calls).toBe(2)
    dispose()
  })

  it("event subscription ignores events when filter does NOT match", async () => {
    let calls = 0
    const { fire, event } = capturingEvent()
    const { dispose } = await withRoot(() =>
      createPolledResource({
        initial: [] as string[],
        fetch: () => {
          calls++
          return Promise.resolve([`call-${calls}`])
        },
        params: () => "wf-1",
        skipWhen: (p) => !p,
        events: [
          { name: "dag.workflow.updated", filter: (props) => props.workflowID === "wf-1" },
        ],
        client: fakeClient(),
        event,
      }),
    )
    expect(calls).toBe(1)
    fire("dag.workflow.updated", { workflowID: "other-wf" })
    await new Promise<void>((r) => setTimeout(r, 20))
    expect(calls).toBe(1)
    dispose()
  })

  it("event subscription triggers refresh without filter (unconditional)", async () => {
    let calls = 0
    const { fire, event } = capturingEvent()
    const { value, dispose } = await withRoot(() =>
      createPolledResource({
        initial: [] as string[],
        fetch: () => {
          calls++
          return Promise.resolve([`call-${calls}`])
        },
        params: () => "session-1",
        events: [{ name: "dag.workflow.updated" }],
        client: fakeClient(),
        event,
      }),
    )
    expect(calls).toBe(1)
    fire("dag.workflow.updated", {})
    await new Promise<void>((r) => setTimeout(r, 20))
    expect(calls).toBe(2)
    dispose()
  })

  it("onCleanup cancels in-flight fetch and unsubscribes events", async () => {
    let fetchResolve: () => void
    const forever = new Promise<string[]>((r) => { fetchResolve = () => r(["data"]) })
    let eventOffCalled = 0
    const evt = {
      on: (_name: string, _handler: unknown) => {
        return () => { eventOffCalled++ }
      },
    } as unknown as TuiPluginApi["event"]

    const { dispose } = await withRoot(() =>
      createPolledResource({
        initial: [] as string[],
        fetch: () => forever,
        params: () => "p1",
        skipWhen: (p) => !p,
        events: [
          { name: "dag.workflow.updated", filter: (props) => props.workflowID === "p1" },
          { name: "dag.node.updated", filter: (props) => props.workflowID === "p1" },
        ],
        client: fakeClient(),
        event: evt,
      }),
    )

    // Dispose calls onCleanup: cancelled=true + unsub all events
    dispose()
    expect(eventOffCalled).toBe(2)

    // The in-flight fetch should be cancelled — resolving it now should not update data
    fetchResolve!()
    await new Promise<void>((r) => setTimeout(r, 20))
  })

  // Regression: event filter closures must read the params accessor's CURRENT value,
  // not the value captured when the subscription was first registered. (review INFO #3)
  it("filter reads accessor's current value, not the value at registration time", async () => {
    const [pid, setPid] = createSignal<string | undefined>(undefined)
    let calls = 0
    const { fire, event } = capturingEvent()
    const { dispose } = await withRoot(() =>
      createPolledResource({
        initial: [] as string[],
        fetch: () => {
          calls++
          return Promise.resolve([`call-${calls}`])
        },
        params: pid,
        skipWhen: (p) => !p,
        // mirrors wfEvents: filter dynamically reads the accessor
        events: [{ name: "dag.workflow.updated", filter: (p) => p.workflowID === pid() }],
        client: fakeClient(),
        event,
      }),
    )
    // initial pid=undefined → skipWhen short-circuits load → no fetch yet
    expect(calls).toBe(0)
    // event for wf-B while pid is still undefined → filter must NOT match
    fire("dag.workflow.updated", { workflowID: "wf-B" })
    await new Promise<void>((r) => setTimeout(r, 20))
    expect(calls).toBe(0)

    // switch params to wf-B → createEffect re-runs load → first real fetch
    setPid("wf-B")
    await new Promise<void>((r) => setTimeout(r, 20))
    expect(calls).toBe(1)

    // event for wf-B now matches because filter reads pid()'s CURRENT value (wf-B)
    fire("dag.workflow.updated", { workflowID: "wf-B" })
    await new Promise<void>((r) => setTimeout(r, 20))
    expect(calls).toBe(2)
    dispose()
  })
})

// ── Bug regression: hook event subscriptions must track workflowId/nodeId changes ──
//
// Before the fix, wfEvents/nodeEvents received a static string snapshot
// (`wfEvents(props.workflowId() ?? "")`) evaluated once at hook init — when
// workflowId() is typically undefined → "". The filter closure then compared
// `p.workflowID === ""` forever, so real events never matched and live refresh
// silently broke. The fix passes the accessor so the filter reads it dynamically.

describe("data.ts — live-refresh subscriptions track id changes (P1 regression)", () => {
  it("useWorkflowHistory refetches on dag.workflow.updated after workflowId becomes defined", async () => {
    const [wfId, setWfId] = createSignal<string | undefined>(undefined)
    let calls = 0
    const client = {
      dag: {
        getWorkflowHistory: async () => {
          calls++
          return { data: [] }
        },
      },
    } as unknown as TuiPluginApi["client"]
    const { fire, event } = capturingEvent()
    const { dispose } = await withRoot(() =>
      useWorkflowHistory({ client, event, workflowId: wfId }),
    )
    // workflowId undefined at init → fetch skipped
    expect(calls).toBe(0)

    // workflowId becomes defined → initial load runs once
    setWfId("wf-A")
    await new Promise<void>((r) => setTimeout(r, 20))
    expect(calls).toBe(1)

    // a matching workflow event must trigger a refetch (broken pre-fix: filter held "")
    fire("dag.workflow.updated", { workflowID: "wf-A" })
    await new Promise<void>((r) => setTimeout(r, 20))
    expect(calls).toBe(2)
    dispose()
  })

  it("useNodeLogs refetches on dag.node.updated after nodeId becomes defined", async () => {
    const [nodeId, setNodeId] = createSignal<string | null | undefined>(undefined)
    let calls = 0
    const client = {
      dag: {
        getNodeLogs: async () => {
          calls++
          return { data: [] }
        },
      },
    } as unknown as TuiPluginApi["client"]
    const { fire, event } = capturingEvent()
    const { dispose } = await withRoot(() =>
      useNodeLogs({ client, event, nodeId }),
    )
    expect(calls).toBe(0)

    setNodeId("node-X")
    await new Promise<void>((r) => setTimeout(r, 20))
    expect(calls).toBe(1)

    fire("dag.node.updated", { nodeID: "node-X" })
    await new Promise<void>((r) => setTimeout(r, 20))
    expect(calls).toBe(2)
    dispose()
  })

  it("useViolations refetches on dag.workflow.updated after workflowId becomes defined", async () => {
    const [wfId, setWfId] = createSignal<string | undefined>(undefined)
    let calls = 0
    const client = {
      dag: {
        getViolations: async () => {
          calls++
          return { data: [] }
        },
      },
    } as unknown as TuiPluginApi["client"]
    const { fire, event } = capturingEvent()
    const { dispose } = await withRoot(() =>
      useViolations({ client, event, workflowId: wfId }),
    )
    expect(calls).toBe(0)

    setWfId("wf-V")
    await new Promise<void>((r) => setTimeout(r, 20))
    expect(calls).toBe(1)

    fire("dag.workflow.updated", { workflowID: "wf-V" })
    await new Promise<void>((r) => setTimeout(r, 20))
    expect(calls).toBe(2)
    dispose()
  })
})

