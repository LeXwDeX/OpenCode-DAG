// quota-status.tsx — 在 session 状态栏显示 GitHub Copilot premium request 配额。
// 支持 github-proxy（通过 proxyUrl + apiKey）和 github-copilot（通过 OAuth token）两种模式。
// 每 60 秒轮询配额端点，显示格式：「[活跃账号/总账号 | 剩余/总额度]」或「⊘ 剩余/总额度」
//
// 重要：opentui Slot 系统在初始渲染时检查输出是否为空，
// 若初始渲染返回 null 则该插件条目会被永久跳过。
// 因此本组件在数据就绪前显示 "⊘ …" 占位，确保初始渲染非空。
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup } from "solid-js"
import { Global } from "@/global"
import path from "path"
import { readFile } from "fs/promises"

const id = "internal:github-proxy-quota"

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

async function readQuotaAuth(): Promise<QuotaAuth | null> {
  try {
    const authPath = path.join(Global.Path.data, "auth.json")
    const text = await readFile(authPath, "utf-8")
    const data = JSON.parse(text) as Record<string, unknown>

    // Try github-proxy first (has proxyUrl with dedicated /copilot/quota endpoint)
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

    // Fall back to github-copilot (direct mode, query GitHub API for quota)
    const copilotEntry = data["github-copilot"] as Record<string, unknown> | undefined
    if (copilotEntry?.type === "oauth") {
      const refresh = copilotEntry.refresh as string | undefined
      if (refresh) {
        // Enterprise 场景使用不同的 API 域名
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

/** 从 GitHub Copilot API 响应中解析 quota 信息 */
function parseCopilotQuota(data: Record<string, unknown>): QuotaInfo | null {
  // GitHub /copilot_internal/user 返回格式：
  // { "quotaSnapshots": { "premiumInteractions": { "percentRemaining": 95, ... } }, ... }
  const snapshots = data.quotaSnapshots as Record<string, unknown> | undefined
  const premium = snapshots?.premiumInteractions as Record<string, unknown> | undefined
  if (!premium) return null

  const percentRemaining = typeof premium.percentRemaining === "number" ? premium.percentRemaining : null
  if (percentRemaining === null) return null

  // 将百分比转换为与 proxy 格式统一的 entitlement/remaining 数值
  // entitlement = 100（代表 100%），remaining = percentRemaining
  return {
    remaining: 100 - percentRemaining,
    entitlement: 100,
    accounts_active: 0,
    accounts_total: 0,
  }
}

/** 从 github-proxy 自定义端点响应中解析 quota 信息 */
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

    if (auth.provider === "github-copilot") return parseCopilotQuota(data)
    return parseProxyQuota(data)
  } catch {
    return null
  }
}

function QuotaView(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const [label, setLabel] = createSignal("⊘ …")
  const [color, setColor] = createSignal(() => theme().textMuted)
  const [quotaAuth, setQuotaAuth] = createSignal<QuotaAuth | null>(null)

  function applyQuota(q: QuotaInfo) {
    // 后端 remaining 字段实际是 used（已用量），需翻转为真正的剩余量
    const actual = q.entitlement - q.remaining
    const pct = Math.round((actual / Math.max(q.entitlement, 1)) * 100)
    setColor(() => () => pct > 30 ? theme().success : pct > 10 ? theme().warning : theme().error)
    if (q.accounts_total > 0) {
      setLabel(`[${q.accounts_active}/${q.accounts_total} | ${actual}/${q.entitlement}]`)
    } else {
      setLabel(`⊘ ${actual}/${q.entitlement}`)
    }
  }

  // 启动时读取一次 auth，成功后立即拉取 quota
  readQuotaAuth().then((auth) => {
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

  // 每 60 秒刷新一次
  const timer = setInterval(async () => {
    const auth = quotaAuth()
    if (!auth) return
    const q = await fetchQuota(auth)
    if (q) applyQuota(q)
  }, 60_000)
  onCleanup(() => clearInterval(timer))

  // 注意：必须在初始渲染时返回非空内容（哪怕只是占位符），
  // 否则 opentui Slot 系统会将本插件判定为"无输出"并永久跳过。
  return (
    <text>
      <span style={{ fg: color()() }}>{label()}</span>
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
