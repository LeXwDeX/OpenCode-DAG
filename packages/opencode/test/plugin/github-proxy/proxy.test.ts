import { afterEach, describe, expect, mock, test } from "bun:test"
import { GithubProxyAuthPlugin } from "@/plugin/github-proxy/proxy"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const baseInput = {
  client: {} as never,
  project: {} as never,
  directory: "",
  worktree: "",
  experimental_workspace: { register() {} },
  serverUrl: new URL("https://example.com"),
  $: {} as never,
} as const

function makeProvider(models: Record<string, any>) {
  return { id: "github-proxy", models } as never
}

describe("github-proxy / models()", () => {
  test("returns provider.models unchanged when auth has no proxyUrl metadata", async () => {
    const hooks = await GithubProxyAuthPlugin(baseInput as never)
    const original = {
      foo: { id: "foo", providerID: "anything", api: { id: "foo", url: "u", npm: "n" } },
    } as never
    const models = await hooks.provider!.models!(makeProvider(original), {
      auth: { type: "api", key: "k" } as never,
    })
    expect(models).toBe(original)
  })

  test("falls back to fix() when /copilot/models fetch rejects — claude rerouted to anthropic /v1", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("timeout"))) as unknown as typeof fetch

    const hooks = await GithubProxyAuthPlugin(baseInput as never)
    const original = {
      claude: {
        id: "claude",
        providerID: "anything",
        api: { id: "claude-opus-4.7", url: "old", npm: "@ai-sdk/github-copilot" },
      },
      gpt: {
        id: "gpt",
        providerID: "anything",
        api: { id: "gpt-4o", url: "old", npm: "@ai-sdk/openai-compatible" },
      },
    }

    const models = await hooks.provider!.models!(makeProvider(original), {
      auth: { type: "api", key: "k", metadata: { proxyUrl: "http://proxy.local/" } } as never,
    })

    // All models get providerID rewritten
    expect(models.claude.providerID).toBe("github-proxy")
    expect(models.gpt.providerID).toBe("github-proxy")
    // Claude → anthropic + /v1 path
    expect(models.claude.api.npm).toBe("@ai-sdk/anthropic")
    expect(models.claude.api.url).toBe("http://proxy.local/copilot/v1")
    // Non-claude → github-copilot, no /v1
    expect(models.gpt.api.npm).toBe("@ai-sdk/github-copilot")
    expect(models.gpt.api.url).toBe("http://proxy.local/copilot")
  })
})

