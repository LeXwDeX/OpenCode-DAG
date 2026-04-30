import { afterEach, describe, expect, mock, test } from "bun:test"
import { GithubProxyAuthPlugin } from "@/plugin/github-proxy/proxy"
import { MessageV2 } from "@/session/message-v2"

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

  // 计费规则：GitHub Copilot 按用户 prompt 提交计费，agent 自发请求不扣。
  // 工具返图时 opencode 合成一条 role:"user" + SYNTHETIC_ATTACHMENT_PROMPT 的消息把图喂回模型，
  // 这本质是 agent loop 的一步，必须标 agent 否则会被多扣 1 次。
  describe("synthetic attachment prompt → agent (billing correctness)", () => {
    async function captureHeaders(url: string, body: unknown) {
      let captured: { init?: RequestInit } | null = null
      globalThis.fetch = mock((_u: any, init?: RequestInit) => {
        captured = { init }
        return Promise.resolve(new Response("{}", { status: 200 }))
      }) as unknown as typeof fetch
      const f = await makeFetch({ proxyUrl: "http://p.local" })
      await f!(url, { method: "POST", body: JSON.stringify(body) } as any)
      return captured!.init!.headers as Record<string, string>
    }

    test("Completions API: synthetic user-role attachment msg → agent", async () => {
      const headers = await captureHeaders("https://p.local/copilot/v1/chat/completions", {
        messages: [
          { role: "user", content: "show me the screenshot" },
          { role: "assistant", content: "calling tool..." },
          { role: "tool", content: "tool result" },
          {
            role: "user",
            content: [
              { type: "text", text: MessageV2.SYNTHETIC_ATTACHMENT_PROMPT },
              { type: "image_url", image_url: { url: "data:image/png;base64,xxx" } },
            ],
          },
        ],
      })
      expect(headers["x-initiator"]).toBe("agent")
      // 同时确认 vision header 仍被注入（合成附件本身就带图）
      expect(headers["Copilot-Vision-Request"]).toBe("true")
    })

    test("Completions API: string-content synthetic prompt → agent", async () => {
      const headers = await captureHeaders("https://p.local/copilot/v1/chat/completions", {
        messages: [
          { role: "user", content: "go" },
          { role: "user", content: MessageV2.SYNTHETIC_ATTACHMENT_PROMPT },
        ],
      })
      expect(headers["x-initiator"]).toBe("agent")
    })

    test("Responses API: synthetic input_text attachment item → agent (GPT-5 path)", async () => {
      const headers = await captureHeaders("https://p.local/copilot/responses", {
        input: [
          { role: "user", content: [{ type: "input_text", text: "look" }] },
          {
            role: "user",
            content: [
              { type: "input_text", text: MessageV2.SYNTHETIC_ATTACHMENT_PROMPT },
              { type: "input_image", image_url: "data:image/png;base64,yyy" },
            ],
          },
        ],
      })
      expect(headers["x-initiator"]).toBe("agent")
    })

    test("Messages API: synthetic user msg with text+image → agent (Claude path)", async () => {
      const headers = await captureHeaders("https://p.local/copilot/v1/messages", {
        messages: [
          { role: "user", content: [{ type: "text", text: "go" }] },
          { role: "assistant", content: [{ type: "text", text: "calling..." }] },
          {
            role: "user",
            content: [
              { type: "text", text: MessageV2.SYNTHETIC_ATTACHMENT_PROMPT },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "zzz" } },
            ],
          },
        ],
      })
      expect(headers["x-initiator"]).toBe("agent")
    })

    test("Completions API: real user prompt with image is NOT mistaken as synthetic", async () => {
      const headers = await captureHeaders("https://p.local/copilot/v1/chat/completions", {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is in this image?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,real" } },
            ],
          },
        ],
      })
      expect(headers["x-initiator"]).toBe("user")
      expect(headers["Copilot-Vision-Request"]).toBe("true")
    })
  })
})

