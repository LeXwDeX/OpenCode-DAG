/** @jsxImportSource @opentui/solid */
/**
 * Live Ticker — real-time activity line
 *
 * Subscribes to `message.part.updated` SSE event via api.event.on.
 * Filters events to only those matching session IDs from the current workflow's nodes.
 * Displays a summary of the most recent assistant message or tool call.
 * Throttles updates to 200ms to prevent visual flicker.
 *
 * Architecture constraints:
 * - ReadOnly: subscribes to events, does not modify state
 * - Bridge 单向：filters by session ID, no write-back
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup, onMount, type JSX } from "solid-js"
import type { DAGNodeSession } from "@/dag/session/types"
import { useTheme } from "@tui/context/theme"

const MAX_SUMMARY = 50

/**
 * Extracts a human-readable summary from a Part object.
 * Returns null if the part is not displayable (e.g. step-start, file, etc).
 */
export function summarizePart(part: { type: string; [key: string]: unknown }): string | null {
  if (part.type === "text") {
    const text = String(part.text ?? "")
    if (!text) return null
    return text.length > MAX_SUMMARY ? text.slice(0, MAX_SUMMARY) + "\u2026" : text
  }
  if (part.type === "tool") {
    const tool = String(part.tool ?? "")
    const state = String(part.state ?? "")
    if (!tool) return null
    return `[${tool}] ${state}`
  }
  if (part.type === "reasoning") {
    return "reasoning\u2026"
  }
  return null
}

/**
 * LiveTicker component — shows most recent activity in the workflow.
 */
export function LiveTicker(props: {
  event: TuiPluginApi["event"]
  nodes: DAGNodeSession[]
  throttleMs?: number
}): JSX.Element {
  const { theme } = useTheme()
  const throttleMs = () => props.throttleMs ?? 200

  const [summary, setSummary] = createSignal<string | null>(null)
  let timeout: ReturnType<typeof setTimeout> | null = null
  let pending: { type: string; [key: string]: unknown } | null = null

  function flushPending() {
    if (!pending) return
    const s = summarizePart(pending)
    if (s) setSummary(s)
    pending = null
    timeout = null
  }

  onMount(() => {
    const unsub = props.event.on("message.part.updated", (evt) => {
      const sessionIDs = new Set(
        props.nodes
          .map((n) => n.metadata?.chat_session_id)
          .filter((id): id is string => typeof id === "string"),
      )
      if (!sessionIDs.has(evt.properties.sessionID)) return
      pending = evt.properties.part as { type: string; [key: string]: unknown }
      if (!timeout) {
        timeout = setTimeout(flushPending, throttleMs())
      }
    })
    onCleanup(unsub)
  })

  onCleanup(() => {
    if (timeout) clearTimeout(timeout)
  })

  return (
    <box flexDirection="row" paddingLeft={2} paddingRight={2}>
      <text fg={theme.textMuted}>
        {summary() ? (
          <span>
            <text fg={theme.primary}>Live: </text>
            <text>{summary() ?? ""}</text>
          </span>
        ) : (
          <span>Idle</span>
        )}
      </text>
    </box>
  )
}
