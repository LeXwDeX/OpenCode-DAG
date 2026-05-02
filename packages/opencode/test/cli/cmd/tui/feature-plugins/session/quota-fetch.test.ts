// quota-fetch.test.ts — TUI Quota 自动化测试，覆盖 quota-fetch.ts 纯逻辑
//   - readQuotaAuthForProvider：按 providerID 精确选 auth
//   - parseProxyQuota / parseCopilotQuota：正常解析 + 字段缺失返回 null
//   - fetchQuota：正常 200 + 非 200 + fetch 抛错（含 timeout）
// 不覆盖：Solid 组件渲染、setInterval 调度、opentui Slot 逻辑（需手测）
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {
  fetchQuota,
  parseCopilotQuota,
  parseProxyQuota,
  readQuotaAuthForProvider,
  type QuotaAuth,
} from "@/cli/cmd/tui/feature-plugins/session/quota-fetch"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("readQuotaAuthForProvider", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "quota-auth-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("github-proxy → 去尾斜杠后拼 /copilot/quota", async () => {
    await writeFile(
      path.join(dir, "auth.json"),
      JSON.stringify({
        "github-proxy": {
          type: "api",
          key: "sk-test",
          metadata: { proxyUrl: "http://internal:8000///" },
        },
      }),
    )
    expect(await readQuotaAuthForProvider(dir, "github-proxy")).toEqual({
      quotaUrl: "http://internal:8000/copilot/quota",
      token: "sk-test",
      provider: "github-proxy",
    })
  })

  test("github-copilot → 返回 copilot auth", async () => {
    await writeFile(
      path.join(dir, "auth.json"),
      JSON.stringify({
        "github-copilot": { type: "oauth", refresh: "gho_test" },
      }),
    )
    expect(await readQuotaAuthForProvider(dir, "github-copilot")).toEqual({
      quotaUrl: "https://api.github.com/copilot_internal/user",
      token: "gho_test",
      provider: "github-copilot",
    })
  })

  test("github-copilot 子变体（如 github-copilot-custom）→ 匹配 copilot 条目", async () => {
    await writeFile(
      path.join(dir, "auth.json"),
      JSON.stringify({
        "github-copilot": { type: "oauth", refresh: "gho_sub" },
      }),
    )
    const auth = await readQuotaAuthForProvider(dir, "github-copilot-custom")
    expect(auth?.provider).toBe("github-copilot")
    expect(auth?.token).toBe("gho_sub")
  })

  test("github-proxy 子变体（如 github-proxy-v2）→ 匹配 proxy 条目", async () => {
    await writeFile(
      path.join(dir, "auth.json"),
      JSON.stringify({
        "github-proxy": { type: "api", key: "sk-v2", metadata: { proxyUrl: "http://p:8000" } },
      }),
    )
    const auth = await readQuotaAuthForProvider(dir, "github-proxy-v2")
    expect(auth?.provider).toBe("github-proxy")
    expect(auth?.token).toBe("sk-v2")
  })

  test("github-copilot enterpriseUrl → 注入 api. 子域", async () => {
    await writeFile(
      path.join(dir, "auth.json"),
      JSON.stringify({
        "github-copilot": {
          type: "oauth",
          refresh: "gho_ent",
          enterpriseUrl: "https://ghes.corp.io/",
        },
      }),
    )
    const auth = await readQuotaAuthForProvider(dir, "github-copilot")
    expect(auth?.quotaUrl).toBe("https://api.ghes.corp.io/copilot_internal/user")
  })

  test("github-proxy 缺 proxyUrl → null", async () => {
    await writeFile(
      path.join(dir, "auth.json"),
      JSON.stringify({ "github-proxy": { type: "api", key: "sk-test" } }),
    )
    expect(await readQuotaAuthForProvider(dir, "github-proxy")).toBeNull()
  })

  test("github-copilot 缺 refresh → null", async () => {
    await writeFile(
      path.join(dir, "auth.json"),
      JSON.stringify({ "github-copilot": { type: "oauth" } }),
    )
    expect(await readQuotaAuthForProvider(dir, "github-copilot")).toBeNull()
  })

  test("未知 providerID → null", async () => {
    await writeFile(
      path.join(dir, "auth.json"),
      JSON.stringify({ "github-proxy": { type: "api", key: "sk", metadata: { proxyUrl: "http://p:8000" } } }),
    )
    expect(await readQuotaAuthForProvider(dir, "anthropic")).toBeNull()
  })

  test("auth.json 不存在 → null", async () => {
    expect(await readQuotaAuthForProvider(dir, "github-proxy")).toBeNull()
  })

  test("auth.json 非法 JSON → null", async () => {
    await writeFile(path.join(dir, "auth.json"), "{not json")
    expect(await readQuotaAuthForProvider(dir, "github-copilot")).toBeNull()
  })
})

