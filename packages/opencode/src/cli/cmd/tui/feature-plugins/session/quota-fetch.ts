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

export async function readQuotaAuths(stateDir: string): Promise<QuotaAuth[]> {
  try {
    const text = await readFile(path.join(stateDir, "auth.json"), "utf-8")
    const data = JSON.parse(text) as Record<string, unknown>
    const result: QuotaAuth[] = []

    // 优先：github-proxy（带 proxyUrl 的内置 /copilot/quota 端点）
    const proxyEntry = data["github-proxy"] as Record<string, unknown> | undefined
    if (proxyEntry?.type === "api") {
      const meta = proxyEntry.metadata as Record<string, string> | undefined
      const proxyUrl = meta?.proxyUrl
      const apiKey = proxyEntry.key as string | undefined
      if (proxyUrl && apiKey) {
        result.push({
          quotaUrl: `${proxyUrl.replace(/\/+$/, "")}/copilot/quota`,
          token: apiKey,
          provider: "github-proxy",
          authHeaderPrefix: "Bearer",
        })
      }
    }

    // 备选：github-copilot 直连模式（GitHub API 取 quota）
    const copilotEntry = data["github-copilot"] as Record<string, unknown> | undefined
    if (copilotEntry?.type === "oauth") {
      const refresh = copilotEntry.refresh as string | undefined
      if (refresh) {
        const enterpriseUrl = copilotEntry.enterpriseUrl as string | undefined
        const apiBase = enterpriseUrl
          ? `https://api.${enterpriseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}`
          : "https://api.github.com"
        result.push({
          quotaUrl: `${apiBase}/copilot_internal/user`,
          token: refresh,
          provider: "github-copilot",
          authHeaderPrefix: "Bearer",
        })
      }
    }

    return result
  } catch {
    return []
  }
}

/** 从 GitHub Copilot API 响应解析 quota（snake_case 字段，直连 GitHub API） */
export function parseCopilotQuota(data: Record<string, unknown>): QuotaInfo | null {
  const snapshots = data.quota_snapshots as Record<string, unknown> | undefined
  const premium = snapshots?.premium_interactions as Record<string, unknown> | undefined
  if (!premium) return null

  const actualRemaining = typeof premium.remaining === "number" ? premium.remaining : null
  const entitlement = typeof premium.entitlement === "number" ? premium.entitlement : null
  if (actualRemaining === null || entitlement === null) return null

  // 归一化：QuotaInfo.remaining 存的是「已用量」，与 proxy 格式保持一致
  // GitHub API 返回的 remaining 是「剩余量」，需翻转
  return {
    remaining: entitlement - actualRemaining,
    entitlement,
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

export async function fetchQuota(auths: QuotaAuth[]): Promise<QuotaInfo | null> {
  for (const auth of auths) {
    try {
      const resp = await fetch(auth.quotaUrl, {
        headers: { Authorization: `${auth.authHeaderPrefix} ${auth.token}` },
        signal: AbortSignal.timeout(5_000),
      })
      if (!resp.ok) continue
      const data = (await resp.json()) as Record<string, unknown>
      const info = auth.provider === "github-copilot" ? parseCopilotQuota(data) : parseProxyQuota(data)
      if (info) return info
    } catch {
      // 继续尝试下一个
    }
  }
  return null
}
