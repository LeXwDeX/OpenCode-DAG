/** @jsxImportSource @opentui/solid */
/**
 * DAG Map — 方块字符拓扑地图
 *
 * 用实心/空心方块字符（●/○）构建紧凑的二维网格，每个节点占一个字符。
 * 网格的行 = 最大并发层的节点数，列 = 拓扑层数。层与层之间用空格分隔。
 *
 * 顶部标题行显示进度条（仅在非 compact 模式），下方网格支持横向+纵向滚动。
 *
 * 架构约束：
 * - ReadOnly：无状态变更
 * - 复用 topologicalLayers()（ascii-dag.tsx）做拓扑分层
 * - 所有 running 节点共享同一个 blink 帧
 */
import { createMemo, For, Show, type JSX } from "solid-js"
import { RGBA } from "@opentui/core"
import type { DAGNodeSession, DAGNodeStatus } from "@/dag/session/types"
import { useTheme } from "@tui/context/theme"
import { topologicalLayers } from "./ascii-dag"
import { MAP_GLYPH } from "./glyphs"
import { useBlockBlink } from "./use-block-blink"
import { DICT, type Lang } from "./i18n"

const PROGRESS_BAR_WIDTH = 12

type GridCell = {
  readonly spacer: boolean
  readonly nodeID?: string
}

function statusChar(status: DAGNodeStatus, blinkFrame: string): string {
  switch (status) {
    case "completed":
      return MAP_GLYPH.solid
    case "failed":
      return MAP_GLYPH.failed
    case "running":
      return blinkFrame
    default:
      return MAP_GLYPH.hollow
  }
}

function statusFg(status: DAGNodeStatus, theme: ReturnType<typeof useTheme>["theme"]): RGBA {
  switch (status) {
    case "completed":
      return theme.success
    case "failed":
      return theme.error
    case "running":
      return theme.info
    case "recoverable":
      return theme.warning
    default:
      return theme.textMuted
  }
}

export function DagMap(props: {
  lang: Lang
  nodes: DAGNodeSession[]
  selectedNodeID?: string
  onSelect?: (id: string) => void
  compact?: boolean
  maxHeight?: number
}): JSX.Element {
  const { theme } = useTheme()

  const hasRunning = createMemo(() => props.nodes.some((n) => n.status === "running"))
  const blinkFrame = useBlockBlink(hasRunning)

  const layers = createMemo(() => topologicalLayers(props.nodes))
  const nodeMap = createMemo(() => Object.fromEntries(props.nodes.map((n) => [n.node_id, n])))

  const numRows = createMemo(() => {
    const max = layers().reduce((m, l) => Math.max(m, l.length), 0)
    return Math.max(1, max)
  })

  const grid = createMemo<GridCell[][]>(() => {
    const cols = layers()
    const rows = numRows()
    const result: GridCell[][] = []
    for (let r = 0; r < rows; r++) {
      const row: GridCell[] = []
      for (let c = 0; c < cols.length; c++) {
        if (c > 0) row.push({ spacer: true })
        const nodeID = r < cols[c].length ? cols[c][r] : undefined
        row.push(nodeID ? { spacer: false, nodeID } : { spacer: false })
      }
      result.push(row)
    }
    return result
  })

  const progressFilled = createMemo(() => {
    if (props.nodes.length === 0) return 0
    const done =
      props.nodes.filter((n) => n.status === "completed" || n.status === "failed").length
    return Math.round((done / props.nodes.length) * PROGRESS_BAR_WIDTH)
  })

  const doneCount = createMemo(
    () => props.nodes.filter((n) => n.status === "completed" || n.status === "failed").length,
  )

  const pct = createMemo(() => {
    if (props.nodes.length === 0) return 0
    return Math.round((doneCount() / props.nodes.length) * 100)
  })

  const dict = createMemo(() => DICT[props.lang])

  const hasNodes = createMemo(() => props.nodes.length > 0)

  return (
    <box flexDirection="column" gap={0} flexGrow={props.compact ? 0 : 1} minHeight={0}>
      {!props.compact && (
        <box flexDirection="row" height={1} flexShrink={0} gap={1}>
          <text fg={theme.textMuted}>{"──"}</text>
          <text fg={theme.text}>
            <b>{dict().map_title ?? "DAG Map"}</b>
          </text>
          <text fg={theme.textMuted}>{"──"}</text>
          <text fg={theme.success}>{doneCount()}</text>
          <text fg={theme.textMuted}>/</text>
          <text fg={theme.text}>{props.nodes.length}</text>
          <text fg={theme.textMuted}>{dict().map_nodes ?? "nodes"}</text>
          <text fg={theme.success}>
            {MAP_GLYPH.solid.repeat(progressFilled())}
          </text>
          <text fg={theme.textMuted}>
            {MAP_GLYPH.hollow.repeat(PROGRESS_BAR_WIDTH - progressFilled())}
          </text>
          <text fg={theme.textMuted}>{pct()}%</text>
          <text fg={theme.textMuted}>{"──"}</text>
        </box>
      )}

      <Show
        when={hasNodes()}
        fallback={
          props.compact ? null : (
            <text fg={theme.textMuted}>{dict().label_no_nodes}</text>
          )
        }
      >
        <scrollbox
          flexGrow={1}
          minHeight={0}
          maxHeight={props.maxHeight}
          scrollX={true}
          scrollY={true}
          stickyScroll={false}
        >
          <box flexDirection="column" gap={0}>
            <For each={grid()}>
              {(rowCells) => (
                <box flexDirection="row" gap={0} flexShrink={0}>
                  <For each={rowCells}>
                    {(cell) => {
                      if (cell.spacer) {
                        return <text> </text>
                      }
                      if (!cell.nodeID) {
                        return <text> </text>
                      }
                      const node = nodeMap()[cell.nodeID]
                      if (!node) return <text> </text>
                      const isSelected = props.selectedNodeID === cell.nodeID
                      return (
                        <text
                          fg={isSelected ? theme.primary : statusFg(node.status, theme)}
                          onMouseUp={() => props.onSelect?.(cell.nodeID!)}
                        >
                          {statusChar(node.status, blinkFrame())}
                        </text>
                      )
                    }}
                  </For>
                </box>
              )}
            </For>
          </box>
        </scrollbox>
      </Show>
    </box>
  )
}
