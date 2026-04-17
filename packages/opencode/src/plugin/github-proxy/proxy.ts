import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk/v2"
import * as Installation from "@/installation"
import { InstallationVersion } from "@/installation/version"
import { iife } from "@/util/iife"
import * as Log from "../../util/log"
import { CopilotModels } from "../github-copilot/models"

const log = Log.create({ service: "plugin.github-proxy" })

// The SDK v1 Auth union doesn't expose `metadata` on ApiAuth,
// but at runtime the internal Auth.Api schema includes it.
// Use a local type to bridge the gap without depending on internals.
type ApiAuthWithMeta = { type: "api"; key: string; metadata?: Record<string, string> }

function fix(model: Model, url: string): Model {
  return {
    ...model,
    providerID: "github-proxy",
    api: {
      ...model.api,
      url,
      npm: "@ai-sdk/github-copilot",
    },
  }
}

function overrideProviderID(models: Record<string, Model>): Record<string, Model> {
  return Object.fromEntries(
    Object.entries(models).map(([id, model]) => [id, { ...model, providerID: "github-proxy" }]),
  )
}

export async function GithubProxyAuthPlugin(input: PluginInput): Promise<Hooks> {
  const sdk = input.client
  return {
    provider: {
      id: "github-proxy",
      async models(provider, ctx) {
        if (ctx.auth?.type !== "api") {
          return provider.models
        }

        const auth = ctx.auth as ApiAuthWithMeta
        const proxyUrl = auth.metadata?.proxyUrl
        if (!proxyUrl) {
          return provider.models
        }

        const baseURL = `${proxyUrl.replace(/\/+$/, "")}/copilot`

        return CopilotModels.get(
          baseURL,
          {
            Authorization: `Bearer ${auth.key}`,
            "User-Agent": `opencode/${InstallationVersion}`,
          },
          provider.models,
        ).then(overrideProviderID).catch((error) => {
          log.error("failed to fetch models from proxy", { error })
          return Object.fromEntries(
            Object.entries(provider.models).map(([id, model]) => [id, fix(model, baseURL)]),
          )
        })
      },
    },
    auth: {
      provider: "github-proxy",
      async loader(getAuth) {
        const info = await getAuth()
        if (!info || info.type !== "api") return {}

        const proxyUrl = (info as ApiAuthWithMeta).metadata?.proxyUrl
        if (!proxyUrl) return {}

        const baseURL = `${proxyUrl.replace(/\/+$/, "")}/copilot`

        return {
          apiKey: "",
          // NOTE: 不要在此返回 baseURL。每个 model 在 CopilotModels.build() 中已设置
          // 了正确的 api.url（Claude → .../copilot/v1, 其他 → .../copilot）。
          // 若此处返回 provider 级 baseURL，resolveSDK 会用它覆盖 model 级 url，
          // 导致 Claude 模型丢失 /v1 路径，Anthropic SDK 调用 /messages 而非
          // /v1/messages，上游 Copilot 无法正确处理请求。
          async fetch(request: RequestInfo | URL, init?: RequestInit) {
            const info = await getAuth()
            if (info.type !== "api") return fetch(request, init)

            const proxyUrl = (info as ApiAuthWithMeta).metadata?.proxyUrl
            if (!proxyUrl) return fetch(request, init)

            const url = request instanceof URL ? request.href : request.toString()
            const { isVision, isAgent } = iife(() => {
              try {
                const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body

                // Completions API
                if (body?.messages && url.includes("completions")) {
                  const last = body.messages[body.messages.length - 1]
                  return {
                    isVision: body.messages.some(
                      (msg: any) =>
                        Array.isArray(msg.content) && msg.content.some((part: any) => part.type === "image_url"),
                    ),
                    isAgent: last?.role !== "user",
                  }
                }

                // Responses API
                if (body?.input) {
                  const last = body.input[body.input.length - 1]
                  return {
                    isVision: body.input.some(
                      (item: any) =>
                        Array.isArray(item?.content) && item.content.some((part: any) => part.type === "input_image"),
                    ),
                    isAgent: last?.role !== "user",
                  }
                }

                // Messages API
                if (body?.messages) {
                  const last = body.messages[body.messages.length - 1]
                  const hasNonToolCalls =
                    Array.isArray(last?.content) && last.content.some((part: any) => part?.type !== "tool_result")
                  return {
                    isVision: body.messages.some(
                      (item: any) =>
                        Array.isArray(item?.content) &&
                        item.content.some(
                          (part: any) =>
                            part?.type === "image" ||
                            (part?.type === "tool_result" &&
                              Array.isArray(part?.content) &&
                              part.content.some((nested: any) => nested?.type === "image")),
                        ),
                    ),
                    isAgent: !(last?.role === "user" && hasNonToolCalls),
                  }
                }
              } catch {}
              return { isVision: false, isAgent: false }
            })

            const headers: Record<string, string> = {
              "x-initiator": isAgent ? "agent" : "user",
              ...(init?.headers as Record<string, string>),
              "User-Agent": `opencode/${InstallationVersion}`,
              Authorization: `Bearer ${info.key}`,
              "Openai-Intent": "conversation-edits",
            }

            if (isVision) {
              headers["Copilot-Vision-Request"] = "true"
            }

            delete headers["x-api-key"]
            delete headers["authorization"]

            return fetch(request, {
              ...init,
              headers,
            })
          },
        }
      },
      methods: [
        {
          type: "api" as const,
          label: "Connect via Proxy",
          prompts: [
            {
              type: "text",
              key: "proxyUrl",
              message: "Enter proxy server URL",
              placeholder: "http://192.168.33.110:8000",
              validate: (value) => {
                if (!value) return "Proxy URL is required"
                try {
                  new URL(value)
                  return undefined
                } catch {
                  return "Please enter a valid URL (e.g., http://192.168.33.110:8000)"
                }
              },
            },
            {
              type: "text",
              key: "apiKey",
              message: "Enter proxy API key",
              placeholder: "sk-...",
              validate: (value) => {
                if (!value) return "API key is required"
                return undefined
              },
            },
          ],
          async authorize(inputs = {}) {
            const proxyUrl = inputs.proxyUrl
            const apiKey = inputs.apiKey

            if (!proxyUrl || !apiKey) {
              return { type: "failed" as const }
            }

            try {
              const response = await fetch(`${proxyUrl.replace(/\/+$/, "")}/copilot/auth`, {
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                },
              })

              if (!response.ok) {
                return { type: "failed" as const }
              }

              return {
                type: "success" as const,
                key: apiKey,
                metadata: {
                  proxyUrl: proxyUrl.replace(/\/+$/, ""),
                },
              }
            } catch {
              return { type: "failed" as const }
            }
          },
        },
      ],
    },
    "chat.params": async (incoming, output) => {
      if (!incoming.model.providerID.includes("github-proxy")) return
      if (incoming.model.api.id.includes("gpt")) {
        output.maxOutputTokens = undefined
      }
    },
    "chat.headers": async (incoming, output) => {
      if (!incoming.model.providerID.includes("github-proxy")) return

      if (incoming.model.api.npm === "@ai-sdk/anthropic") {
        output.headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
      }

      const parts = await sdk.session
        .message({
          path: {
            id: incoming.message.sessionID,
            messageID: incoming.message.id,
          },
          query: {
            directory: input.directory,
          },
          throwOnError: true,
        })
        .catch(() => undefined)

      if (parts?.data.parts?.some((part) => part.type === "compaction")) {
        output.headers["x-initiator"] = "agent"
        return
      }

      const session = await sdk.session
        .get({
          path: {
            id: incoming.sessionID,
          },
          query: {
            directory: input.directory,
          },
          throwOnError: true,
        })
        .catch(() => undefined)
      if (!session || !session.data.parentID) return
      output.headers["x-initiator"] = "agent"
    },
  }
}
