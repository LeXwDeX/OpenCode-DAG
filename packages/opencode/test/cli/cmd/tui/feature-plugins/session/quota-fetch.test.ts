// quota-fetch.test.ts — TUI Quota 自动化测试，覆盖 quota.tsx 抽离的纯逻辑
//   - readQuotaAuth：2 种 auth 来源（github-proxy / github-copilot）+ 异常分支
//   - parseProxyQuota / parseCopilotQuota：正常解析 + 字段缺失返回 null
//   - fetchQuota：正常 200 + 非 200 + fetch 抛错（含 timeout）
// 不覆盖：Solid 组件渲染、setInterval 调度、opentui Slot 逻辑（需手测，见 08-test-plan §5.2）
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {
  fetchQuota,
  parseCopilotQuota,
  parseProxyQuota,
  readQuotaAuth,
  type QuotaAuth,
} from "@/cli/cmd/tui/feature-plugins/session/quota-fetch"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("readQuotaAuth", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "quota-auth-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("github-proxy 优先，去尾斜杠后拼 /copilot/quota", async () => {
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
    const auth = await readQuotaAuth(dir)
    expect(auth).toEqual({
      quotaUrl: "http://internal:8000/copilot/quota",
      token: "sk-test",
      provider: "github-proxy",
      authHeaderPrefix: "Bearer",
    })
  })

  test("缺 proxyUrl 时降级到 github-copilot oauth", async () => {
    await writeFile(
      path.join(dir, "auth.json"),
      JSON.stringify({
        "github-proxy": { type: "api", key: "sk-test" }, // 无 metadata
        "github-copilot": { type: "oauth", refresh: "gho_test" },
      }),
    )
    const auth = await readQuotaAuth(dir)
    expect(auth).toEqual({
      quotaUrl: "https://api.github.com/copilot_internal/user",
      token: "gho_test",
      provider: "github-copilot",
      authHeaderPrefix: "token",
    })
  })

  test("github-copilot enterpriseUrl 注入 api. 子域", async () => {
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
    const auth = await readQuotaAuth(dir)
    expect(auth?.quotaUrl).toBe("https://api.ghes.corp.io/copilot_internal/user")
  })

  test("auth.json 不存在 → 返回 null", async () => {
    expect(await readQuotaAuth(dir)).toBeNull()
  })

  test("auth.json 非法 JSON → 返回 null", async () => {
    await writeFile(path.join(dir, "auth.json"), "{not json")
    expect(await readQuotaAuth(dir)).toBeNull()
  })

  test("无任何 provider 配置 → 返回 null", async () => {
    await writeFile(path.join(dir, "auth.json"), JSON.stringify({ other: { type: "api" } }))
    expect(await readQuotaAuth(dir)).toBeNull()
  })
})

describe("parseProxyQuota", () => {
  test("完整字段解析", () => {
    expect(
      parseProxyQuota({ remaining: 30, entitlement: 100, accounts_active: 2, accounts_total: 5 }),
    ).toEqual({ remaining: 30, entitlement: 100, accounts_active: 2, accounts_total: 5 })
  })

  test("accounts 字段缺失时填 0", () => {
    expect(parseProxyQuota({ remaining: 10, entitlement: 50 })).toEqual({
      remaining: 10,
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
  test("percentRemaining 翻转为 used 数值，entitlement 固定 100", () => {
    expect(
      parseCopilotQuota({
        quotaSnapshots: { premiumInteractions: { percentRemaining: 75 } },
      }),
    ).toEqual({ remaining: 25, entitlement: 100, accounts_active: 0, accounts_total: 0 })
  })

  test("缺 quotaSnapshots → null", () => {
    expect(parseCopilotQuota({})).toBeNull()
  })

  test("percentRemaining 非 number → null", () => {
    expect(
      parseCopilotQuota({
        quotaSnapshots: { premiumInteractions: { percentRemaining: "75" } },
      }),
    ).toBeNull()
  })
})

describe("fetchQuota", () => {
  const proxyAuth: QuotaAuth = {
    quotaUrl: "http://internal:8000/copilot/quota",
    token: "sk-test",
    provider: "github-proxy",
    authHeaderPrefix: "Bearer",
  }
  const copilotAuth: QuotaAuth = {
    quotaUrl: "https://api.github.com/copilot_internal/user",
    token: "gho_test",
    provider: "github-copilot",
    authHeaderPrefix: "token",
  }

  test("github-proxy 200 → parseProxyQuota，header 注入 Bearer", async () => {
    let captured: { url: string; headers: Record<string, string> } | null = null
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      captured = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string> }
      return new Response(JSON.stringify({ remaining: 20, entitlement: 100 }), { status: 200 })
    }) as unknown as typeof fetch
    const q = await fetchQuota(proxyAuth)
    expect(q).toEqual({ remaining: 20, entitlement: 100, accounts_active: 0, accounts_total: 0 })
    expect(captured!.url).toBe("http://internal:8000/copilot/quota")
    expect(captured!.headers.Authorization).toBe("Bearer sk-test")
  })

  test("github-copilot 200 → parseCopilotQuota，header 注入 token 前缀", async () => {
    let captured: Record<string, string> = {}
    globalThis.fetch = mock(async (_url: string | URL, init?: RequestInit) => {
      captured = (init?.headers ?? {}) as Record<string, string>
      return new Response(
        JSON.stringify({ quotaSnapshots: { premiumInteractions: { percentRemaining: 60 } } }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const q = await fetchQuota(copilotAuth)
    expect(q).toEqual({ remaining: 40, entitlement: 100, accounts_active: 0, accounts_total: 0 })
    expect(captured.Authorization).toBe("token gho_test")
  })

  test("非 200 → 返回 null（不抛）", async () => {
    globalThis.fetch = mock(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch
    expect(await fetchQuota(proxyAuth)).toBeNull()
  })

  test("fetch 抛错（如 timeout）→ 返回 null", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("AbortError")
    }) as unknown as typeof fetch
    expect(await fetchQuota(proxyAuth)).toBeNull()
  })

  test("响应 JSON 字段不完整 → 返回 null", async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch
    expect(await fetchQuota(proxyAuth)).toBeNull()
  })
})
