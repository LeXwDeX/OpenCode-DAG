/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show, createSignal } from "solid-js"
import { Spinner } from "../../component/spinner"
import { TextAttributes } from "@opentui/core"

const id = "internal:system-dag-inspector"
const ROUTE = "dag"

interface DagNode {
  id: string
  name: string
  status: string
  worker_type: string
  depends_on: string[]
  child_session_id?: string
}

function DagInspector(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const params = () =>
    ("params" in props.api.route.current ? props.api.route.current.params : undefined) as
      | { sessionID?: string; returnRoute?: unknown }
      | undefined

  const [selectedWorkflow, setSelectedWorkflow] = createSignal<string | undefined>(undefined)
  const [selectedNode, setSelectedNode] = createSignal<string | undefined>(undefined)

  const workflows = createMemo(() => {
    const sid = params()?.sessionID
    if (!sid) return []
    return props.api.state.session.dag(sid)
  })

  const nodes = createMemo<DagNode[]>(() => {
    // Populated via HTTP route call in production. Left empty until AppLayer wiring.
    return []
  })

  const layers = createMemo(() => {
    const ns = nodes()
    if (ns.length === 0) return []
    const done = new Set<string>()
    const remaining = new Set(ns.map((n) => n.id))
    const deps = new Map(ns.map((n) => [n.id, n.depends_on]))
    const result: DagNode[][] = []
    while (remaining.size > 0) {
      const layer: DagNode[] = []
      for (const id of remaining) {
        const d = deps.get(id) ?? []
        if (d.every((dep) => done.has(dep))) {
          const node = ns.find((n) => n.id === id)
          if (node) layer.push(node)
        }
      }
      if (layer.length === 0) break
      layer.sort((a, b) => a.name.localeCompare(b.name))
      result.push(layer)
      for (const n of layer) {
        done.add(n.id)
        remaining.delete(n.id)
      }
    }
    return result
  })

  const statusColor = (status: string) => {
    if (status === "completed") return theme().success
    if (status === "failed") return theme().error
    if (status === "running") return theme().textMuted
    if (status === "pending" || status === "queued") return theme().textMuted
    if (status === "skipped" || status === "cancelled") return theme().textMuted
    return theme().text
  }

  return (
    <box flexDirection="row" width="100%" height="100%">
      {/* Left column: workflow list */}
      <box width="30%" border={["right"]} borderColor={theme().background}>
        <box flexDirection="column" padding={1}>
          <text fg={theme().text} attributes={TextAttributes.BOLD}>
            最近10条 DAG
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
                  {wf.title} ({wf.completedNodes}/{wf.nodeCount})
                </text>
              </box>
            )}
          </For>
        </box>
      </box>

      {/* Right column: NODE-TREE */}
      <box flexGrow={1} padding={1}>
        <Show
          when={selectedWorkflow()}
          fallback={<text fg={theme().textMuted}>Select a workflow from the left</text>}
        >
          <box flexDirection="column" gap={1}>
            <text fg={theme().text} attributes={TextAttributes.BOLD}>
              {workflows().find((w) => w.id === selectedWorkflow())?.title ?? "Unknown"}
            </text>
            <text fg={theme().textMuted}>
              ID: {selectedWorkflow()}
            </text>

            {/* α NODE-TREE rendering with wave headers */}
            <For each={layers()}>
              {(layer, layerIdx) => (
                <box flexDirection="column">
                  {/* Wave header: same topological depth, NOT a barrier */}
                  <text fg={theme().textMuted}>
                    ═══ L{layerIdx()} · depth {layerIdx()} ({layer.length} nodes)
                  </text>
                  <For each={layer}>
                    {(node) => (
                      <box
                        flexDirection="row"
                        gap={1}
                        onMouseUp={() => setSelectedNode(node.id)}
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
                        <Show when={node.depends_on.length > 0}>
                          <text fg={theme().textMuted}>
                            [deps: {node.depends_on.join(", ")}]
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
      {
        name: "dag.close",
        title: "Close DAG inspector",
        run() {
          const params = "params" in api.route.current ? api.route.current.params : undefined
          const returnRoute = (params as { returnRoute?: { name: string; params?: Record<string, unknown> } } | undefined)?.returnRoute
          api.ui.dialog.clear()
          api.route.navigate(returnRoute?.name ?? "home", returnRoute?.params as Record<string, unknown> | undefined)
        },
      },
      {
        name: "dag.enter",
        title: "Enter selected node's session",
        run() {
          // Navigate to child session — reads selected node's child_session_id
          // and calls api.route.navigate("session", { sessionID: childID, returnRoute: currentRoute })
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
