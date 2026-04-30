// quota.tsx — 在 session prompt 右侧显示 Copilot premium request 配额。
// 支持两种 auth 来源：
//  1. github-proxy（type:"api"，metadata.proxyUrl + key 走 /copilot/quota）
//  2. github-copilot（type:"oauth"，refresh token 走 GitHub /copilot_internal/user）
//
// 重要：opentui Slot 在初始渲染时若返回空内容，会永久跳过本插件。
// 因此组件在数据就绪前显示 "⊘ …" 占位。
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup } from "solid-js"
import path from "node:path"
import { readFile } from "node:fs/promises"

const id = "internal:session-quota"

interface QuotaAuth {
  quotaUrl: string
  token: string
  provider: "github-proxy" | "github-copilot"
  /** github-copilot 直连模式使用 "token <gho>" 认证头格式 */
  authHeaderPrefix: "Bearer" | "token"
}

interface QuotaInfo {
  remaining: number
  entitlement: number
  accounts_active: number
  accounts_total: number
}

async function readQuotaAuth(stateDir: string): Promise<QuotaAuth | null> {
  try {
    const text = await readFile(path.join(stateDir, "auth.json"), "utf-8")
    const data = JSON.parse(text) as Record<string, unknown>

    // 优先：github-proxy（带 proxyUrl 的内置 /copilot/quota 端点）
    const proxyEntry = data["github-proxy"] as Record<string, unknown> | undefined
    if (proxyEntry?.type === "api") {
      const meta = proxyEntry.metadata as Record<string, string> | undefined
      const proxyUrl = meta?.proxyUrl
      const apiKey = proxyEntry.key as string | undefined
      if (proxyUrl && apiKey) {
        return {
          quotaUrl: `${proxyUrl.replace(/\/+$/, "")}/copilot/quota`,
          token: apiKey,
          provider: "github-proxy",
          authHeaderPrefix: "Bearer",
        }
      }
    }

    // 回退：github-copilot 直连模式（GitHub API 取 quota）
    const copilotEntry = data["github-copilot"] as Record<string, unknown> | undefined
    if (copilotEntry?.type === "oauth") {
      const refresh = copilotEntry.refresh as string | undefined
      if (refresh) {
        const enterpriseUrl = copilotEntry.enterpriseUrl as string | undefined
        const apiBase = enterpriseUrl
          ? `https://api.${enterpriseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}`
          : "https://api.github.com"
        return {
          quotaUrl: `${apiBase}/copilot_internal/user`,
          token: refresh,
          provider: "github-copilot",
          authHeaderPrefix: "token",
        }
      }
    }

    return null
  } catch {
    return null
  }
}

/** 从 GitHub Copilot API 响应解析 quota（百分比模式） */
function parseCopilotQuota(data: Record<string, unknown>): QuotaInfo | null {
  const snapshots = data.quotaSnapshots as Record<string, unknown> | undefined
  const premium = snapshots?.premiumInteractions as Record<string, unknown> | undefined
  if (!premium) return null

  const percentRemaining = typeof premium.percentRemaining === "number" ? premium.percentRemaining : null
  if (percentRemaining === null) return null

  // 百分比转 entitlement/remaining 数值，与 proxy 格式统一
  return {
    remaining: 100 - percentRemaining,
    entitlement: 100,
    accounts_active: 0,
    accounts_total: 0,
  }
}

/** 从 github-proxy 自定义 /copilot/quota 端点响应解析 */
function parseProxyQuota(data: Record<string, unknown>): QuotaInfo | null {
  const remaining = typeof data.remaining === "number" ? data.remaining : null
  const entitlement = typeof data.entitlement === "number" ? data.entitlement : null
  if (remaining === null || entitlement === null) return null
  return {
    remaining,
    entitlement,
    accounts_active: typeof data.accounts_active === "number" ? data.accounts_active : 0,
    accounts_total: typeof data.accounts_total === "number" ? data.accounts_total : 0,
  }
}

async function fetchQuota(auth: QuotaAuth): Promise<QuotaInfo | null> {
  try {
    const resp = await fetch(auth.quotaUrl, {
      headers: { Authorization: `${auth.authHeaderPrefix} ${auth.token}` },
      signal: AbortSignal.timeout(5_000),
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as Record<string, unknown>
    return auth.provider === "github-copilot" ? parseCopilotQuota(data) : parseProxyQuota(data)
  } catch {
    return null
  }
}

function QuotaView(props: { api: TuiPluginApi }) {
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
  const [quotaAuth, setQuotaAuth] = createSignal<QuotaAuth | null>(null)

  function applyQuota(q: QuotaInfo) {
    // 后端 remaining 字段实际是 used（已用量），需翻转为真正的剩余量
    const actual = q.entitlement - q.remaining
    const pct = Math.round((actual / Math.max(q.entitlement, 1)) * 100)
    setTone(pct > 30 ? "success" : pct > 10 ? "warning" : "error")
    if (q.accounts_total > 0) {
      setLabel(`[${q.accounts_active}/${q.accounts_total} | ${actual}/${q.entitlement}]`)
    } else {
      setLabel(`⊘ ${actual}/${q.entitlement}`)
    }
  }

  // 启动：读 auth → 首次拉取
  readQuotaAuth(props.api.state.path.state).then((auth) => {
    if (!auth) {
      setLabel("")
      return
    }
    setQuotaAuth(auth)
    fetchQuota(auth).then((q) => {
      if (q) applyQuota(q)
      else setLabel("")
    })
  })

  // 每 60 秒刷新
  const timer = setInterval(async () => {
    const auth = quotaAuth()
    if (!auth) return
    const q = await fetchQuota(auth)
    if (q) applyQuota(q)
  }, 60_000)
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
      session_prompt_right() {
        return <QuotaView api={api} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
