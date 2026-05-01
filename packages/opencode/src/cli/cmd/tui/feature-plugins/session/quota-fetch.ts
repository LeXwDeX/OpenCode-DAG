// quota-fetch.ts — quota.tsx 的纯逻辑分支：读取 auth.json、解析两种上游响应、HTTP 取数。
// 抽离动机：与 Solid/opentui 渲染解耦，便于在 Bun test 中直接覆盖（避免拉入原生 opentui binding）。
import path from "node:path"
import { readFile } from "node:fs/promises"

export interface QuotaAuth {
  quotaUrl: string
  token: string
  provider: "github-proxy" | "github-copilot"
  /** github-copilot 直连模式也使用 "Bearer <refresh>" 认证头格式（与 copilot plugin 一致） */
  authHeaderPrefix: "Bearer"
}

export interface QuotaInfo {
  remaining: number
  entitlement: number
  accounts_active: number
  accounts_total: number
}

export async function readQuotaAuth(stateDir: string): Promise<QuotaAuth | null> {
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
          authHeaderPrefix: "Bearer",
        }
      }
    }

    return null
  } catch {
    return null
  }
}

/** 从 GitHub Copilot API 响应解析 quota（百分比模式） */
export function parseCopilotQuota(data: Record<string, unknown>): QuotaInfo | null {
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
export function parseProxyQuota(data: Record<string, unknown>): QuotaInfo | null {
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

export async function fetchQuota(auth: QuotaAuth): Promise<QuotaInfo | null> {
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
