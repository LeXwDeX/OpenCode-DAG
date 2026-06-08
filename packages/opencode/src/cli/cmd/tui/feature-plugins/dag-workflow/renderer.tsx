/** @jsxImportSource @opentui/solid */
/**
 * DAG Workflow 工作台渲染组件
 *
 * DAG 工作流面板渲染组件（独立实现）。
 * 包含：DagWorkflowRenderer（节点树，按拓扑层级缩进展示全部节点）
 *       DagProgressBar（进度条）
 */
import { createMemo, For, Show, type JSX } from "solid-js"
import type {
  DAGNodeSession,
  DAGViolation,
  DAGWorkflowSession,
  DAGWorkflowProgress,
  DAGWorkflowStatus,
} from "@/dag/session/types"
import type { GraphStats } from "./data"
import { useTheme } from "@tui/context/theme"
import { topologicalLayers } from "./ascii-dag"
import { nodeStatusColor, nodeStatusIconChar, workflowStatusColor } from "./status"
import type { Lang } from "./i18n"
import { t, nodeStatusLabel, workflowStatusLabel, violationSeverityLabel, violationTypeLabel } from "./i18n"

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "\u2014"
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = Math.round(seconds % 60)
  return `${minutes}m ${remaining}s`
}

function DagNodeRow(props: {
  node: DAGNodeSession
  depth: number
  isLast: boolean
  selected: boolean
  lang: Lang
  onSelect: () => void
}) {
  const { theme } = useTheme()
  const connector = () => (props.isLast ? "\u2514\u2500" : "\u251c\u2500")
  const iconColor = createMemo(() => nodeStatusColor(props.node.status, theme))
  const icon = createMemo(() => nodeStatusIconChar(props.node.status))
  const statusLabel = createMemo(() => nodeStatusLabel(props.lang, props.node.status))

  return (
    <box
      onMouseUp={props.onSelect}
      paddingLeft={props.depth * 2}
      backgroundColor={props.selected ? theme.backgroundElement : undefined}
    >
      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted}>{connector()}</text>
        <text fg={iconColor()}>{icon()}</text>
        <text fg={theme.text}>{props.node.config?.name ?? props.node.node_id}</text>
        <text fg={theme.textMuted}>({statusLabel()})</text>
        <Show when={props.node.duration_ms !== null}>
          <text fg={theme.textMuted}>{formatDuration(props.node.duration_ms)}</text>
        </Show>
        <Show when={props.node.error_info?.message}>
          <text fg={theme.error}>{props.node.error_info!.message.slice(0, 40)}</text>
        </Show>
      </box>
    </box>
  )
}

/**
 * DagWorkflowRenderer — 节点树视图（中间区）
 *
 * 通过 Kahn 拓扑分层把每个节点的缩进深度 = 其拓扑层级，
 * 从而展示 **全部** 节点（含依赖子节点），而非仅根节点。
 */
