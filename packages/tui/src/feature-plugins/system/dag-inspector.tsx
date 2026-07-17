/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show, createSignal, createEffect, onCleanup } from "solid-js"
import { Spinner } from "../../component/spinner"
import { TextAttributes } from "@opentui/core"
import { useBindings, useCommandShortcut } from "../../keymap"
import { computeWaves, type DagNode } from "./dag-inspector-utils"

const id = "internal:system-dag-inspector"
const ROUTE = "dag"

function DagInspector(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const params = () =>
    ("params" in props.api.route.current ? props.api.route.current.params : undefined) as
      | { sessionID?: string; returnRoute?: { name: string; params?: Record<string, unknown> } }
      | undefined

  const [selectedWorkflow, setSelectedWorkflow] = createSignal<string | undefined>(undefined)
  const [selectedNode, setSelectedNode] = createSignal<string | undefined>(undefined)
  const [nodes, setNodes] = createSignal<DagNode[]>([])

  const workflows = createMemo(() => {
    const sid = params()?.sessionID
    if (!sid) return []
    return props.api.state.session.dag(sid)
  })

  // Keep a valid workflow selected: adopt the first workflow when nothing is
  // selected or the previous selection disappeared (e.g. session switch).
  createEffect(() => {
    const wfs = workflows()
    const sel = selectedWorkflow()
    if (sel && wfs.some((w) => w.id === sel)) return
    setSelectedWorkflow(wfs[0]?.id)
  })

  // Fetch nodes for the selected workflow. Guard against stale responses: if the
  // user switched workflows between fetch-start and fetch-resolve, discard the result.
  const fetchNodes = async (dagID: string) => {
    try {
      const res = await props.api.client.dag.nodes({ dagID })
      // Discard if the user selected a different workflow while this fetch was in flight.
      if (selectedWorkflow() !== dagID) return
      setNodes((res.data ?? []) as DagNode[])
    } catch {
      if (selectedWorkflow() !== dagID) return
      setNodes([])
    }
  }

  createEffect(() => {
    const wf = selectedWorkflow()
    if (!wf) {
      setNodes([])
      return
    }
    void fetchNodes(wf)
    // Re-fetch nodes when the summary publisher signals a change for this session.
    // The summary event fires on any dag.* event that alters visible state,
    // so it is the right trigger for refreshing node detail while the inspector is open.
    const off = props.api.event.on("dag.workflow.summary.updated", () => {
      void fetchNodes(wf)
    })
    onCleanup(() => off())
  })

  const layers = createMemo(() => computeWaves(nodes()))

  // Flattened topological order — the traversal order for keyboard navigation.
  const orderedNodes = createMemo(() => layers().flat())

  // Keep a valid node selected as node data changes (replan can remove nodes).
  createEffect(() => {
    const ns = orderedNodes()
    const sel = selectedNode()
    if (sel && ns.some((n) => n.id === sel)) return
    setSelectedNode(ns[0]?.id)
  })

  const moveNode = (delta: number) => {
    const ns = orderedNodes()
    if (ns.length === 0) return
    const idx = ns.findIndex((n) => n.id === selectedNode())
    const next = idx === -1 ? 0 : Math.min(ns.length - 1, Math.max(0, idx + delta))
    setSelectedNode(ns[next]?.id)
  }

  const moveWorkflow = (delta: number) => {
    const wfs = workflows()
    if (wfs.length === 0) return
    const idx = wfs.findIndex((w) => w.id === selectedWorkflow())
    const next = idx === -1 ? 0 : Math.min(wfs.length - 1, Math.max(0, idx + delta))
    setSelectedWorkflow(wfs[next]?.id)
  }

  const control = (operation: "pause" | "resume" | "cancel") => {
    const wf = selectedWorkflow()
    if (!wf) return
    void props.api.client.dag
      .control({ dagID: wf, operation })
      .then(() => fetchNodes(wf))
      .catch((error: unknown) => {
        props.api.ui.toast({
          variant: "error",
          message: `DAG ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
        })
      })
  }

  const enterNode = () => {
    const node = orderedNodes().find((n) => n.id === selectedNode())
    if (!node) return
    if (!node.child_session_id) {
      props.api.ui.toast({ variant: "info", message: "Node has no session yet" })
      return
    }
    props.api.ui.dialog.clear()
    props.api.route.navigate("session", {
      sessionID: node.child_session_id,
      returnRoute: params()?.returnRoute,
    })
  }

  const close = () => {
    const returnRoute = params()?.returnRoute
    props.api.ui.dialog.clear()
    props.api.route.navigate(returnRoute?.name ?? "home", returnRoute?.params)
  }

  const commands = [
    {
      name: "dag.close",
      title: "Close DAG inspector",
      category: "Workflow",
      run: close,
    },
    {
      name: "dag.enter",
      title: "Enter selected node's session",
      category: "Workflow",
      run: enterNode,
    },
    {
      name: "dag.down",
      title: "Select next DAG node",
      category: "Workflow",
      run() {
        moveNode(1)
      },
    },
    {
      name: "dag.up",
      title: "Select previous DAG node",
      category: "Workflow",
      run() {
        moveNode(-1)
      },
    },
    {
      name: "dag.next_workflow",
      title: "Select next DAG workflow",
      category: "Workflow",
      run() {
        moveWorkflow(1)
      },
    },
    {
      name: "dag.previous_workflow",
      title: "Select previous DAG workflow",
      category: "Workflow",
      run() {
        moveWorkflow(-1)
      },
    },
    {
      name: "dag.pause",
      title: "Pause selected workflow",
      category: "Workflow",
      run() {
        control("pause")
      },
    },
    {
      name: "dag.resume",
      title: "Resume selected workflow",
      category: "Workflow",
      run() {
        control("resume")
      },
    },
    {
      name: "dag.cancel",
      title: "Cancel selected workflow",
      category: "Workflow",
      run() {
        control("cancel")
      },
    },
  ]

  useBindings(() => ({
    commands,
    bindings: props.api.tuiConfig.keybinds.gather(
      "dag",
      commands.map((command) => command.name),
    ),
  }))

  const closeShortcut = useCommandShortcut("dag.close")
  const enterShortcut = useCommandShortcut("dag.enter")

  const statusColor = (status: string) => {
    if (status === "completed") return theme().success
    if (status === "failed") return theme().error
    if (status === "running") return theme().textMuted
    if (status === "pending" || status === "queued") return theme().textMuted
    if (status === "skipped" || status === "cancelled") return theme().textMuted
    return theme().text
  }

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexDirection="row" width="100%" flexGrow={1}>
        {/* Left column: workflow list */}
        <box width="30%" border={["right"]} borderColor={theme().background}>
          <box flexDirection="column" padding={1}>
            <text fg={theme().text} attributes={TextAttributes.BOLD}>
              Workflows
            </text>
            <For each={workflows().slice(0, 10)}>
              {(wf) => (
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseUp={() => setSelectedWorkflow(wf.id)}
                  style={{ backgroundColor: selectedWorkflow() === wf.id ? theme().backgroundMenu : undefined }}
                >
                  <text
                    flexShrink={0}
                    style={{
                      fg: statusColor(wf.status),
                    }}
                  >
                    •
                  </text>
                  <text fg={theme().text} wrapMode="word">
                    {wf.title} ({Number(wf.completedNodes)}/{Number(wf.nodeCount)})
                  </text>
                </box>
              )}
            </For>
          </box>
        </box>

        {/* Right column: node tree in topological waves */}
        <box flexGrow={1} padding={1}>
          <Show
            when={selectedWorkflow()}
            fallback={<text fg={theme().textMuted}>Select a workflow from the left</text>}
          >
            <box flexDirection="column" gap={1}>
              <text fg={theme().text} attributes={TextAttributes.BOLD}>
                {workflows().find((w) => w.id === selectedWorkflow())?.title ?? "Unknown"}
              </text>
              <text fg={theme().textMuted}>ID: {selectedWorkflow()}</text>

              {/* Wave header: nodes at the same topological depth, NOT a barrier */}
              <For each={layers()}>
                {(layer, layerIdx) => (
                  <box flexDirection="column">
                    <text fg={theme().textMuted}>
                      ═══ wave {layerIdx()} ({layer.length} {layer.length === 1 ? "node" : "nodes"})
                    </text>
                    <For each={layer}>
                      {(node) => (
                        <box
                          flexDirection="row"
                          gap={1}
                          onMouseUp={() => setSelectedNode(node.id)}
                          style={{ backgroundColor: selectedNode() === node.id ? theme().backgroundMenu : undefined }}
                        >
                          <Show
                            when={node.status !== "running"}
                            fallback={<Spinner color={theme().textMuted} />}
                          >
                            <text
                              flexShrink={0}
                              style={{
                                fg: statusColor(node.status),
                              }}
                            >
                              •
                            </text>
                          </Show>
                          <text fg={theme().text} wrapMode="word">
                            {node.name}
                          </text>
                          <text fg={theme().textMuted}>[{node.worker_type}]</text>
                          <Show when={node.depends_on.length > 0}>
                            <text fg={theme().textMuted}>
                              [deps: {node.depends_on.join(", ")}]
                            </text>
                          </Show>
                          <Show when={node.status === "failed" && node.error_reason}>
                            <text fg={theme().error} wrapMode="word">
                              ⚠ {node.error_reason}
                            </text>
                          </Show>
                        </box>
                      )}
                    </For>
                  </box>
                )}
              </For>
            </box>
          </Show>
        </box>
      </box>

      {/* Footer: shortcut hints */}
      <box flexDirection="row" gap={2} paddingLeft={1} flexShrink={0}>
        <text fg={theme().textMuted}>↑/↓ node</text>
        <text fg={theme().textMuted}>←/→ workflow</text>
        <Show when={enterShortcut()}>
          <text fg={theme().textMuted}>{enterShortcut()} open session</text>
        </Show>
        <text fg={theme().textMuted}>p pause</text>
        <text fg={theme().textMuted}>r resume</text>
        <text fg={theme().textMuted}>x cancel</text>
        <Show when={closeShortcut()}>
          <text fg={theme().textMuted}>{closeShortcut()} close</text>
        </Show>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: ROUTE,
      render: () => <DagInspector api={api} />,
    },
  ])

  api.keymap.registerLayer({
    commands: [
      {
        name: "dag.open",
        title: "Open DAG inspector",
        slashName: "dag",
        category: "Workflow",
        namespace: "palette",
        run() {
          const current = api.route.current
          const sessionID = "params" in current ? current.params?.sessionID : undefined
          api.route.navigate(ROUTE, {
            sessionID,
            returnRoute: current,
          })
          api.ui.dialog.clear()
        },
      },
    ],
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
