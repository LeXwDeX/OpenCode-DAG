/** @jsxImportSource @opentui/solid */
/**
 * Sidebar DAG Map — Session 侧栏 DAG 地图插件
 *
 * 注册 sidebar_content slot (order=250)，显示在 COST（context:100）下方、
 * DIFF 入口（files:500）上方。
 *
 * 数据流：
 * 1. useWorkflowList → 获取该 session 的所有 workflow
 * 2. 选优先级最高的：running > paused > 最近创建
 * 3. useWorkflowDetail → 获取该 workflow 的 nodes
 * 4. DagMap (compact) → 渲染迷你地图
 *
 * 实时更新：复用 data.ts 的 SSE 事件订阅 + poll 机制，节点状态变化自动刷新。
 */
import { createMemo, Show, type JSX } from "solid-js"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { useWorkflowList, useWorkflowDetail } from "./data"
import { DagMap } from "./dag-map"
import { resolveLang, DICT } from "./i18n"

const id = "internal:sidebar-dag-map"

function View(props: { api: TuiPluginApi; session_id: string }): JSX.Element {
  const theme = () => props.api.theme.current
  const lang = () => resolveLang(props.api)

  const sid = createMemo(() => props.session_id)

  const { list } = useWorkflowList({
    client: props.api.client,
    event: props.api.event,
    session_id: sid,
  })

  const targetWorkflowId = createMemo(() => {
    const workflows = list()
    if (workflows.length === 0) return undefined
    const running = workflows.filter((w) => w.status === "running")
    if (running.length > 0) {
      return running.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0].id
    }
    const paused = workflows.filter((w) => w.status === "paused")
    if (paused.length > 0) {
      return paused.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0].id
    }
    return workflows.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0].id
  })

  const { nodes } = useWorkflowDetail({
    client: props.api.client,
    event: props.api.event,
    workflowId: targetWorkflowId,
  })

  const hasNodes = createMemo(() => nodes().length > 0)
  const dict = createMemo(() => DICT[lang()])

  return (
    <Show when={targetWorkflowId() && hasNodes()}>
      <box flexDirection="column" gap={0}>
        <text fg={theme().text}>
          <b>{dict().map_title ?? "DAG Map"}</b>
        </text>
        <DagMap
          lang={lang()}
          nodes={nodes()}
          compact={true}
          maxHeight={10}
          onSelect={(_nodeId) => {
            props.api.route.navigate("dag-workflow", {
              sessionID: props.session_id,
              workflowId: targetWorkflowId(),
            })
          }}
        />
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 250,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