describe("parseProxyQuota", () => {
  test("完整字段解析 → used = entitlement - remaining", () => {
    expect(
      parseProxyQuota({ remaining: 30, entitlement: 100, accounts_active: 2, accounts_total: 5 }),
    ).toEqual({ used: 70, entitlement: 100, accounts_active: 2, accounts_total: 5 })
  })

  test("remaining 0 时 used = entitlement（全部用完）", () => {
    expect(parseProxyQuota({ remaining: 0, entitlement: 50 })).toEqual({
      used: 50,
      entitlement: 50,
      accounts_active: 0,
      accounts_total: 0,
    })
  })

  test("accounts 字段缺失时填 0", () => {
    expect(parseProxyQuota({ remaining: 10, entitlement: 50 })).toEqual({
      used: 40,
      entitlement: 50,
      accounts_active: 0,
      accounts_total: 0,
    })
  })

  test("缺 remaining/entitlement → null", () => {
    expect(parseProxyQuota({ remaining: 10 })).toBeNull()
    expect(parseProxyQuota({})).toBeNull()
  })
})

describe("parseCopilotQuota", () => {
  test("snake_case 字段解析 → used = entitlement - remaining", () => {
    expect(
      parseCopilotQuota({
        quota_snapshots: { premium_interactions: { remaining: 30, entitlement: 300 } },
      }),
    ).toEqual({ used: 270, entitlement: 300, accounts_active: 0, accounts_total: 0 })
  })

  test("overage（remaining 为负数）→ used > entitlement", () => {
    expect(
      parseCopilotQuota({
        quota_snapshots: { premium_interactions: { remaining: -51, entitlement: 300 } },
      }),
    ).toEqual({ used: 351, entitlement: 300, accounts_active: 0, accounts_total: 0 })
  })

  test("remaining 0 时 used = entitlement（全部用完）", () => {
    expect(
      parseCopilotQuota({
        quota_snapshots: { premium_interactions: { remaining: 0, entitlement: 100 } },
      }),
    ).toEqual({ used: 100, entitlement: 100, accounts_active: 0, accounts_total: 0 })
  })

  test("缺 quota_snapshots → null", () => {
    expect(parseCopilotQuota({})).toBeNull()
  })

  test("缺 premium_interactions → null", () => {
    expect(parseCopilotQuota({ quota_snapshots: {} })).toBeNull()
  })

  test("remaining 非 number → null", () => {
    expect(
      parseCopilotQuota({
        quota_snapshots: { premium_interactions: { remaining: "30", entitlement: 100 } },
      }),
    ).toBeNull()
  })
})

describe("fetchQuota", () => {
  const proxyAuth: QuotaAuth = {
    quotaUrl: "http://internal:8000/copilot/quota",
    token: "sk-test",
    provider: "github-proxy",
  }
  const copilotAuth: QuotaAuth = {
    quotaUrl: "https://api.github.com/copilot_internal/user",
    token: "gho_test",
    provider: "github-copilot",
  }

  test("github-proxy 200 → parseProxyQuota，header 注入 Bearer", async () => {
    let captured: { url: string; headers: Record<string, string> } | null = null
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      captured = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string> }
      return new Response(JSON.stringify({ remaining: 20, entitlement: 100 }), { status: 200 })
    }) as unknown as typeof fetch
    const q = await fetchQuota(proxyAuth)
    expect(q).toEqual({ used: 80, entitlement: 100, accounts_active: 0, accounts_total: 0 })
    expect(captured!.url).toBe("http://internal:8000/copilot/quota")
    expect(captured!.headers.Authorization).toBe("Bearer sk-test")
  })

  test("github-copilot 200 → parseCopilotQuota，header 注入 Bearer", async () => {
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
    const q = await fetchQuota(copilotAuth)
    expect(q).toEqual({ used: 240, entitlement: 300, accounts_active: 0, accounts_total: 0 })
    expect(captured.Authorization).toBe("Bearer gho_test")
  })

  test("非 200 响应 → null", async () => {
    globalThis.fetch = mock(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch
    expect(await fetchQuota(proxyAuth)).toBeNull()
  })

  test("fetch 抛错 → null", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("connection refused")
    }) as unknown as typeof fetch
    expect(await fetchQuota(copilotAuth)).toBeNull()
  })

  test("响应 JSON 字段不完整 → null", async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch
    expect(await fetchQuota(proxyAuth)).toBeNull()
  })
})
