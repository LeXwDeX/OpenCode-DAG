/** @jsxImportSource @opentui/solid */
/**
 * DAG Workflow 工作台渲染组件
 *
 * DAG 工作流面板渲染组件（独立实现）。
 * 包含：DagWorkflowRenderer（节点树，按拓扑层级缩进展示全部节点）
 *       DagProgressBar（进度条）
 */
import { createMemo, For, Show, type Accessor, type JSX } from "solid-js"
import type {
  DAGNodeSession,
  DAGWorkflowSession,
  DAGWorkflowProgress,
  DAGWorkflowStatus,
} from "@/dag/session/types"
import type { GraphStats } from "./data"
import { useTheme } from "@tui/context/theme"
import { topologicalLayers } from "./ascii-dag"
import { GLYPH } from "./glyphs"
import { nodeStatusColor, nodeStatusIconChar, workflowStatusColor } from "./status"
import { useSpinner, SPINNER_FRAMES } from "./use-spinner"
import type { Lang } from "./i18n"
import { t, nodeStatusLabel, workflowStatusLabel } from "./i18n"

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return GLYPH.emDash
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
  spinnerFrame: Accessor<string>
  onSelect: () => void
}) {
  const { theme } = useTheme()
  const connector = () => (props.isLast ? GLYPH.treeLast : GLYPH.treeBranch)
  const iconColor = createMemo(() => nodeStatusColor(props.node.status, theme))
  const isRunning = createMemo(() => props.node.status === "running")
  // running 节点显示动画 spinner；其他状态显示静态图标
  const icon = createMemo(() => (isRunning() ? props.spinnerFrame() : nodeStatusIconChar(props.node.status)))
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
  selectedNodeId: string | null
  onNodeSelect: (nodeId: string) => void
}): JSX.Element {
  const { theme } = useTheme()
  const wfColor = createMemo(() => workflowStatusColor(props.workflow.status, theme))
  const wfStatusLabel = createMemo(() => workflowStatusLabel(props.lang, props.workflow.status))

  // 统一管理 spinner：只有存在 running 节点时才启动定时器（按需）
  const hasRunning = createMemo(() => props.nodes.some((n) => n.status === "running"))
  const spinnerFrame = useSpinner(hasRunning)

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
                spinnerFrame={spinnerFrame}
                selected={props.selectedNodeId === entry.node.node_id}
                onSelect={() => props.onNodeSelect(entry.node.node_id)}
              />
            )}
          </For>
        </Show>
      </box>

    </box>
  )
}

/**
 * formatProgressSummary — 从 DAGWorkflowProgress 生成紧凑文本摘要
 *
 * 输出示例：
 * - null → "-"
 * - "0/0 nodes"（无节点）
 * - "required: 3/5 | failed: 1 | 2/3 running | ETA: 2m 30s"
 * - "5/5 nodes"（全完成，无 required/concurrency/ETA）
 */
export function formatProgressSummary(
  progress: DAGWorkflowProgress | null | undefined,
  lang: Lang,
): string {
  if (!progress) return GLYPH.emDash
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
    if (req.recoverable > 0) {
      parts.push(`${nodeStatusLabel(lang, "recoverable")}: ${req.recoverable}`)
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
  return parts.join(` ${GLYPH.separator} `)
}

/**
 * DagProgressBar — workflow 进度条（rich progress 版本）
 *
 * 渲染：
 * - 进度条可视化 [####......] XX%
 * - 下方摘要行：required / failed / running / ETA
 * - （WP-TUI-4 可选）第三行：Critical / Parallel / ETA（来自 GraphStats）
 *
 * 布局约束（BUG-4）：bar 行、summary 行、stats 行各自包在独立 <box> 中，
 * 防止 <text> 在 bar 行后内联续排（曾出现 `failed: 1[###` 重叠）。
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
    ].join(` ${GLYPH.separator} `)
  })

  return (
    <box flexDirection="column" gap={0}>
      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted}>{t(props.lang, "label_progress")}:</text>
        <text fg={barColor()}>
          {"["}
          <span style={{ fg: barColor() }}>{GLYPH.barFill.repeat(filled())}</span>
          <span style={{ fg: theme.textMuted }}>{GLYPH.barEmpty.repeat(empty())}</span>
          {"]"}
        </text>
        <text fg={barColor()}>{percent()}%</text>
      </box>
      <box>
        <text fg={theme.textMuted}>{summary()}</text>
      </box>
      <Show when={statsLine() !== ""}>
        <box>
          <text fg={theme.textMuted}>{statsLine()}</text>
        </box>
      </Show>
    </box>
  )
}
