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
  useWorkflowList,
  useWorkflow,
  useNodes,
  useViolations,
} from "./data"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

// ── SDK 样本数据（含 number|"NaN"|"Infinity" 等序列化产物） ──────────────────

const sdkNode = {
  node_id: "n1",
  workflow_id: "wf-1",
  config: { id: "n1", name: "收集" },
  status: "completed" as const,
  output: null,
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
    expect(n.status).toBe("completed")
    expect(n.dependencies).toEqual(["dep0"])
    expect(n.completed_at).toBe("1500")
    expect(n.duration_ms).toBe(500)
    expect(n.logs).toEqual([])
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

describe("WP4 data.ts — useWorkflow", () => {
  it("loads a single workflow with node_sessions", async () => {
    const { value, dispose } = await withRoot(() =>
      useWorkflow({ client: fakeClient(), event: fakeEvent, workflowId: () => "wf-1" }),
    )
    const wf = value.workflow()
    expect(wf).not.toBeNull()
    expect(wf!.id).toBe("wf-1")
    expect(Object.keys(wf!.node_sessions)).toEqual(["n1"])
    dispose()
  })

  it("returns null when workflowId is undefined", async () => {
    const { value, dispose } = await withRoot(() =>
      useWorkflow({ client: fakeClient(), event: fakeEvent, workflowId: () => undefined }),
    )
    expect(value.workflow()).toBeNull()
    dispose()
  })
})

describe("WP4 data.ts — useNodes", () => {
  it("loads nodes for a workflow", async () => {
    const { value, dispose } = await withRoot(() =>
      useNodes({ client: fakeClient(), event: fakeEvent, workflowId: () => "wf-1" }),
    )
    const nodes = value.nodes()
    expect(nodes.length).toBe(1)
    expect(nodes[0]!.node_id).toBe("n1")
    dispose()
  })
})

describe("WP4 data.ts — useViolations", () => {
  it("returns an empty array (no server route yet)", () => {
    createRoot((dispose) => {
      const { violations } = useViolations({ workflowId: () => "wf-1" })
      expect(violations()).toEqual([])
      dispose()
    })
  })
})
