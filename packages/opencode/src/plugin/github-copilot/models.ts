import type { Model } from "@opencode-ai/sdk/v2"
import { Schema } from "effect"

export const schema = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      model_picker_enabled: Schema.Boolean,
      id: Schema.String,
      name: Schema.String,
      // every version looks like: `{model.id}-YYYY-MM-DD`
      version: Schema.String,
      supported_endpoints: Schema.optional(Schema.Array(Schema.String)),
      policy: Schema.optional(
        Schema.Struct({
          state: Schema.optional(Schema.String),
        }),
      ),
      capabilities: Schema.Struct({
        family: Schema.String,
        // Some upstream models may return limits with missing numeric fields;
        // default to 0 so the model is still usable (just without precise token budgets).
        limits: Schema.Struct({
          max_context_window_tokens: Schema.optional(Schema.Number),
          max_output_tokens: Schema.optional(Schema.Number),
          max_prompt_tokens: Schema.optional(Schema.Number),
          vision: Schema.optional(
            Schema.Struct({
              max_prompt_image_size: Schema.Number,
              max_prompt_images: Schema.Number,
              supported_media_types: Schema.Array(Schema.String),
            }),
          ),
        }),
        supports: Schema.Struct({
          adaptive_thinking: Schema.optional(Schema.Boolean),
          max_thinking_budget: Schema.optional(Schema.Number),
          min_thinking_budget: Schema.optional(Schema.Number),
          reasoning_effort: Schema.optional(Schema.Array(Schema.String)),
          streaming: Schema.Boolean,
          structured_outputs: Schema.optional(Schema.Boolean),
          tool_calls: Schema.Boolean,
          vision: Schema.optional(Schema.Boolean),
        }),
      }),
    }),
  ),
})

type Item = Schema.Schema.Type<typeof schema>["data"][number]
const decodeModels = Schema.decodeUnknownSync(schema)

