// view.tsx — 在 session prompt 右侧显示 Copilot premium request 配额。
//
// Provider 选择策略：
//   从当前 session 最后一条 AssistantMessage 取 providerID（响应式）；
//   无消息时降级到 config.model 解析的 providerID；
//   启用判定：isCopilotMode(providerID)。
//
// 端点选择：
//   优先读 api.state.config.provider["github-copilot"]，由 resolveEndpoint
//   决定走代理（provider.api 存在）还是原厂 api.github.com。
//
// 颜色规则（按已用量绝对值）：
//   used ≤ 100 → success（绿）；≤ 200 → warning（黄）；> 200 → error（红）
//
// 重要：opentui Slot 在初始渲染时若返回空内容，会永久跳过本插件。
// 因此组件在数据就绪前显示 "⊘ …" 占位。
import path from "node:path"
import { readFile } from "node:fs/promises"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { Global } from "@opencode-ai/core/global"
import { isCopilotMode } from "./enabled"
import { resolveEndpoint, type AuthEntrySlice, type ProviderConfigSlice } from "./endpoint"
import { fetchQuota, type QuotaInfo } from "./fetch"

const id = "internal:session-quota"

async function readCopilotAuthEntry(stateDir: string): Promise<AuthEntrySlice | undefined> {
  try {
    const text = await readFile(path.join(stateDir, "auth.json"), "utf-8")
    const data = JSON.parse(text) as Record<string, unknown>
    const raw = data["github-copilot"] as Record<string, unknown> | undefined
    if (!raw || typeof raw.type !== "string") return undefined
    const refresh = typeof raw.refresh === "string" ? raw.refresh : undefined
    const enterpriseUrl = typeof raw.enterpriseUrl === "string" ? raw.enterpriseUrl : undefined
    return { type: raw.type, refresh, enterpriseUrl }
  } catch {
    return undefined
  }
}

function readCopilotProviderConfig(api: TuiPluginApi): ProviderConfigSlice | undefined {
  const raw = api.state.config.provider?.["github-copilot"]
  if (!raw) return undefined
  const apiUrl = typeof raw.api === "string" ? raw.api : undefined
  const rawApiKey = raw.options?.apiKey
  const apiKey = typeof rawApiKey === "string" ? rawApiKey : undefined
  return { api: apiUrl, options: { apiKey } }
}

export function QuotaView(props: { api: TuiPluginApi; session_id: string }) {
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

  // 版本号 guard：providerID 切换或新一轮 refresh 启动时，旧的 in-flight
  // 请求 resolve 后会被丢弃，避免用过期数据覆盖当前 provider 的显示。
  let refreshSeq = 0
  async function refresh() {
    const seq = ++refreshSeq
    const pid = providerID()
    if (!pid || !isCopilotMode(pid)) {
      setLabel("")
      return
    }
    const providerConfig = readCopilotProviderConfig(props.api)
    // 注意：auth.json 位于 Global.Path.data（XDG_DATA_HOME），
    // 不能用 props.api.state.path.state（XDG_STATE_HOME），二者是不同目录。
    const authEntry = await readCopilotAuthEntry(Global.Path.data)
    if (seq !== refreshSeq) return
    const endpoint = resolveEndpoint({ providerConfig, authEntry })
    if (!endpoint) {
      console.debug(`[quota] resolveEndpoint null providerID=${pid}`)
      setLabel("")
      return
    }
    const q = await fetchQuota(endpoint)
    if (seq !== refreshSeq) return
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
