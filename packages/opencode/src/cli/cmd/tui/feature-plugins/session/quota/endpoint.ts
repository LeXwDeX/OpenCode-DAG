// endpoint.ts — Copilot quota 端点解析，纯函数。
//
// 决策表（spec）：
//   provider.api 非空 + options.apiKey 非空            → proxy，token=apiKey，url=${api}/quota（聚合）
//   provider.api 非空 + options.apiKey 空 + oauth      → proxy，token=refresh，url=${api}/quota
//   provider.api 非空 + options.apiKey 空 + 无 auth    → null
//   无 provider.api + oauth（无 enterpriseUrl）        → official，url=api.github.com/copilot_internal/user
//   无 provider.api + oauth（有 enterpriseUrl）        → official，url=api.<host>/copilot_internal/user
//   无 provider.api + 无 auth                          → null
//
// 注意：
//  - proxy 模式打代理的聚合接口 /copilot/quota，返回 {remaining, entitlement, accounts_active, accounts_total}
//  - official 模式打 GitHub 原厂 /copilot_internal/user，返回嵌套 data.quota_snapshots.premium_interactions
//  - 不做尾斜杠规范化 —— 调用方保证 api 字段不带尾 "/"
export interface EndpointDecision {
  url: string
  token: string
  mode: "proxy" | "official"
  account?: string
}

export interface ProviderConfigSlice {
  api?: string
  options?: { apiKey?: string }
}

export interface AuthEntrySlice {
  type: string
  refresh?: string
  enterpriseUrl?: string
}

export function resolveEndpoint(input: {
  providerConfig: ProviderConfigSlice | undefined
  authEntry: AuthEntrySlice | undefined
}): EndpointDecision | null {
  const proxyApi = input.providerConfig?.api
  const apiKey = input.providerConfig?.options?.apiKey
  const entry = input.authEntry
  const oauthRefresh = entry?.type === "oauth" ? entry.refresh : undefined
  const account = entry?.enterpriseUrl

  if (proxyApi) {
    if (apiKey) {
      return { url: `${proxyApi}/quota`, token: apiKey, mode: "proxy", account }
    }
    if (oauthRefresh) {
      return { url: `${proxyApi}/quota`, token: oauthRefresh, mode: "proxy", account }
    }
    return null
  }

  if (!oauthRefresh) return null

  const apiBase = entry?.enterpriseUrl
    ? `https://api.${entry.enterpriseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}`
    : "https://api.github.com"
  return { url: `${apiBase}/copilot_internal/user`, token: oauthRefresh, mode: "official", account }
}
