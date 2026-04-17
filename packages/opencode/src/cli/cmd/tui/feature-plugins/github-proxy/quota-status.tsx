// quota-status.tsx — 在 session 状态栏显示 GitHub Copilot premium request 配额。
// 通过 auth.json 读取 github-proxy 的 proxyUrl + apiKey，
// 每 60 秒轮询 /copilot/quota 端点，显示格式：「[活跃账号/总账号 | 剩余/总额度]」
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

interface ProxyAuth {
  proxyUrl: string
  apiKey: string
}

interface QuotaInfo {
  remaining: number
  entitlement: number
  accounts_active: number
  accounts_total: number
}

async function readProxyAuth(): Promise<ProxyAuth | null> {
  try {
    const authPath = path.join(Global.Path.data, "auth.json")
    const text = await readFile(authPath, "utf-8")
    const data = JSON.parse(text) as Record<string, unknown>
    const entry = data["github-proxy"] as Record<string, unknown> | undefined
    if (!entry || entry.type !== "api") return null
    const meta = entry.metadata as Record<string, string> | undefined
    const proxyUrl = meta?.proxyUrl
    const apiKey = entry.key as string | undefined
    if (!proxyUrl || !apiKey) return null
    return { proxyUrl, apiKey }
  } catch {
    return null
  }
}

async function fetchQuota(auth: ProxyAuth): Promise<QuotaInfo | null> {
  try {
    const url = `${auth.proxyUrl.replace(/\/+$/, "")}/copilot/quota`
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${auth.apiKey}` },
      signal: AbortSignal.timeout(5_000),
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as Record<string, unknown>
    const remaining = typeof data.remaining === "number" ? data.remaining : null
    const entitlement = typeof data.entitlement === "number" ? data.entitlement : null
    if (remaining === null || entitlement === null) return null
    return {
      remaining,
      entitlement,
      accounts_active: typeof data.accounts_active === "number" ? data.accounts_active : 0,
      accounts_total: typeof data.accounts_total === "number" ? data.accounts_total : 0,
    }
  } catch {
    return null
  }
}

function QuotaView(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const [label, setLabel] = createSignal("⊘ …")
  const [color, setColor] = createSignal(() => theme().textMuted)
  const [proxyAuth, setProxyAuth] = createSignal<ProxyAuth | null>(null)

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
  readProxyAuth().then((auth) => {
    if (!auth) {
      setLabel("")
      return
    }
    setProxyAuth(auth)
    fetchQuota(auth).then((q) => {
      if (q) applyQuota(q)
      else setLabel("")
    })
  })

  // 每 60 秒刷新一次
  const timer = setInterval(async () => {
    const auth = proxyAuth()
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
