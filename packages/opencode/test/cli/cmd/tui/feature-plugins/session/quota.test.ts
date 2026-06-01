// quota.test.ts — TUI Quota 自动化测试，覆盖 quota/ 子目录纯逻辑：
//   - resolveEndpoint：6 行决策表（proxy/official × token 来源）；proxy URL = ${api}/quota
//   - parseCopilotOfficial：原厂嵌套 schema（data.quota_snapshots.premium_interactions）
//   - parseProxyAggregate：代理扁平 schema（{remaining, entitlement, accounts_active, accounts_total}）
//   - fetchQuota：根据 endpoint.mode 走对应 parser，正常/非2xx/抛错/字段不全
// 不覆盖：Solid 组件渲染、setInterval 调度、opentui Slot 逻辑（需手测）
import { afterEach, describe, expect, mock, test } from "bun:test"
import {
  fetchQuota,
  parseCopilotOfficial,
  parseProxyAggregate,
  resolveEndpoint,
  type EndpointDecision,
} from "@/cli/cmd/tui/feature-plugins/session/quota"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("resolveEndpoint", () => {
  test("proxy + apiKey → mode=proxy, url=${api}/quota, token=apiKey", () => {
    expect(
      resolveEndpoint({
        providerConfig: { api: "http://192.168.33.110:8000/copilot", options: { apiKey: "sk-proxy" } },
        authEntry: { type: "oauth", refresh: "gho_oauth" },
      }),
    ).toEqual({
      url: "http://192.168.33.110:8000/copilot/quota",
      token: "sk-proxy",
      mode: "proxy",
      account: undefined,
    })
  })

  test("proxy + 无 apiKey + oauth → mode=proxy, token=refresh", () => {
    expect(
      resolveEndpoint({
        providerConfig: { api: "http://localhost:9000/copilot", options: {} },
        authEntry: { type: "oauth", refresh: "gho_refresh" },
      }),
    ).toEqual({
      url: "http://localhost:9000/copilot/quota",
      token: "gho_refresh",
      mode: "proxy",
      account: undefined,
    })
  })

  test("proxy + 无 apiKey + 无 auth → null", () => {
    expect(
      resolveEndpoint({
        providerConfig: { api: "http://localhost:9000/copilot" },
        authEntry: undefined,
      }),
    ).toBeNull()
  })

  test("无 proxy + oauth → mode=official, url=api.github.com", () => {
    expect(
      resolveEndpoint({
        providerConfig: undefined,
        authEntry: { type: "oauth", refresh: "gho_test" },
      }),
    ).toEqual({
      url: "https://api.github.com/copilot_internal/user",
      token: "gho_test",
      mode: "official",
      account: undefined,
    })
  })

  test("无 proxy + oauth + enterpriseUrl → mode=official, url=api.<host>", () => {
    expect(
      resolveEndpoint({
        providerConfig: undefined,
        authEntry: { type: "oauth", refresh: "gho_ent", enterpriseUrl: "https://ghes.corp.io/" },
      }),
    ).toEqual({
      url: "https://api.ghes.corp.io/copilot_internal/user",
      token: "gho_ent",
      mode: "official",
      account: "https://ghes.corp.io/",
    })
  })

  test("无 proxy + 无 auth → null", () => {
    expect(resolveEndpoint({ providerConfig: undefined, authEntry: undefined })).toBeNull()
  })

  test("proxy 存在但 apiKey/refresh 都没 → null", () => {
    expect(
      resolveEndpoint({
        providerConfig: { api: "http://x/copilot", options: {} },
        authEntry: { type: "oauth" },
      }),
    ).toBeNull()
  })
})

