// quota.tsx — 在 session prompt 右侧显示 Copilot premium request 配额。
//
// Provider 选择策略：
//   从当前 session 最后一条 AssistantMessage 取 providerID（响应式）；
//   无消息时降级到 config.model 解析的 providerID；
//   按 providerID 精确读取对应 auth，不再依次尝试所有来源。
//
// 颜色规则（按已用量绝对值）：
//   used ≤ 100 → success（绿）；≤ 200 → warning（黄）；> 200 → error（红）
//
// 重要：opentui Slot 在初始渲染时若返回空内容，会永久跳过本插件。
// 因此组件在数据就绪前显示 "⊘ …" 占位。
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { Global } from "@opencode-ai/core/global"
import { fetchQuota, readQuotaAuthForProvider, type QuotaInfo } from "./quota-fetch"

const id = "internal:session-quota"

function QuotaView(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const [label, setLabel] = createSignal("⊘ …")
  const [tone, setTone] = createSignal<"muted" | "success" | "warning" | "error">("muted")
  const color = () => {
    const t = theme()
    switch (tone()) {
      case "success":
        return t.success
      case "warning":
        return t.warning
      case "error":
        return t.error
      default:
        return t.textMuted
    }
  }

  // 从最后一条 AssistantMessage 取 providerID；无消息时从 config.model 解析
  const providerID = createMemo(() => {
    const messages = props.api.state.session.messages(props.session_id)
    const last = messages.findLast((m): m is AssistantMessage => m.role === "assistant")
    if (last) return last.providerID
    const configModel = props.api.state.config.model ?? ""
    const slash = configModel.indexOf("/")
    return slash > 0 ? configModel.slice(0, slash) : configModel
  })

  function applyQuota(q: QuotaInfo) {
    // q.used 是已消费量，直接用于显示和颜色判断
    setTone(q.used <= 100 ? "success" : q.used <= 200 ? "warning" : "error")
    if (q.accounts_total > 0) {
      setLabel(`[${q.accounts_active}/${q.accounts_total} | ${q.used}/${q.entitlement}]`)
    } else {
      setLabel(`⊘ ${q.used}/${q.entitlement}`)
    }
  }

  async function refresh() {
    const pid = providerID()
    if (!pid) return
    // 注意：auth.json 位于 Global.Path.data（XDG_DATA_HOME），
    // 不能用 props.api.state.path.state（XDG_STATE_HOME），二者是不同目录。
    const auth = await readQuotaAuthForProvider(Global.Path.data, pid)
    if (!auth) {
      setLabel("")
      return
    }
    const q = await fetchQuota(auth)
    if (q) applyQuota(q)
    else setLabel("")
  }

  // providerID 变化时立即重新拉取（含首次挂载）
  createEffect(() => {
    void refresh()
  })

  // 每 60 秒刷新一次
  const timer = setInterval(() => void refresh(), 60_000)
  onCleanup(() => clearInterval(timer))

  // 必须返回非空内容（即使是占位符），否则 opentui Slot 永久跳过本插件
  return (
    <text>
      <span style={{ fg: color() }}>{label()}</span>
    </text>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      session_prompt_right(_ctx, props) {
        return <QuotaView api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
