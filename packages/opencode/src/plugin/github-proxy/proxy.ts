import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk/v2"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { iife } from "@/util/iife"
import * as Log from "@opencode-ai/core/util/log"
import { CopilotModels } from "../github-copilot/models"
import { MessageV2 } from "@/session/message-v2"

const log = Log.create({ service: "plugin.github-proxy" })

// SDK v1 Auth union 不在 ApiAuth 上暴露 metadata，但运行时 Auth.Api schema 含此字段。
// 用本地类型桥接，避免依赖内部模块。
type ApiAuthWithMeta = { type: "api"; key: string; metadata?: Record<string, string> }

// 工具调用返图时，opencode 会合成一条 role:"user" 的消息携带 SYNTHETIC_ATTACHMENT_PROMPT
// 把图片喂回模型继续 agent loop。这条消息虽然 role 是 user，语义上是 agent 自发，
// 必须识别出来标记为 agent，否则会被 Copilot 计入用户提示次数误扣。
// 与 plugin/github-copilot/copilot.ts:imgMsg 保持一致。
function imgMsg(msg: any): boolean {
  if (msg?.role !== "user") return false
  const content = msg.content
  if (typeof content === "string") return content === MessageV2.SYNTHETIC_ATTACHMENT_PROMPT
  if (!Array.isArray(content)) return false
  return content.some(
    (part: any) =>
      (part?.type === "text" || part?.type === "input_text") && part.text === MessageV2.SYNTHETIC_ATTACHMENT_PROMPT,
  )
}

function fix(model: Model, url: string): Model {
  // 即使 /copilot/models 解析失败走 fallback，Claude 仍必须走 anthropic messages API，
  // 否则 thinking block 的 signature 链路会在 @ai-sdk/github-copilot 侧丢失，
  // 引发上游 "Invalid signature in thinking block"。
  // TODO(refactor-trigger): 同 github-copilot/copilot.ts:fix() 与 github-copilot/models.ts:build()
  // 共 3 处。再增第 4 处或正则失守时，抽 plugin/github-copilot/routing.ts 统一收敛。
  // 背景见 .memory/patterns/opencode-plugin-fallback-signature-preservation-20260421.md
  const isClaude = model.api.id.includes("claude")
  return {
    ...model,
    providerID: "github-proxy",
    api: {
      ...model.api,
      url: isClaude ? `${url}/v1` : url,
      npm: isClaude ? "@ai-sdk/anthropic" : "@ai-sdk/github-copilot",
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
        )
          .then(overrideProviderID)
          .catch((error) => {
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
                    isAgent: last?.role !== "user" || imgMsg(last),
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
                    isAgent: last?.role !== "user" || imgMsg(last),
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
                    isAgent: !(last?.role === "user" && hasNonToolCalls) || imgMsg(last),
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

      // GitHub Copilot 的 /v1/messages shim 拒绝 GA 字段 `eager_input_streaming`
      // ("Extra inputs are not permitted")。关闭 @ai-sdk/anthropic 的默认行为，
      // 否则经 proxy 走 Copilot 上游的 Claude 模型会请求失败。
      if (incoming.model.api.npm === "@ai-sdk/anthropic") {
        output.options.toolStreaming = false
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

      if (
        parts?.data.parts?.some(
          (part) =>
            part.type === "compaction" ||
            // auto-compaction 通过一条合成 user text part 续聊。把这条带标记的续聊
            // 视作 agent 自发，避免被计为额外的用户提示扣次。
            (part.type === "text" && part.synthetic && part.metadata?.compaction_continue === true),
        )
      ) {
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