// chat.params 必须为 anthropic 模型关闭 toolStreaming。
// 否则 @ai-sdk/anthropic 会注入 GA 字段 eager_input_streaming，
// 被 Copilot /v1/messages shim 拒绝（"Extra inputs are not permitted"），导致 Claude 不可用。
describe("github-proxy / chat.params", () => {
  test("disables toolStreaming for anthropic models", async () => {
    const hooks = await GithubProxyAuthPlugin(baseInput as never)
    const output: any = { options: {} }
    await hooks["chat.params"]!(
      {
        model: { providerID: "github-proxy", api: { id: "claude-opus-4.7", npm: "@ai-sdk/anthropic" } },
      } as any,
      output,
    )
    expect(output.options.toolStreaming).toBe(false)
  })

  test("does NOT disable toolStreaming for non-anthropic models", async () => {
    const hooks = await GithubProxyAuthPlugin(baseInput as never)
    const output: any = { options: {} }
    await hooks["chat.params"]!(
      {
        model: { providerID: "github-proxy", api: { id: "gpt-5", npm: "@ai-sdk/github-copilot" } },
      } as any,
      output,
    )
    expect(output.options.toolStreaming).toBeUndefined()
  })

  test("clears maxOutputTokens for gpt models", async () => {
    const hooks = await GithubProxyAuthPlugin(baseInput as never)
    const output: any = { options: {}, maxOutputTokens: 4096 }
    await hooks["chat.params"]!(
      {
        model: { providerID: "github-proxy", api: { id: "gpt-5-mini", npm: "@ai-sdk/github-copilot" } },
      } as any,
      output,
    )
    expect(output.maxOutputTokens).toBeUndefined()
  })

  test("ignores non-github-proxy models", async () => {
    const hooks = await GithubProxyAuthPlugin(baseInput as never)
    const output: any = { options: {}, maxOutputTokens: 4096 }
    await hooks["chat.params"]!(
      {
        model: { providerID: "anthropic", api: { id: "claude-opus-4.7", npm: "@ai-sdk/anthropic" } },
      } as any,
      output,
    )
    expect(output.options.toolStreaming).toBeUndefined()
    expect(output.maxOutputTokens).toBe(4096)
  })
})

// chat.headers 必须把 auto-compaction 续聊也识别为 agent。
// 续聊由一条 type:"text" + synthetic:true + metadata.compaction_continue:true 的合成 part 触发，
// 仅检查 part.type === "compaction" 会漏掉续聊请求 → 误扣 1 次。
describe("github-proxy / chat.headers compaction detection", () => {
  function makeHooksWithSdk(parts: any[]) {
    const sdk = {
      session: {
        message: () => Promise.resolve({ data: { parts } }),
        get: () => Promise.resolve({ data: {} }),
      },
    }
    return GithubProxyAuthPlugin({ ...baseInput, client: sdk } as never)
  }

  test("compaction part → x-initiator=agent", async () => {
    const hooks = await makeHooksWithSdk([{ type: "compaction" }])
    const output: any = { headers: {} }
    await hooks["chat.headers"]!(
      {
        model: { providerID: "github-proxy", api: { npm: "@ai-sdk/github-copilot" } },
        message: { sessionID: "s1", id: "m1" },
        sessionID: "s1",
      } as any,
      output,
    )
    expect(output.headers["x-initiator"]).toBe("agent")
  })

  test("synthetic text part with compaction_continue=true → x-initiator=agent", async () => {
    const hooks = await makeHooksWithSdk([
      { type: "text", synthetic: true, metadata: { compaction_continue: true }, text: "..." },
    ])
    const output: any = { headers: {} }
    await hooks["chat.headers"]!(
      {
        model: { providerID: "github-proxy", api: { npm: "@ai-sdk/github-copilot" } },
        message: { sessionID: "s1", id: "m1" },
        sessionID: "s1",
      } as any,
      output,
    )
    expect(output.headers["x-initiator"]).toBe("agent")
  })

  test("synthetic text part WITHOUT compaction_continue → header NOT set to agent (preserves user attribution)", async () => {
    const hooks = await makeHooksWithSdk([
      { type: "text", synthetic: true, metadata: {}, text: "..." },
    ])
    const output: any = { headers: {} }
    await hooks["chat.headers"]!(
      {
        model: { providerID: "github-proxy", api: { npm: "@ai-sdk/github-copilot" } },
        message: { sessionID: "s1", id: "m1" },
        sessionID: "s1",
      } as any,
      output,
    )
    expect(output.headers["x-initiator"]).toBeUndefined()
  })

  test("anthropic model also gets anthropic-beta header", async () => {
    const hooks = await makeHooksWithSdk([])
    const output: any = { headers: {} }
    await hooks["chat.headers"]!(
      {
        model: { providerID: "github-proxy", api: { npm: "@ai-sdk/anthropic" } },
        message: { sessionID: "s1", id: "m1" },
        sessionID: "s1",
      } as any,
      output,
    )
    expect(output.headers["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14")
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
