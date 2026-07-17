/** @jsxImportSource @opentui/solid */
import { describe, expect, test, mock } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import type { TuiPluginApi, TuiRouteCurrent, TuiRouteDefinition } from "@opencode-ai/plugin/tui"
import type { DagWorkflowSummary } from "@opencode-ai/sdk/v2"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { TuiConfigProvider } from "../../src/config"
import { OpencodeKeymapProvider } from "../../src/keymap"
import dagInspectorPlugin from "../../src/feature-plugins/system/dag-inspector"
import { createTuiPluginApi } from "../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"

interface DagNodeRow {
  id: string
  name: string
  status: string
  worker_type: string
  depends_on: string[]
  child_session_id?: string | null
  error_reason?: string | null
}

const wfSummary = (overrides: Partial<DagWorkflowSummary> = {}): DagWorkflowSummary => ({
  id: "wf-1",
  title: "Test workflow",
  status: "running",
  nodeCount: 2,
  completedNodes: 0,
  runningNodes: 0,
  failedNodes: 0,
  ...overrides,
})

type RenderOpts = {
  workflows?: DagWorkflowSummary[]
  nodes?: DagNodeRow[]
  initialRoute?: TuiRouteCurrent
}

async function renderDagInspector(opts: RenderOpts = {}) {
  const commands = new Map<
    string,
    NonNullable<Parameters<TuiPluginApi["keymap"]["registerLayer"]>[0]["commands"]>[number]
  >()
  let current: TuiRouteCurrent =
    opts.initialRoute ?? { name: "dag", params: { sessionID: "ses_1" } }
  let renderInspector: TuiRouteDefinition["render"] | undefined

  // Trackable spies
  const nodesCalls: string[] = []
  const navigations: { name: string; params?: Record<string, unknown> }[] = []
  const toasts: { variant?: string; message: string }[] = []
  const eventHandlers = new Map<string, () => void>()

  const config = createTuiResolvedConfig()

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const registerLayer = keymap.registerLayer.bind(keymap)
    keymap.registerLayer = (layer) => {
      layer.commands?.forEach((command) => commands.set(command.name, command))
      return registerLayer(layer)
    }
    const base = createTuiPluginApi({
      keymap,
      client: {
        dag: {
          nodes: async (input: { dagID: string }) => {
            nodesCalls.push(input.dagID)
            return { data: opts.nodes ?? [] }
          },
        },
      } as unknown as TuiPluginApi["client"],
      state: {
        session: {
          dag: () => opts.workflows ?? [],
        },
      },
      event: {
        on: ((type: string, handler: () => void) => {
          eventHandlers.set(type, handler)
          return () => eventHandlers.delete(type)
        }) as unknown as TuiPluginApi["event"]["on"],
      } as TuiPluginApi["event"],
    })
    const api = {
      ...base,
      route: {
        register(routes) {
          renderInspector = routes.find((route) => route.name === "dag")?.render
          return () => {}
        },
        navigate(name, params) {
          navigations.push({ name, params })
          current = params ? { name, params } : { name }
        },
        get current() {
          return current
        },
      },
      ui: {
        ...base.ui,
        toast: (t: { variant?: string; message: string }) => toasts.push(t),
      },
    } satisfies TuiPluginApi

    void dagInspectorPlugin.tui(api, undefined, undefined as never)

    return (
      <TestTuiContexts>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                {renderInspector?.({ params: "params" in current ? current.params : undefined })}
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 30 })
  // Wait for the inspector commands to be registered.
  await waitForCommand(app, commands, "dag.close")

  return {
    app,
    commands,
    navigations: () => navigations,
    toasts: () => toasts,
    nodesCalls: () => nodesCalls,
    emitSummaryUpdate: () => eventHandlers.get("dag.workflow.summary.updated")?.(),
    current: () => current,
  }
}

async function waitForCommand(
  app: Awaited<ReturnType<typeof testRender>>,
  commands: Map<string, unknown>,
  name: string,
  timeout = 2000,
) {
  const start = Date.now()
  while (!commands.has(name)) {
    if (Date.now() - start > timeout) throw new Error(`command "${name}" not registered`)
    await app.renderOnce()
    await Bun.sleep(5)
  }
}

describe("DagInspector", () => {
  test("mounting fetches nodes for the auto-selected workflow", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1", nodeCount: 1 })],
      nodes: [{ id: "n-1", name: "build", status: "pending", worker_type: "build", depends_on: [] }],
    })
    try {
      await Bun.sleep(30)
      expect(viewer.nodesCalls()).toContain("wf-1")
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("dag.workflow.summary.updated event triggers a node re-fetch", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1" })],
      nodes: [{ id: "n-1", name: "build", status: "running", worker_type: "build", depends_on: [] }],
    })
    try {
      await Bun.sleep(20)
      const before = viewer.nodesCalls().length
      viewer.emitSummaryUpdate()
      await Bun.sleep(20)
      const after = viewer.nodesCalls().length
      expect(after).toBeGreaterThan(before)
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("dag.enter navigates into the selected node's child session", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1" })],
      nodes: [
        {
          id: "n-1",
          name: "build",
          status: "running",
          worker_type: "build",
          depends_on: [],
          child_session_id: "child_ses_1",
        },
      ],
    })
    try {
      viewer.commands.get("dag.enter")!.run?.({} as never)
      await Bun.sleep(10)
      expect(viewer.navigations()).toContainEqual(
        expect.objectContaining({ name: "session", params: expect.objectContaining({ sessionID: "child_ses_1" }) }),
      )
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("dag.enter toasts when the node has no child session yet", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1" })],
      nodes: [{ id: "n-1", name: "build", status: "pending", worker_type: "build", depends_on: [], child_session_id: null }],
    })
    try {
      viewer.commands.get("dag.enter")!.run?.({} as never)
      await Bun.sleep(10)
      expect(viewer.toasts().some((t) => /no session/i.test(t.message))).toBe(true)
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("dag.close navigates back to the return route", async () => {
    const returnRoute = { name: "session", params: { sessionID: "ses_1" } }
    const viewer = await renderDagInspector({
      initialRoute: { name: "dag", params: { sessionID: "ses_1", returnRoute } },
      workflows: [wfSummary({ id: "wf-1" })],
    })
    try {
      viewer.commands.get("dag.close")!.run?.({} as never)
      await Bun.sleep(10)
      expect(viewer.navigations().at(-1)).toEqual(
        expect.objectContaining({ name: "session", params: { sessionID: "ses_1" } }),
      )
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("a failed node renders its error_reason in the inspector", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1", failedNodes: 1, nodeCount: 1 })],
      nodes: [
        {
          id: "n-1",
          name: "build",
          status: "failed",
          worker_type: "build",
          depends_on: [],
          error_reason: "compile error in main.ts",
        },
      ],
    })
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("compile error in main.ts"))
      // The error reason must reach the rendered frame. The guard above throws on timeout if absent.
    } finally {
      viewer.app.renderer.destroy()
    }
  })
})
