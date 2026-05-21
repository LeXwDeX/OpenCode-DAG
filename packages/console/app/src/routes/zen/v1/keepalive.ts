// @ts-nocheck
import { env } from "cloudflare:workers"
import { createHash } from "crypto"
import { ZenData } from "@opencode-ai/console-core/model.js"

export async function GET() {
  const zenData = ZenData.list("full")
  return new Response(
    JSON.stringify(
      {
        hash: createHash("sha1").update(JSON.stringify(zenData)).digest("hex"),
        timestamp: Date.now(),
        FOO: env.FOO,
        SST_RESOURCE_FOO: env.SST_RESOURCE_FOO,
        check1: zenData.models["alpha-di-k2.6"],
        check2: zenData.models["qwen3.6-plus-free"],
        MODELS1: SST_RESOURCE_ZEN_MODELS1,
        MODELS2: SST_RESOURCE_ZEN_MODELS2,
        MODELS3: SST_RESOURCE_ZEN_MODELS3,
        MODELS4: SST_RESOURCE_ZEN_MODELS4,
        MODELS5: SST_RESOURCE_ZEN_MODELS5,
        MODELS6: SST_RESOURCE_ZEN_MODELS6,
        MODELS7: SST_RESOURCE_ZEN_MODELS7,
        MODELS8: SST_RESOURCE_ZEN_MODELS8,
        MODELS9: SST_RESOURCE_ZEN_MODELS9,
        MODELS10: SST_RESOURCE_ZEN_MODELS10,
        MODELS11: SST_RESOURCE_ZEN_MODELS11,
        MODELS12: SST_RESOURCE_ZEN_MODELS12,
        MODELS13: SST_RESOURCE_ZEN_MODELS13,
        MODELS14: SST_RESOURCE_ZEN_MODELS14,
        MODELS15: SST_RESOURCE_ZEN_MODELS15,
        MODELS16: SST_RESOURCE_ZEN_MODELS16,
        MODELS17: SST_RESOURCE_ZEN_MODELS17,
        MODELS18: SST_RESOURCE_ZEN_MODELS18,
        MODELS19: SST_RESOURCE_ZEN_MODELS19,
        MODELS20: SST_RESOURCE_ZEN_MODELS20,
        MODELS21: SST_RESOURCE_ZEN_MODELS21,
        MODELS22: SST_RESOURCE_ZEN_MODELS22,
        MODELS23: SST_RESOURCE_ZEN_MODELS23,
        MODELS24: SST_RESOURCE_ZEN_MODELS24,
        MODELS25: SST_RESOURCE_ZEN_MODELS25,
        MODELS26: SST_RESOURCE_ZEN_MODELS26,
        MODELS27: SST_RESOURCE_ZEN_MODELS27,
        MODELS28: SST_RESOURCE_ZEN_MODELS28,
        MODELS29: SST_RESOURCE_ZEN_MODELS29,
        MODELS30: SST_RESOURCE_ZEN_MODELS30,
      },
      null,
      2,
    ),
    {
      headers: {
        "Content-Type": "application/json",
      },
    },
  )
}
