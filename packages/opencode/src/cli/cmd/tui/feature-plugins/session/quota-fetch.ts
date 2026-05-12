// quota-fetch.ts — quota.tsx 的纯逻辑分支：读取 auth.json、解析上游响应、HTTP 取数。
// 抽离动机：与 Solid/opentui 渲染解耦，便于在 Bun test 中直接覆盖（避免拉入原生 opentui binding）。
import path from "node:path"
import { readFile } from "node:fs/promises"

export interface QuotaAuth {
  quotaUrl: string
  token: string
  provider: "github-copilot"
}

export interface QuotaInfo {
  /** 已用量（consumed count）。由 entitlement-remaining 换算 */
  used: number
  entitlement: number
  accounts_active: number
  accounts_total: number
}

/**
 * 按 providerID 精确读取对应的 QuotaAuth。
 * providerID 以 "github-copilot" 开头即可（支持子变体）。
 */
export async function readQuotaAuthForProvider(
  stateDir: string,
  providerID: string,
): Promise<QuotaAuth | null> {
  try {
    const text = await readFile(path.join(stateDir, "auth.json"), "utf-8")
    const data = JSON.parse(text) as Record<string, unknown>

    if (providerID.startsWith("github-copilot")) {
      const entry = data["github-copilot"] as Record<string, unknown> | undefined
      if (entry?.type === "oauth") {
        const refresh = entry.refresh as string | undefined
        if (refresh) {
          const enterpriseUrl = entry.enterpriseUrl as string | undefined
          const apiBase = enterpriseUrl
            ? `https://api.${enterpriseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}`
            : "https://api.github.com"
          return {
            quotaUrl: `${apiBase}/copilot_internal/user`,
            token: refresh,
            provider: "github-copilot",
          }
        }
      }
      return null
    }

    return null
  } catch {
    return null
  }
}

/** 从 GitHub Copilot API 响应解析 quota（snake_case 字段） */
export function parseCopilotQuota(data: Record<string, unknown>): QuotaInfo | null {
  const snapshots = data.quota_snapshots as Record<string, unknown> | undefined
  const premium = snapshots?.premium_interactions as Record<string, unknown> | undefined
  if (!premium) return null

  const actualRemaining = typeof premium.remaining === "number" ? premium.remaining : null
  const entitlement = typeof premium.entitlement === "number" ? premium.entitlement : null
  if (actualRemaining === null || entitlement === null) return null

  // GitHub API 返回「剩余量」，换算为「已用量」
  return { used: entitlement - actualRemaining, entitlement, accounts_active: 0, accounts_total: 0 }
}

export async function fetchQuota(auth: QuotaAuth): Promise<QuotaInfo | null> {
  try {
    const resp = await fetch(auth.quotaUrl, {
      headers: { Authorization: `Bearer ${auth.token}` },
      signal: AbortSignal.timeout(2_000),
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as Record<string, unknown>
    return parseCopilotQuota(data)
  } catch {
    return null
  }
}
