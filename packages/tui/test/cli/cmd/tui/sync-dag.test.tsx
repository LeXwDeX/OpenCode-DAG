/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { directory, mount, wait, json } from "./sync-fixture"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import type { DagWorkflowSummary } from "@opencode-ai/sdk/v2"

const sid = "ses_dag_1"

function summaryEvent(summaries: DagWorkflowSummary[], sessionID = sid): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: {
      id: `evt_dag_summary_${Date.now()}_${Math.random()}`,
      type: "dag.workflow.summary.updated",
      properties: { sessionID, summaries },
    },
  }
}

function summary(completed: number, total: number, running = 0, failed = 0): DagWorkflowSummary {
  return {
    id: "wf-1",
    title: "Test workflow",
    status: "running",
    nodeCount: total,
    completedNodes: completed,
    runningNodes: running,
    failedNodes: failed,
  }
}

describe("tui sync dag slice", () => {
  test("dag.workflow.summary.updated event writes into store.dag[sessionID]", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)

    try {
      expect(sync.data.dag[sid] ?? []).toEqual([])

      emit(summaryEvent([summary(2, 5, 1, 0)]))
      await wait(() => (sync.data.dag[sid]?.length ?? 0) > 0)

      const stored = sync.data.dag[sid]
      expect(stored).toHaveLength(1)
      expect(stored[0]).toMatchObject({ id: "wf-1", completedNodes: 2, nodeCount: 5, runningNodes: 1 })
    } finally {
      app.renderer.destroy()
    }
  })

  test("subsequent summary events replace the slice rather than accumulate", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)

    try {
      emit(summaryEvent([summary(1, 3)]))
      await wait(() => (sync.data.dag[sid]?.length ?? 0) === 1)
      expect(sync.data.dag[sid][0].completedNodes).toBe(1)

      emit(summaryEvent([summary(3, 3)]))
      await wait(() => sync.data.dag[sid]?.[0]?.completedNodes === 3)

      expect(sync.data.dag[sid]).toHaveLength(1)
      expect(sync.data.dag[sid][0].completedNodes).toBe(3)
    } finally {
      app.renderer.destroy()
    }
  })

  test("bootstrap fetches GET /dag/session/:sid/summary as the baseline safety net", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const fetched: string[] = []
    const sessionRow = {
      id: sid,
      slug: "dag-test",
      projectID: "proj_test",
      directory,
      version: "test",
      time: { created: 0, updated: 0 },
    }
    const { app, sync } = await mount((url) => {
      // Make the session visible so bootstrap treats it as eligible for the summary fetch.
      if (url.pathname === "/session") return json([sessionRow])
      if (url.pathname === `/dag/session/${sid}/summary`) {
        fetched.push(url.pathname)
        return json([summary(4, 6, 1, 1)])
      }
      return undefined
    }, tmp.path)

    try {
      await wait(() => (sync.data.dag[sid]?.length ?? 0) > 0)
      expect(fetched).toContain(`/dag/session/${sid}/summary`)
      expect(sync.data.dag[sid][0]).toMatchObject({ completedNodes: 4, failedNodes: 1 })
    } finally {
      app.renderer.destroy()
    }
  })
})
