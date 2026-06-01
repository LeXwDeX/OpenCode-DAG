// view.tsx — 在 session prompt 右侧显示 Copilot premium request 配额。
//
// 设计原则（参考 f32284cf8b 老版本）：
//   不依赖 providerID / 会话 messages — 只看 auth.json 与 config.provider 是否能
//   解析出有效 endpoint，能就显示，不能就空字符串。这样无论用户处于什么 provider
//   下，只要装了 github-copilot 凭据就能看到额度。
//
// 端点选择：
//   provider.github-copilot.api 存在 → 走代理 ${api}/quota（扁平 schema）
//   否则走 GitHub 原厂 /copilot_internal/user（嵌套 schema）
//
// 颜色规则（按已用量百分比）：
//   unlimited → success（绿）+ "∞"
//   used/entitlement ≤ 50% → success（绿）；≤ 80% → warning（黄）；> 80% → error（红）
// 显示格式：
//   credits 模式：$X.XX/$Y.YY（1 credit = $0.01）
//   pru 模式：used/entitlement（原格式）
//   unlimited：∞ credits 或 ∞
//
// 重要：opentui Slot 在初始渲染时若返回空内容，会永久跳过本插件。
// 因此组件在数据就绪前显示 "⊘ …" 占位。
import path from "node:path"
import { readFile } from "node:fs/promises"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup } from "solid-js"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { resolveEndpoint, type AuthEntrySlice, type ProviderConfigSlice } from "./endpoint"
import { fetchQuota, type QuotaInfo } from "./fetch"

const id = "internal:session-quota"
const log = Log.create({ service: "tui.quota" })

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
  // 兼容两种 schema：
  //   1) 顶层 `api`（老式 / 直接 endpoint 字段）
  //   2) `options.baseURL`（ai-sdk OpenAI-compatible 标准字段，用户实际使用）
  // 任一存在即视作 proxy 模式根 URL，由 endpoint.ts 拼 `/quota`。
  const topApi = typeof raw.api === "string" ? raw.api : undefined
  const baseURL = typeof raw.options?.baseURL === "string" ? raw.options.baseURL : undefined
  const apiUrl = topApi ?? baseURL
  const rawApiKey = raw.options?.apiKey
  const apiKey = typeof rawApiKey === "string" ? rawApiKey : undefined
  return { api: apiUrl?.replace(/\/+$/, ""), options: { apiKey } }
}

export function QuotaView(props: { api: TuiPluginApi }) {
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

  function applyQuota(q: QuotaInfo) {
    if (q.unlimited) {
      setTone("success")
      const label = q.billing === "credits" ? "∞ credits" : "∞"
      if (q.accounts_total > 0) {
        setLabel(`[${q.accounts_active}/${q.accounts_total} | ${label}]`)
      } else {
        setLabel(`⊘ ${label}`)
      }
      return
    }

    const pct = q.entitlement > 0 ? q.used / q.entitlement : 1
    setTone(pct <= 0.5 ? "success" : pct <= 0.8 ? "warning" : "error")

    const formatValue = q.billing === "credits"
      ? `$${(q.used * 0.01).toFixed(2)}/$${(q.entitlement * 0.01).toFixed(2)}`
      : `${q.used}/${q.entitlement}`

    if (q.accounts_total > 0) {
      setLabel(`[${q.accounts_active}/${q.accounts_total} | ${formatValue}]`)
    } else {
      setLabel(`⊘ ${formatValue}`)
    }
  }

  let refreshSeq = 0
  async function refresh() {
    const seq = ++refreshSeq
    const providerConfig = readCopilotProviderConfig(props.api)
    // 内网代理 + apiKey 齐备 → 仅走 proxy 分支，auth.json 不影响结果，省一次 I/O。
    // 外网模式（无 baseURL）或 proxy 模式缺 apiKey 时仍需 OAuth refresh token，必须读 auth.json。
    // 注意：auth.json 位于 Global.Path.data（XDG_DATA_HOME），
    // 不能用 props.api.state.path.state（XDG_STATE_HOME），二者是不同目录。
    const proxyWithKey = !!(providerConfig?.api && providerConfig.options?.apiKey)
    const authEntry = proxyWithKey ? undefined : await readCopilotAuthEntry(Global.Path.data)
    if (seq !== refreshSeq) return
    const endpoint = resolveEndpoint({ providerConfig, authEntry })
    if (!endpoint) {
      log.debug("refresh.skip endpoint null", {
        has_providerConfig: !!providerConfig,
        has_authEntry: !!authEntry,
        auth_type: authEntry?.type ?? "<none>",
      })
      setLabel("")
      return
    }
    log.debug("refresh.fetch", { mode: endpoint.mode, url: endpoint.url })
    const q = await fetchQuota(endpoint)
    if (seq !== refreshSeq) return
    if (q) {
      log.debug("refresh.ok", { used: q.used, entitlement: q.entitlement })
      applyQuota(q)
    } else {
      log.debug("refresh.skip fetchQuota null", { mode: endpoint.mode })
      setLabel("")
    }
  }

  // 首次挂载立即拉取
  void refresh()
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
  log.info("plugin tui() called", { id })
  api.slots.register({
    order: 100,
    slots: {
      session_prompt_right() {
        return <QuotaView api={api} />
      },
    },
  })
  log.info("plugin slot registered", { id, slot: "session_prompt_right" })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
