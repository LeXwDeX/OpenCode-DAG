/** @jsxImportSource @opentui/solid */
/**
 * Node Dialog — detail panel for selected DAG node
 *
 * Displays node status, dependencies, error info, retry count.
 * Provides "Enter Sub-Session" button when node has a chat_session_id in metadata.
 *
 * Architecture constraints:
 * - ReadOnly: navigation via route.navigate (no direct store calls)
 * - Bridge 单向：no write-back to DAG state
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createMemo, Show, type JSX } from "solid-js"
import type { DAGNodeSession, DAGNodeStatus } from "@/dag/session/types"
import { useTheme } from "@tui/context/theme"
import type { Lang } from "./i18n"
import { t, nodeStatusLabel } from "./i18n"

/**
 * NodeDialog — renders node detail with optional "Enter Sub-Session" action.
 */
export function NodeDialog(props: {
  lang: Lang
  node: DAGNodeSession | null
  onClose: () => void
  route: TuiPluginApi["route"]
}): JSX.Element {
  const { theme } = useTheme()

  const subSessionID = createMemo(() => {
    const id = props.node?.metadata?.chat_session_id
    return typeof id === "string" ? id : null
  })

  function enterSubSession() {
    const sid = subSessionID()
    if (!sid) return
    props.route.navigate("session", { sessionID: sid })
  }

  return (
    <Show
      when={props.node}
      fallback={
        <box alignItems="center" justifyContent="center">
          <text fg={theme.textMuted}>{t(props.lang, "node_select_hint")}</text>
        </box>
      }
    >
      {(node) => (
        <box gap={1} paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1}>
          <text fg={theme.text}>
            <b>{node().config?.name ?? node().node_id}</b>
          </text>
          <text fg={theme.textMuted}>
            {t(props.lang, "label_status")}: {nodeStatusLabel(props.lang, node().status)}
          </text>
          <text fg={theme.textMuted}>
            {t(props.lang, "label_retries")}: {node().retry_count}/{node().max_retries}
          </text>
          <Show when={node().dependencies.length > 0}>
            <text fg={theme.textMuted}>
              {t(props.lang, "label_deps")}: {node().dependencies.join(", ")}
            </text>
          </Show>
          <Show when={node().error_info}>
            <text fg={theme.error}>
              {t(props.lang, "label_error")}: {node().error_info!.type}: {node().error_info!.message}
            </text>
          </Show>

          {/* Enter Sub-Session button */}
          <Show
            when={subSessionID()}
            fallback={
              <text fg={theme.textMuted}>
                {t(props.lang, "node_subsession_unavailable")}
              </text>
            }
          >
            <text
              fg={theme.primary}
              onMouseUp={enterSubSession}
            >
              {t(props.lang, "node_enter_subsession")}
            </text>
          </Show>

          <text fg={theme.textMuted} onMouseUp={props.onClose}>
            {t(props.lang, "action_close")}
          </text>
        </box>
      )}
    </Show>
  )
}