describe("github-proxy / loader fetch interception", () => {
  async function makeFetch(metadata?: Record<string, string>) {
    const hooks = await GithubProxyAuthPlugin(baseInput as never)
    const getAuth = async () => ({ type: "api", key: "secret-key", metadata }) as any
    const result = await hooks.auth!.loader!(getAuth as never, {} as never)
    return result.fetch as undefined | typeof fetch
  }

  test("loader returns empty object when proxyUrl metadata missing", async () => {
    const hooks = await GithubProxyAuthPlugin(baseInput as never)
    const out = await hooks.auth!.loader!(async () => ({ type: "api", key: "k" }) as never, {} as never)
    expect(out).toEqual({})
  })

  test("injects x-initiator=agent for assistant-tail Messages API turn", async () => {
    let captured: { url: string; init?: RequestInit } | null = null
    globalThis.fetch = mock((url: any, init?: RequestInit) => {
      captured = { url: typeof url === "string" ? url : url.toString(), init }
      return Promise.resolve(new Response("{}", { status: 200 }))
    }) as unknown as typeof fetch

    const f = await makeFetch({ proxyUrl: "http://p.local" })
    await f!("https://p.local/copilot/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
        ],
      }),
    } as any)

    const headers = captured!.init!.headers as Record<string, string>
    expect(headers["x-initiator"]).toBe("agent")
    expect(headers["Authorization"]).toBe("Bearer secret-key")
    expect(headers["Openai-Intent"]).toBe("conversation-edits")
    expect(headers["Copilot-Vision-Request"]).toBeUndefined()
  })

  test("injects x-initiator=user when last user turn is plain (Completions API)", async () => {
    let captured: { url: string; init?: RequestInit } | null = null
    globalThis.fetch = mock((url: any, init?: RequestInit) => {
      captured = { url: typeof url === "string" ? url : url.toString(), init }
      return Promise.resolve(new Response("{}", { status: 200 }))
    }) as unknown as typeof fetch

    const f = await makeFetch({ proxyUrl: "http://p.local" })
    await f!("https://p.local/copilot/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
      }),
    } as any)

    expect((captured!.init!.headers as any)["x-initiator"]).toBe("user")
  })

  test("sets Copilot-Vision-Request when message contains image_url (Completions API)", async () => {
    let captured: { url: string; init?: RequestInit } | null = null
    globalThis.fetch = mock((url: any, init?: RequestInit) => {
      captured = { url: typeof url === "string" ? url : url.toString(), init }
      return Promise.resolve(new Response("{}", { status: 200 }))
    }) as unknown as typeof fetch

    const f = await makeFetch({ proxyUrl: "http://p.local" })
    await f!("https://p.local/copilot/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw" } },
            ],
          },
        ],
      }),
    } as any)

    expect((captured!.init!.headers as any)["Copilot-Vision-Request"]).toBe("true")
  })

  test("strips x-api-key and lowercase authorization to enforce Bearer key", async () => {
    let captured: { init?: RequestInit } | null = null
    globalThis.fetch = mock((_url: any, init?: RequestInit) => {
      captured = { init }
      return Promise.resolve(new Response("{}", { status: 200 }))
    }) as unknown as typeof fetch

    const f = await makeFetch({ proxyUrl: "http://p.local" })
    await f!("https://p.local/copilot/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": "should-be-removed",
        authorization: "should-be-removed-too",
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    } as any)

    const headers = captured!.init!.headers as Record<string, string>
    expect(headers["x-api-key"]).toBeUndefined()
    expect(headers["authorization"]).toBeUndefined()
    // The capital-A Authorization from our injection survives
    expect(headers["Authorization"]).toBe("Bearer secret-key")
  })
})

describe("github-proxy / authorize", () => {
  const method = async () => {
    const hooks = await GithubProxyAuthPlugin(baseInput as never)
    return hooks.auth!.methods!.find((m) => m.type === "api")! as any
  }

  test("returns success + metadata.proxyUrl (trailing slash trimmed) on 200", async () => {
    let calledUrl = ""
    globalThis.fetch = mock((url: any) => {
      calledUrl = typeof url === "string" ? url : url.toString()
      return Promise.resolve(new Response("ok", { status: 200 }))
    }) as unknown as typeof fetch

    const m = await method()
    const result = await m.authorize({ proxyUrl: "http://p.local///", apiKey: "abc" })

    expect(calledUrl).toBe("http://p.local/copilot/auth")
    expect(result).toEqual({
      type: "success",
      key: "abc",
      metadata: { proxyUrl: "http://p.local" },
    })
  })

  test("returns failed when upstream responds non-2xx", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("nope", { status: 401 })),
    ) as unknown as typeof fetch

    const m = await method()
    const result = await m.authorize({ proxyUrl: "http://p.local", apiKey: "abc" })
    expect(result).toEqual({ type: "failed" })
  })

  test("returns failed when fetch throws", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("network"))) as unknown as typeof fetch

    const m = await method()
    const result = await m.authorize({ proxyUrl: "http://p.local", apiKey: "abc" })
    expect(result).toEqual({ type: "failed" })
  })

  test("returns failed when inputs missing", async () => {
    const m = await method()
    expect(await m.authorize({ proxyUrl: "", apiKey: "k" })).toEqual({ type: "failed" })
    expect(await m.authorize({ proxyUrl: "http://p", apiKey: "" })).toEqual({ type: "failed" })
    expect(await m.authorize({})).toEqual({ type: "failed" })
  })
})