export function DagWorkflowRenderer(props: {
  lang: Lang
  workflow: DAGWorkflowSession
  nodes: DAGNodeSession[]
  violations: DAGViolation[]
  selectedNodeId: string | null
  onNodeSelect: (nodeId: string) => void
}): JSX.Element {
  const { theme } = useTheme()
  const wfColor = createMemo(() => workflowStatusColor(props.workflow.status, theme))
  const wfStatusLabel = createMemo(() => workflowStatusLabel(props.lang, props.workflow.status))

  // 按拓扑层级排列全部节点，depth = 层级索引（reachable 的所有节点都会出现）
  const orderedNodes = createMemo<{ node: DAGNodeSession; depth: number }[]>(() => {
    const layers = topologicalLayers(props.nodes)
    const byId = new Map(props.nodes.map((n) => [n.node_id, n]))
    const seen = new Set<string>()
    const out: { node: DAGNodeSession; depth: number }[] = []
    layers.forEach((layer, depth) => {
      for (const id of layer) {
        const n = byId.get(id)
        if (n) {
          out.push({ node: n, depth })
          seen.add(id)
        }
      }
    })
    // 安全兜底：任何未被拓扑覆盖的节点（理论上不该有）追加到末尾
    for (const n of props.nodes) {
      if (!seen.has(n.node_id)) out.push({ node: n, depth: 0 })
    }
    return out
  })

  return (
    <box gap={1}>
      <box
        border={["top"]}
        borderColor={wfColor()}
        title={` ${props.workflow.config?.name ?? props.workflow.id} `}
        titleAlignment="center"
      />

      <box flexDirection="row" gap={2} paddingLeft={1}>
        <text fg={wfColor()}>{t(props.lang, "label_status")}: {wfStatusLabel()}</text>
        <Show when={props.workflow.duration_ms !== null}>
          <text fg={theme.textMuted}>{t(props.lang, "label_duration")}: {formatDuration(props.workflow.duration_ms)}</text>
        </Show>
      </box>

      <box paddingLeft={1} gap={0}>
        <Show
          when={orderedNodes().length > 0}
          fallback={<text fg={theme.textMuted}>{t(props.lang, "label_no_nodes")}</text>}
        >
          <For each={orderedNodes()}>
            {(entry, index) => (
              <DagNodeRow
                node={entry.node}
                depth={entry.depth}
                isLast={(() => {
                  const next = orderedNodes()[index() + 1]
                  return !next || next.depth !== entry.depth
                })()}
                lang={props.lang}
                selected={props.selectedNodeId === entry.node.node_id}
                onSelect={() => props.onNodeSelect(entry.node.node_id)}
              />
            )}
          </For>
        </Show>
      </box>

      <Show when={props.violations.length > 0}>
        <box border={["top"]} borderColor={theme.error} title={` ${t(props.lang, "title_violations")} `} titleAlignment="center" />
        <For each={props.violations}>
          {(violation) => (
            <box flexDirection="row" gap={1} paddingLeft={1}>
              <text fg={theme.error}>{"\u26a0"}</text>
              <text fg={theme.error}>[{violationSeverityLabel(props.lang, violation.severity)}]</text>
              <text fg={theme.text}>{violationTypeLabel(props.lang, violation.type)}:</text>
              <text fg={theme.textMuted}>{violation.message}</text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

/**
 * formatProgressSummary — 从 DAGWorkflowProgress 生成紧凑文本摘要
 *
 * 输出示例：
 * - null → "—"
 * - "0/0 nodes"（无节点）
 * - "required: 3/5 · failed: 1 · 2/3 running · ETA: 2m 30s"
 * - "5/5 nodes"（全完成，无 required/concurrency/ETA）
 */
export function formatProgressSummary(
  progress: DAGWorkflowProgress | null | undefined,
  lang: Lang,
): string {
  if (!progress) return "\u2014"
  const all = progress.all_nodes
  if (all.total === 0) {
    return "0/0 " + (lang === "zh" ? "节点" : "nodes")
  }
  const req = progress.required
  const parts: string[] = []
  if (req.total > 0) {
    parts.push(`${lang === "zh" ? "必需" : "required"}: ${req.completed}/${req.total}`)
    if (req.failed > 0) {
      parts.push(`${nodeStatusLabel(lang, "failed")}: ${req.failed}`)
    }
  }
  if (progress.current_concurrency > 0) {
    parts.push(`${progress.current_concurrency}/${progress.max_concurrency} ${nodeStatusLabel(lang, "running")}`)
  }
  if (progress.estimated_remaining_ms !== undefined && progress.estimated_remaining_ms > 0) {
    parts.push(`ETA: ${formatDuration(progress.estimated_remaining_ms)}`)
  }
  if (parts.length === 0) {
    return `${all.completed}/${all.total} ${lang === "zh" ? "节点" : "nodes"}`
  }
  return parts.join(" \u00b7 ")
}

/**
 * DagProgressBar — workflow 进度条（rich progress 版本）
 *
 * 渲染：
 * - 进度条可视化 [■■■■□□□□□□] XX%
 * - 下方摘要行：required / failed / running / ETA
 * - （WP-TUI-4 可选）第三行：Critical / Parallel / ETA（来自 GraphStats）
 */
export function DagProgressBar(props: {
  lang: Lang
  progress: DAGWorkflowProgress | null
  status: DAGWorkflowStatus
  /** WP-TUI-4 可选图统计；additive extension，不影响原有签名 */
  stats?: GraphStats | null
}): JSX.Element {
  const { theme } = useTheme()
  const allNodes = () => props.progress?.all_nodes ?? { total: 0, completed: 0 }
  const percent = createMemo(() =>
    allNodes().total > 0 ? Math.round((allNodes().completed / allNodes().total) * 100) : 0,
  )
  const barLength = 20
  const filled = createMemo(() => Math.round((percent() / 100) * barLength))
  const empty = createMemo(() => barLength - filled())
  const barColor = createMemo(() => workflowStatusColor(props.status, theme))
  const summary = createMemo(() => formatProgressSummary(props.progress, props.lang))
  const statsLine = createMemo(() => {
    const s = props.stats
    if (!s) return ""
    return [
      `${t(props.lang, "label_critical_path")}: ${formatDuration(s.criticalPathLength)}`,
      `${t(props.lang, "label_parallelism")}: ${s.parallelismDegree}`,
      `${t(props.lang, "label_eta")}: ${formatDuration(s.estimatedCompletionTime)}`,
    ].join(" | ")
  })

  return (
    <box flexDirection="column" gap={0}>
      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted}>{t(props.lang, "label_progress")}:</text>
        <text fg={barColor()}>
          {"["}
          <span style={{ fg: barColor() }}>{"\u25a0".repeat(filled())}</span>
          <span style={{ fg: theme.textMuted }}>{"\u25a1".repeat(empty())}</span>
          {"]"}
        </text>
        <text fg={barColor()}>{percent()}%</text>
      </box>
      <text fg={theme.textMuted}>{summary()}</text>
      <Show when={statsLine() !== ""}>
        <text fg={theme.textMuted}>{statsLine()}</text>
      </Show>
    </box>
  )
}
