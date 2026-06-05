/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createMemo, createResource, createSignal, Show } from "solid-js"
import type {
  DAGNodeSession,
  DAGViolation,
  DAGWorkflowSession,
} from "@/dag/session/types"
import { calculateWorkflowProgress } from "@/dag/session/types"
import { DAGRenderer, DAGProgressBar } from "./renderer"
import { DAGNodeDialog } from "./node-dialog"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"

export function DAGConsoleView(props: { api: TuiPluginApi }) {
  const { theme } = useTheme()
  const dialog = useDialog()

  const params = () =>
    ("params" in props.api.route.current
      ? props.api.route.current.params
      : undefined) as
      | { workflowId?: string; sessionID?: string; returnRoute?: { name: string } }
      | undefined

  const workflowId = () => params()?.workflowId
  const sessionID = () => params()?.sessionID

  const [selectedNodeId, setSelectedNodeId] = createSignal<string | null>(null)

  const [workflowData] = createResource(workflowId, async (id) => {
    if (!id) return null
    const data = props.api.kv.get<DAGWorkflowSession>(
      `dag_workflow_${id}`,
      null as unknown as DAGWorkflowSession,
    )
    return data ?? null
  })

  const [nodes] = createResource(workflowId, async (id) => {
    if (!id) return []
    const data = props.api.kv.get<DAGNodeSession[]>(
      `dag_nodes_${id}`,
      [],
    )
    return data ?? []
  })

  const [violations] = createResource(workflowId, async (id) => {
    if (!id) return []
    const data = props.api.kv.get<DAGViolation[]>(
      `dag_violations_${id}`,
      [],
    )
    return data ?? []
  })

  const selectedNode = createMemo(() => {
    const nodeId = selectedNodeId()
    if (!nodeId) return null
    return nodes()?.find((n) => n.node_id === nodeId) ?? null
  })

  const progress = createMemo(() => {
    const wf = workflowData()
    if (!wf) return { completed: 0, total: 0 }
    const p = calculateWorkflowProgress(wf)
    return { completed: p.all_nodes.completed, total: p.all_nodes.total }
  })

  function goBack() {
    const returnRoute = params()?.returnRoute
    if (returnRoute) {
      props.api.route.navigate(returnRoute.name)
    } else {
      props.api.route.navigate("home")
    }
    dialog.clear()
  }

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        backgroundColor={theme.backgroundPanel}
      >
        <text fg={theme.text}>
          <b>DAG Console</b>
          <Show when={workflowData()}>
            <span style={{ fg: theme.textMuted }}> — {workflowData()!.config?.name ?? workflowId()}</span>
          </Show>
        </text>
        <text fg={theme.textMuted} onMouseUp={goBack}>
          [Esc] Back
        </text>
      </box>

      <Show
        when={workflowData()}
        fallback={
          <box flexGrow={1} alignItems="center" justifyContent="center">
            <text fg={theme.textMuted}>
              {workflowData.loading ? "Loading workflow..." : "No workflow data available"}
            </text>
          </box>
        }
      >
        {(wf) => (
          <box flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2} paddingTop={1} gap={1}>
            <DAGProgressBar
              completed={progress().completed}
              total={progress().total}
              status={wf().status}
            />

            <scrollbox flexGrow={1} minHeight={0} stickyScroll={true} stickyStart="top">
              <DAGRenderer
                workflow={wf()}
                nodes={nodes() ?? []}
                violations={violations() ?? []}
                selectedNodeId={selectedNodeId()}
                onNodeSelect={(nodeId) => setSelectedNodeId(nodeId)}
              />
            </scrollbox>

            <box
              flexDirection="row"
              justifyContent="space-between"
              paddingTop={1}
              paddingBottom={1}
              paddingLeft={1}
              backgroundColor={theme.backgroundPanel}
            >
              <text fg={theme.textMuted}>
                [Tab] Navigate  [Enter] View Node  [Esc] Back
              </text>
              <Show when={selectedNodeId()}>
                <text
                  fg={theme.primary}
                  onMouseUp={() => {
                    const node = selectedNode()
                    if (node) {
                      dialog.replace(() => (
                        <DAGNodeDialog
                          node={node}
                          onClose={() => dialog.clear()}
                        />
                      ))
                    }
                  }}
                >
                  [View Node Details]
                </text>
              </Show>
            </box>
          </box>
        )}
      </Show>
    </box>
  )
}
