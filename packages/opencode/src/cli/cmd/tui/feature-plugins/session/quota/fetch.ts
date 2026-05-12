// fetch.ts — 按解析好的 EndpointDecision 取 quota + 解析响应。
// 两种 schema：
//   official: GitHub /copilot_internal/user → data.quota_snapshots.premium_interactions.{remaining, entitlement}
//   proxy:    LLMS-proxy /copilot/quota     → {remaining, entitlement, accounts_active, accounts_total}（扁平聚合）
// 保持原 2s timeout、status!=200 返 null、catch 静默返 null 的语义。
// 三条路径（成功/失败/timeout）各打一行 console.debug，带 mode + url，不打 token。
import type { EndpointDecision } from "./endpoint"

export interface QuotaInfo {
  /** 已用量（consumed count），由 entitlement-remaining 换算 */
  used: number
  entitlement: number
  /** 仅 proxy 模式有意义；official 模式恒为 0，由 view 层从 auth.json 估算 */
  accounts_active: number
  accounts_total: number
  mode: "proxy" | "official"
}

/** 原厂 schema：GitHub /copilot_internal/user → data.quota_snapshots.premium_interactions */
export function parseCopilotOfficial(data: Record<string, unknown>): Omit<QuotaInfo, "mode"> | null {
  const snapshots = data.quota_snapshots as Record<string, unknown> | undefined
  const premium = snapshots?.premium_interactions as Record<string, unknown> | undefined
  if (!premium) return null

  const remaining = typeof premium.remaining === "number" ? premium.remaining : null
  const entitlement = typeof premium.entitlement === "number" ? premium.entitlement : null
  if (remaining === null || entitlement === null) return null

  return { used: entitlement - remaining, entitlement, accounts_active: 0, accounts_total: 0 }
}

/** 代理聚合 schema：LLMS-proxy /copilot/quota → 扁平 {remaining, entitlement, accounts_active, accounts_total} */
export function parseProxyAggregate(data: Record<string, unknown>): Omit<QuotaInfo, "mode"> | null {
  const remaining = typeof data.remaining === "number" ? data.remaining : null
  const entitlement = typeof data.entitlement === "number" ? data.entitlement : null
  if (remaining === null || entitlement === null) return null

  const active = typeof data.accounts_active === "number" ? data.accounts_active : 0
  const total = typeof data.accounts_total === "number" ? data.accounts_total : 0
  return { used: entitlement - remaining, entitlement, accounts_active: active, accounts_total: total }
}

export async function fetchQuota(endpoint: EndpointDecision): Promise<QuotaInfo | null> {
  try {
    const resp = await fetch(endpoint.url, {
      headers: { Authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(2_000),
    })
    if (!resp.ok) {
      console.debug(`[quota] fetch non-2xx mode=${endpoint.mode} url=${endpoint.url} status=${resp.status}`)
      return null
    }
    const data = (await resp.json()) as Record<string, unknown>
    const parsed = endpoint.mode === "proxy" ? parseProxyAggregate(data) : parseCopilotOfficial(data)
    console.debug(
      `[quota] fetch ok mode=${endpoint.mode} url=${endpoint.url} parsed=${parsed ? "yes" : "no"}`,
    )
    return parsed ? { ...parsed, mode: endpoint.mode } : null
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error"
    const msg = err instanceof Error ? err.message : String(err)
    console.debug(`[quota] fetch error mode=${endpoint.mode} url=${endpoint.url} err=${name}:${msg}`)
    return null
  }
}
