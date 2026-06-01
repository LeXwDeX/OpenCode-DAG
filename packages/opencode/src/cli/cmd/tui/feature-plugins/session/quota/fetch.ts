// fetch.ts — 按解析好的 EndpointDecision 取 quota + 解析响应。
// 两种 schema（按优先级）：
//   1. GitHub 原厂 schema：quota_snapshots.ai_credits | premium_interactions（proxy 透传 + official 均使用）
//   2. 旧版 proxy 聚合 schema：{remaining, entitlement, accounts_active, accounts_total}（兼容老 proxy）
// 保持原 2s timeout、status!=200 返 null、catch 静默返 null 的语义。
import type { EndpointDecision } from "./endpoint"

export interface QuotaInfo {
  /** 已用量（consumed count），由 entitlement-remaining 换算 */
  used: number
  entitlement: number
  /** 仅 proxy 模式有意义；official 模式恒为 0，由 view 层从 auth.json 估算 */
  accounts_active: number
  accounts_total: number
  mode: "proxy" | "official"
  /** "credits" for new AI Credits billing (post June 2026), "pru" for legacy Premium Request Units */
  billing: "credits" | "pru"
}

/** 原厂 schema：GitHub /copilot_internal/user → data.quota_snapshots.premium_interactions */
export function parseCopilotOfficial(data: Record<string, unknown>): Omit<QuotaInfo, "mode"> | null {
  const snapshots = data.quota_snapshots as Record<string, unknown> | undefined
  if (!snapshots) return null

  // Try new AI Credits schema first (post June 2026)
  const credits = snapshots.ai_credits as Record<string, unknown> | undefined
  if (credits) {
    const remaining = typeof credits.remaining === "number" ? credits.remaining : null
    const entitlement = typeof credits.entitlement === "number" ? credits.entitlement : null
    if (remaining !== null && entitlement !== null) {
      return { used: entitlement - remaining, entitlement, accounts_active: 0, accounts_total: 0, billing: "credits" }
    }
  }

  // Fall back to legacy PRU schema (annual plan users)
  const premium = snapshots.premium_interactions as Record<string, unknown> | undefined
  if (!premium) return null

  const remaining = typeof premium.remaining === "number" ? premium.remaining : null
  const entitlement = typeof premium.entitlement === "number" ? premium.entitlement : null
  if (remaining === null || entitlement === null) return null

  return { used: entitlement - remaining, entitlement, accounts_active: 0, accounts_total: 0, billing: "pru" }
}

/** 代理聚合 schema：LLMS-proxy /copilot/quota → 扁平 {remaining, entitlement, accounts_active, accounts_total} */
export function parseProxyAggregate(data: Record<string, unknown>): Omit<QuotaInfo, "mode"> | null {
  const remaining = typeof data.remaining === "number" ? data.remaining : null
  const entitlement = typeof data.entitlement === "number" ? data.entitlement : null
  if (remaining === null || entitlement === null) return null

  const active = typeof data.accounts_active === "number" ? data.accounts_active : 0
  const total = typeof data.accounts_total === "number" ? data.accounts_total : 0

  // Detect billing model: explicit field from proxy, or heuristic based on entitlement scale
  // PRU entitlements are typically 300-1500; AI credits are 1500-20000
  const billingModel = typeof data.billing === "string" && (data.billing === "credits" || data.billing === "pru")
    ? data.billing
    : entitlement > 1500 ? "credits" : "pru"

  return { used: entitlement - remaining, entitlement, accounts_active: active, accounts_total: total, billing: billingModel }
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
    // 优先尝试 GitHub 原厂 schema（proxy 现已透传 GitHub 响应）
    // 回退到旧 proxy 聚合 schema（兼容老版本 proxy）
    const parsed = parseCopilotOfficial(data) ?? parseProxyAggregate(data)
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