describe("parseCopilotOfficial", () => {
  test("snake_case 字段解析 → used = entitlement - remaining", () => {
    expect(
      parseCopilotOfficial({
        quota_snapshots: { premium_interactions: { remaining: 30, entitlement: 300 } },
      }),
    ).toEqual({ used: 270, entitlement: 300, accounts_active: 0, accounts_total: 0, billing: "pru" })
  })

  test("overage（remaining 为负数）→ used > entitlement", () => {
    expect(
      parseCopilotOfficial({
        quota_snapshots: { premium_interactions: { remaining: -51, entitlement: 300 } },
      }),
    ).toEqual({ used: 351, entitlement: 300, accounts_active: 0, accounts_total: 0, billing: "pru" })
  })

  test("remaining 0 时 used = entitlement（全部用完）", () => {
    expect(
      parseCopilotOfficial({
        quota_snapshots: { premium_interactions: { remaining: 0, entitlement: 100 } },
      }),
    ).toEqual({ used: 100, entitlement: 100, accounts_active: 0, accounts_total: 0, billing: "pru" })
  })

  test("缺 quota_snapshots → null", () => {
    expect(parseCopilotOfficial({})).toBeNull()
  })

  test("缺 premium_interactions → null", () => {
    expect(parseCopilotOfficial({ quota_snapshots: {} })).toBeNull()
  })

  test("remaining 非 number → null", () => {
    expect(
      parseCopilotOfficial({
        quota_snapshots: { premium_interactions: { remaining: "30", entitlement: 100 } },
      }),
    ).toBeNull()
  })

  test("ai_credits schema → billing=credits, used = entitlement - remaining", () => {
    expect(
      parseCopilotOfficial({
        quota_snapshots: { ai_credits: { remaining: 1200, entitlement: 1500 } },
      }),
    ).toEqual({ used: 300, entitlement: 1500, accounts_active: 0, accounts_total: 0, billing: "credits" })
  })

  test("ai_credits 优先于 premium_interactions（双 schema 共存时取 credits）", () => {
    expect(
      parseCopilotOfficial({
        quota_snapshots: {
          ai_credits: { remaining: 1000, entitlement: 1500 },
          premium_interactions: { remaining: 30, entitlement: 300 },
        },
      }),
    ).toEqual({ used: 500, entitlement: 1500, accounts_active: 0, accounts_total: 0, billing: "credits" })
  })

  test("ai_credits overage（remaining 负数）→ used > entitlement", () => {
    expect(
      parseCopilotOfficial({
        quota_snapshots: { ai_credits: { remaining: -200, entitlement: 1500 } },
      }),
    ).toEqual({ used: 1700, entitlement: 1500, accounts_active: 0, accounts_total: 0, billing: "credits" })
  })
})

describe("parseProxyAggregate", () => {
  test("扁平 schema 解析 → used + accounts_active/total", () => {
    expect(
      parseProxyAggregate({ remaining: 133, entitlement: 300, accounts_active: 1, accounts_total: 2 }),
    ).toEqual({ used: 167, entitlement: 300, accounts_active: 1, accounts_total: 2, billing: "pru" })
  })

  test("缺 accounts_* 时默认 0（向后兼容老代理）", () => {
    expect(parseProxyAggregate({ remaining: 50, entitlement: 100 })).toEqual({
      used: 50,
      entitlement: 100,
      accounts_active: 0,
      accounts_total: 0,
      billing: "pru",
    })
  })

  test("overage（remaining 负数）→ used > entitlement", () => {
    expect(
      parseProxyAggregate({ remaining: -10, entitlement: 100, accounts_active: 1, accounts_total: 1 }),
    ).toEqual({ used: 110, entitlement: 100, accounts_active: 1, accounts_total: 1, billing: "pru" })
  })

  test("缺 remaining → null", () => {
    expect(parseProxyAggregate({ entitlement: 100, accounts_total: 1 })).toBeNull()
  })

  test("缺 entitlement → null", () => {
    expect(parseProxyAggregate({ remaining: 50, accounts_total: 1 })).toBeNull()
  })

  test("remaining 非 number → null", () => {
    expect(parseProxyAggregate({ remaining: "50", entitlement: 100 })).toBeNull()
  })

  test("显式 billing=credits → billing=credits", () => {
    expect(
      parseProxyAggregate({ remaining: 1200, entitlement: 1500, billing: "credits" }),
    ).toEqual({ used: 300, entitlement: 1500, accounts_active: 0, accounts_total: 0, billing: "credits" })
  })

  test("entitlement > 1500 无显式 billing → 启发式 billing=credits", () => {
    expect(
      parseProxyAggregate({ remaining: 5000, entitlement: 7000 }),
    ).toEqual({ used: 2000, entitlement: 7000, accounts_active: 0, accounts_total: 0, billing: "credits" })
  })

  test("entitlement ≤ 1500 无显式 billing → 启发式 billing=pru", () => {
    expect(
      parseProxyAggregate({ remaining: 133, entitlement: 300, accounts_active: 1, accounts_total: 2 }),
    ).toEqual({ used: 167, entitlement: 300, accounts_active: 1, accounts_total: 2, billing: "pru" })
  })
})

