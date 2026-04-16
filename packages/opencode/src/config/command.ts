import { Log } from "../util"
import path from "path"
import z from "zod"
import { NamedError } from "@opencode-ai/shared/util/error"
import { Glob } from "@opencode-ai/shared/util/glob"
import { Bus } from "@/bus"
import * as ConfigMarkdown from "./markdown"
import { InvalidError } from "./paths"

const ModelId = z.string().meta({ $ref: "https://models.dev/model-schema.json#/$defs/Model" })

const log = Log.create({ service: "config" })

function rel(item: string, patterns: string[]) {
  const normalizedItem = item.replaceAll("\\", "/")
  for (const pattern of patterns) {
    const index = normalizedItem.indexOf(pattern)
    if (index === -1) continue
    return normalizedItem.slice(index + pattern.length)
  }
}

function trim(file: string) {
  const ext = path.extname(file)
  return ext.length ? file.slice(0, -ext.length) : file
}

export namespace ConfigCommand {
  export const Info = z.object({
    template: z.string(),
    description: z.string().optional(),
    agent: z.string().optional(),
    model: ModelId.optional(),
    subtask: z.boolean().optional(),
  })

  export type Info = z.infer<typeof Info>

  export async function load(dir: string) {
    const result: Record<string, Info> = {}
    for (const item of await Glob.scan("{command,commands}/**/*.md", {
      cwd: dir,
      absolute: true,
      dot: true,
      symlink: true,
    })) {
      const md = await ConfigMarkdown.parse(item).catch(async (err) => {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse command ${item}`
        const { Session } = await import("@/session")
        void Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load command", { command: item, err })
        return undefined
      })
      if (!md) continue

      const patterns = ["/.opencode/command/", "/.opencode/commands/", "/command/", "/commands/"]
      const file = rel(item, patterns) ?? path.basename(item)
      const name = trim(file)

      const config = {
        name,
        ...md.data,
        template: md.content.trim(),
      }
      const parsed = Info.safeParse(config)
      if (parsed.success) {
        result[config.name] = parsed.data
        continue
      }
      throw new InvalidError({ path: item, issues: parsed.error.issues }, { cause: parsed.error })
    }
    return result
  }
}
