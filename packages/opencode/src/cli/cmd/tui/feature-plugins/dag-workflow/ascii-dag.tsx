/** @jsxImportSource @opentui/solid */
/**
 * ASCII DAG Topology Renderer
 *
 * Kahn's algorithm for topological layering + flexbox column layout.
 * Each column is a topological level laid out left→right; arrows (──▶)
 * connect each column to the next, matching the left-to-right flow.
 *
 * Architecture constraints:
 * - ReadOnly: no state mutations
 * - Node dimensions via props (no hardcoding)
 */
import { createMemo, For, Show, type JSX } from "solid-js"
import type { DAGNodeSession, DAGNodeStatus } from "@/dag/session/types"
import { useTheme } from "@tui/context/theme"
import { NODE_STATUS_ICON, nodeStatusColor } from "./status"
import { nodeStatusLabel, type Lang } from "./i18n"

/**
 * Topological layer computation (Kahn's algorithm).
 * Returns array of layers, each layer an array of node IDs.
 *
 * Cycle/orphan safety: nodes that never reach in-degree 0 (because they are
 * part of a cycle) are appended as a final layer so they are never silently
 * dropped from the rendered graph.
 */
export function topologicalLayers(
  nodes: DAGNodeSession[],
): string[][] {
  if (nodes.length === 0) return []

  const inDegree: Record<string, number> = {}
  const dependents: Record<string, string[]> = {}

  const nodeIDSet = new Set(nodes.map((n) => n.node_id))

  for (const n of nodes) {
    inDegree[n.node_id] = n.dependencies.filter((d) => nodeIDSet.has(d)).length
    for (const dep of n.dependencies) {
      if (!nodeIDSet.has(dep)) continue
      dependents[dep] = [...(dependents[dep] ?? []), n.node_id]
    }
  }

  const layers: string[][] = []
  const placed = new Set<string>()
  let queue = nodes
    .filter((n) => inDegree[n.node_id] === 0)
    .map((n) => n.node_id)

  while (queue.length > 0) {
    layers.push([...queue])
    for (const id of queue) placed.add(id)
    const next: string[] = []
    for (const id of queue) {
      for (const dep of dependents[id] ?? []) {
        inDegree[dep]--
        if (inDegree[dep] === 0) next.push(dep)
      }
    }
    queue = next
  }

  // Any node not placed is part of a cycle (or otherwise unreachable);
  // append it so the graph view never silently drops nodes.
  const leftover = nodes.filter((n) => !placed.has(n.node_id)).map((n) => n.node_id)
  if (leftover.length > 0) layers.push(leftover)

  return layers
}

/**
 * Status icon for a node (pure function, no hook).
 * Color is resolved separately by the caller via nodeStatusColor(theme).
 */
export function nodeStatusIcon(status: DAGNodeStatus): { icon: string } {
  return { icon: NODE_STATUS_ICON[status] ?? "?" }
}

export type AsciiDagWidthInput = {
  availableWidth?: number
  layerCount: number
  requestedNodeWidth?: number
}

export function calculateAsciiDagNodeWidth(input: AsciiDagWidthInput): number {
  const requested = input.requestedNodeWidth ?? 20
  if (input.availableWidth === undefined || input.layerCount === 0) return requested
  if (input.layerCount === 1) return Math.min(requested, Math.max(8, input.availableWidth))
  const connectorWidth = Math.max(0, input.layerCount - 1) * 5
  const availableForNodes = input.availableWidth - connectorWidth
  if (availableForNodes >= requested * input.layerCount) return requested
  return Math.max(8, Math.floor(availableForNodes / input.layerCount))
}

/**
 * AsciiDag — renders topological columns (left→right) with node boxes and ──▶ arrows.
 */
export function AsciiDag(props: {
  lang: Lang
  nodes: DAGNodeSession[]
  selectedNodeID?: string
  onSelect: (id: string) => void
  availableWidth?: number
  nodeWidth?: number
  nodeHeight?: number
}): JSX.Element {
  const { theme } = useTheme()
  const nodeHeight = () => props.nodeHeight ?? 3

  const layers = createMemo(() => topologicalLayers(props.nodes))
  const nodeWidth = createMemo(() =>
    calculateAsciiDagNodeWidth({
      availableWidth: props.availableWidth,
      layerCount: layers().length,
      requestedNodeWidth: props.nodeWidth,
    }),
  )
  const nodeMap = createMemo(() =>
    Object.fromEntries(props.nodes.map((n) => [n.node_id, n])),
  )

  return (
    <box flexDirection="row" gap={1} alignItems="flex-start">
      <For each={layers()}>
        {(layerIDs, layerIndex) => (
          <box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
            {/* Arrow connector from previous column */}
            <Show when={layerIndex() > 0}>
              <box flexShrink={0} alignItems="center" justifyContent="center">
                <text fg={theme.textMuted}>{"\u2500\u2500\u25b6"}</text>
              </box>
            </Show>
            {/* Column: all nodes at this topological level, stacked vertically */}
            <box gap={1} flexShrink={0}>
              <For each={layerIDs}>
                {(nodeID) => {
                  const node = () => nodeMap()[nodeID]
                  if (!node()) return null
                  const sIcon = () => nodeStatusIcon(node().status)
                  const isSelected = () => props.selectedNodeID === nodeID
                  return (
                    <box
                      onMouseUp={() => props.onSelect(nodeID)}
                      width={nodeWidth()}
                      minHeight={nodeHeight()}
                      paddingLeft={1}
                      paddingRight={1}
                      border={["left", "right", "top", "bottom"]}
                      borderColor={isSelected() ? theme.primary : theme.border}
                      flexShrink={0}
                    >
                      <box flexDirection="row" gap={1}>
                        <text fg={nodeStatusColor(node().status, theme)}>{sIcon().icon}</text>
                        <text fg={theme.text}>
                          {node().config?.name ?? nodeID}
                        </text>
                      </box>
                      <text fg={theme.textMuted}>{nodeStatusLabel(props.lang, node().status)}</text>
                    </box>
                  )
                }}
              </For>
            </box>
          </box>
        )}
      </For>
    </box>
  )
}