describe("fetchQuota", () => {
  const officialEndpoint: EndpointDecision = {
    url: "https://api.github.com/copilot_internal/user",
    token: "gho_test",
    mode: "official",
  }

  test("official 200 → parseCopilotOfficial，header 注入 Bearer，结果带 mode=official", async () => {
    let captured: Record<string, string> = {}
    globalThis.fetch = mock(async (_url: string | URL, init?: RequestInit) => {
      captured = (init?.headers ?? {}) as Record<string, string>
      return new Response(
        JSON.stringify({
          quota_snapshots: { premium_interactions: { remaining: 60, entitlement: 300 } },
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const q = await fetchQuota(officialEndpoint)
    expect(q).toEqual({
      used: 240,
      entitlement: 300,
      accounts_active: 0,
      accounts_total: 0,
      mode: "official",
      billing: "pru",
    })
    expect(captured.Authorization).toBe("Bearer gho_test")
  })

  test("official 200 + ai_credits schema → billing=credits", async () => {
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          quota_snapshots: { ai_credits: { remaining: 1200, entitlement: 1500 } },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch
    expect(await fetchQuota(officialEndpoint)).toEqual({
      used: 300,
      entitlement: 1500,
      accounts_active: 0,
      accounts_total: 0,
      mode: "official",
      billing: "credits",
    })
  })

  test("非 200 响应 → null", async () => {
    globalThis.fetch = mock(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch
    expect(await fetchQuota(officialEndpoint)).toBeNull()
  })

  test("fetch 抛错 → null", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("connection refused")
    }) as unknown as typeof fetch
    expect(await fetchQuota(officialEndpoint)).toBeNull()
  })

  test("official 响应 JSON 字段不完整 → null", async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch
    expect(await fetchQuota(officialEndpoint)).toBeNull()
  })

  test("proxy mode + GitHub 透传响应 → parseCopilotOfficial 解析", async () => {
    const proxyEndpoint: EndpointDecision = {
      url: "http://192.168.33.110:8000/copilot/quota",
      token: "sk-proxy",
      mode: "proxy",
    }
    let capturedUrl: string | URL = ""
    let capturedAuth = ""
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      capturedUrl = url
      capturedAuth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? ""
      return new Response(
        JSON.stringify({
          quota_snapshots: { ai_credits: { remaining: 1200, entitlement: 1500 } },
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    expect(await fetchQuota(proxyEndpoint)).toEqual({
      used: 300,
      entitlement: 1500,
      accounts_active: 0,
      accounts_total: 0,
      mode: "proxy",
      billing: "credits",
    })
    expect(capturedUrl).toBe("http://192.168.33.110:8000/copilot/quota")
    expect(capturedAuth).toBe("Bearer sk-proxy")
  })

  test("proxy mode + 旧版聚合响应 → parseProxyAggregate fallback", async () => {
    const proxyEndpoint: EndpointDecision = {
      url: "http://192.168.33.110:8000/copilot/quota",
      token: "sk-proxy",
      mode: "proxy",
    }
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({ remaining: 90, entitlement: 100, accounts_active: 2, accounts_total: 3 }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch
    expect(await fetchQuota(proxyEndpoint)).toEqual({
      used: 10,
      entitlement: 100,
      accounts_active: 2,
      accounts_total: 3,
      mode: "proxy",
      billing: "pru",
    })
  })

  test("proxy 响应缺字段 → null", async () => {
    const proxyEndpoint: EndpointDecision = {
      url: "http://x/copilot/quota",
      token: "sk-x",
      mode: "proxy",
    }
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ accounts_total: 1 }), { status: 200 })) as unknown as typeof fetch
    expect(await fetchQuota(proxyEndpoint)).toBeNull()
  })
})