// GitHub Copilot per-token pricing (per 1M tokens, USD)
// Source: https://docs.github.com/copilot/reference/copilot-billing/models-and-pricing
// Anthropic models include cache_write cost; OpenAI/Google models do not.
const COPILOT_PRICING: Record<string, { input: number; output: number; cache_read: number; cache_write?: number }> = {
  // OpenAI
  "gpt-4.1": { input: 2.0, output: 8.0, cache_read: 0.5 },
  "gpt-5-mini": { input: 0.25, output: 2.0, cache_read: 0.025 },
  "gpt-5.2": { input: 1.75, output: 14.0, cache_read: 0.175 },
  "gpt-5.2-codex": { input: 1.75, output: 14.0, cache_read: 0.175 },
  "gpt-5.3-codex": { input: 1.75, output: 14.0, cache_read: 0.175 },
  "gpt-5.4": { input: 2.5, output: 15.0, cache_read: 0.25 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cache_read: 0.075 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25, cache_read: 0.02 },
  "gpt-5.5": { input: 5.0, output: 30.0, cache_read: 0.5 },
  // Anthropic (includes cache_write)
  "claude-haiku-4.5": { input: 1.0, output: 5.0, cache_read: 0.1, cache_write: 1.25 },
  "claude-sonnet-4": { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
  "claude-sonnet-4.5": { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
  "claude-sonnet-4.6": { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
  "claude-opus-4.5": { input: 5.0, output: 25.0, cache_read: 0.5, cache_write: 6.25 },
  "claude-opus-4.6": { input: 5.0, output: 25.0, cache_read: 0.5, cache_write: 6.25 },
  "claude-opus-4.7": { input: 5.0, output: 25.0, cache_read: 0.5, cache_write: 6.25 },
  "claude-opus-4.8": { input: 5.0, output: 25.0, cache_read: 0.5, cache_write: 6.25 },
  // Google
  "gemini-2.5-pro": { input: 1.25, output: 10.0, cache_read: 0.125 },
  "gemini-3-flash": { input: 0.5, output: 3.0, cache_read: 0.05 },
  "gemini-3.1-pro": { input: 2.0, output: 12.0, cache_read: 0.2 },
  "gemini-3.5-flash": { input: 1.5, output: 9.0, cache_read: 0.15 },
  // Fine-tuned (GitHub)
  "raptor-mini": { input: 0.25, output: 2.0, cache_read: 0.025 },
}

function build(key: string, remote: Item, url: string, prev?: Model): Model {
  const reasoning =
    !!remote.capabilities.supports.adaptive_thinking ||
    !!remote.capabilities.supports.reasoning_effort?.length ||
    remote.capabilities.supports.max_thinking_budget !== undefined ||
    remote.capabilities.supports.min_thinking_budget !== undefined
  const image =
    (remote.capabilities.supports.vision ?? false) ||
    (remote.capabilities.limits.vision?.supported_media_types ?? []).some((item) => item.startsWith("image/"))

  const isMsgApi = remote.supported_endpoints?.includes("/v1/messages")

  // Look up pricing by API model ID; fall back to 0 for unknown models
  const pricing = COPILOT_PRICING[remote.id]

  const model: Model = {
    id: key,
    providerID: "github-copilot",
    api: {
      id: remote.id,
      url: isMsgApi ? `${url}/v1` : url,
      npm: isMsgApi ? "@ai-sdk/anthropic" : "@ai-sdk/github-copilot",
    },
    // API response wins
    status: "active",
    limit: {
      context: remote.capabilities.limits.max_context_window_tokens ?? 0,
      input: remote.capabilities.limits.max_prompt_tokens ?? 0,
      output: remote.capabilities.limits.max_output_tokens ?? 0,
    },
    capabilities: {
      temperature: prev?.capabilities.temperature ?? true,
      reasoning: prev?.capabilities.reasoning ?? reasoning,
      attachment: prev?.capabilities.attachment ?? true,
      toolcall: remote.capabilities.supports.tool_calls,
      input: {
        text: true,
        audio: false,
        image,
        video: false,
        pdf: false,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
    // existing wins
    family: prev?.family ?? remote.capabilities.family,
    name: prev?.name ?? remote.name,
    cost: pricing
      ? {
          input: pricing.input,
          output: pricing.output,
          cache: {
            read: pricing.cache_read,
            write: pricing.cache_write ?? 0,
          },
        }
      : {
          input: 0,
          output: 0,
          cache: { read: 0, write: 0 },
        },
    options: prev?.options ?? {},
    headers: prev?.headers ?? {},
    release_date:
      prev?.release_date ??
      (remote.version.startsWith(`${remote.id}-`) ? remote.version.slice(remote.id.length + 1) : remote.version),
  }

  const efforts = remote.capabilities.supports.reasoning_effort
  const variants: NonNullable<Model["variants"]> = {}
  if (!isMsgApi && efforts?.length) {
    efforts.forEach((effort) => {
      variants[effort] = {
        reasoningEffort: effort,
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      }
    })
  } else {
    if (efforts?.length && remote.capabilities.supports.adaptive_thinking) {
      efforts.forEach((effort) => {
        variants[effort] = {
          thinking: {
            type: "adaptive",
            ...(model.api.id.includes("opus-4.7") ? { display: "summarized" } : {}),
          },
          effort,
        }
      })
    } else if (remote.capabilities.supports.max_thinking_budget) {
      const max = remote.capabilities.supports.max_thinking_budget
      variants["max"] = {
        thinking: {
          type: "enabled",
          budgetTokens: max - 1,
        },
      }
      variants["high"] = {
        thinking: {
          type: "enabled",
          budgetTokens: Math.floor(max / 2),
        },
      }
    }
  }
  if (Object.keys(variants).length > 0) {
    model.variants = variants
  }

  return model
}

export async function get(
  baseURL: string,
  headers: HeadersInit = {},
  existing: Record<string, Model> = {},
): Promise<Record<string, Model>> {
  const data = await fetch(`${baseURL}/models`, {
    headers,
    signal: AbortSignal.timeout(5_000),
  }).then(async (res) => {
    if (!res.ok) {
      throw new Error(`Failed to fetch models: ${res.status}`)
    }
    return decodeModels(await res.json())
  })

  const result = { ...existing }
  const remote = new Map(
    data.data.filter((m) => m.model_picker_enabled && m.policy?.state !== "disabled").map((m) => [m.id, m] as const),
  )

  // prune existing models whose api.id isn't in the endpoint response
  for (const [key, model] of Object.entries(result)) {
    const m = remote.get(model.api.id)
    if (!m) {
      delete result[key]
      continue
    }
    result[key] = build(key, m, baseURL, model)
  }

  // add new endpoint models not already keyed in result
  for (const [id, m] of remote) {
    if (id in result) continue
    result[id] = build(id, m, baseURL)
  }

  return result
}

export * as CopilotModels from "./models"
