/** @jsxImportSource @opentui/solid */
import { For, Show, type JSX } from "solid-js"
import type {
  CascadeImpact,
  ExecutionSnapshot,
  NodeBlockReason,
  TopologySnapshot,
} from "@/dag/query/probe-types"
import type { Lang } from "./i18n"
import { useTheme } from "@tui/context/theme"

export function InspectPanel(props: {
  lang: Lang
  block: NodeBlockReason[]
  topology: TopologySnapshot | null
  snapshot: ExecutionSnapshot | null
  cascade: CascadeImpact | null
  selectedNodeId: string | null
  loading?: boolean
  error?: string | null
}): JSX.Element {
  const { theme } = useTheme()
  return (
    <box gap={1}>
      <text fg={theme.text}><b>{props.lang === "zh" ? "诊断" : "Inspect"}</b></text>
      <Show when={!props.error} fallback={<text fg={theme.error}>Error: {props.error}</text>}>
        <Show when={!props.loading} fallback={<text fg={theme.textMuted}>Loading…</text>}>
          <Show
            when={props.block.length > 0 || props.topology || props.snapshot || props.cascade}
            fallback={<text fg={theme.textMuted}>No diagnostics</text>}
          >
            <box gap={0}>
              <text fg={theme.textMuted}>Block</text>
              <For each={props.block}>{(item) => <text fg={item.blocked ? theme.warning : theme.text}>{item.nodeId}: {item.reason} {formatDeps(item.unsatisfiedDependencies)}</text>}</For>
            </box>
            <box gap={0}>
              <text fg={theme.textMuted}>Topology</text>
              <Show when={props.topology} fallback={<text fg={theme.textMuted}>—</text>}>
                {(topology) => (
                  <>
                    <For each={topology().layers}>{(layer) => <text fg={theme.text}>depth {layer.depth}: {formatInspectList(layer.nodeIds)}</text>}</For>
                    <text fg={topology().hasCycle ? theme.error : theme.textMuted}>cycle: {topology().hasCycle ? "yes" : "no"}</text>
                  </>
                )}
              </Show>
            </box>
            <box gap={0}>
              <text fg={theme.textMuted}>Snapshot</text>
              <Show when={props.snapshot} fallback={<text fg={theme.textMuted}>—</text>}>
                {(snapshot) => <text fg={theme.text}>{formatSnapshot(snapshot())}</text>}
              </Show>
            </box>
            <box gap={0}>
              <text fg={theme.textMuted}>Cascade {props.selectedNodeId ? `(${props.selectedNodeId})` : ""}</text>
              <Show when={props.cascade} fallback={<text fg={theme.textMuted}>{props.selectedNodeId ? "—" : "Select a node"}</text>}>
                {(cascade) => <text fg={theme.text}>{cascade().originNodeId} -&gt; {formatInspectList(cascade().affectedPendingNodeIds)}</text>}
              </Show>
            </box>
          </Show>
        </Show>
      </Show>
    </box>
  )
}

export function inspectPanelSummary(input: {
  block: NodeBlockReason[]
  topology: TopologySnapshot | null
  snapshot: ExecutionSnapshot | null
  cascade: CascadeImpact | null
  loading?: boolean
  error?: string | null
}): string {
  if (input.error) return `Error: ${input.error}`
  if (input.loading) return "Loading"
  if (input.block.length === 0 && !input.topology && !input.snapshot && !input.cascade) return "No diagnostics"
  return [
    `Block: ${input.block.map((item) => `${item.nodeId} ${item.reason}${item.unsatisfiedDependencies.length ? ` [${formatInspectList(item.unsatisfiedDependencies)}]` : ""}`).join("; ") || "—"}`,
    `Topology: ${input.topology ? `${input.topology.layers.map((layer) => `depth ${layer.depth}: ${formatInspectList(layer.nodeIds)}`).join(" | ")}; cycle: ${input.topology.hasCycle ? "yes" : "no"}` : "—"}`,
    `Snapshot: ${input.snapshot ? formatSnapshot(input.snapshot) : "—"}`,
    `Cascade: ${input.cascade ? `${input.cascade.originNodeId} -> ${formatInspectList(input.cascade.affectedPendingNodeIds)}` : "—"}`,
  ].join("\n")
}

export function formatInspectList(items: string[]): string {
  return items.length ? items.join(",") : "—"
}

function formatDeps(items: string[]): string {
  return items.length ? `[${formatInspectList(items)}]` : ""
}

function formatSnapshot(snapshot: ExecutionSnapshot): string {
  return `running ${formatInspectList(snapshot.running)}; ready ${formatInspectList(snapshot.ready)}; pending ${formatInspectList(snapshot.pending)}; spawn ${snapshot.spawnBudget}`
}
