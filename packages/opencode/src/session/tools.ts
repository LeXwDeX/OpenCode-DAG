import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { ModelID } from "@/provider/schema"
import { Plugin } from "@/plugin"
import { SettingsHook } from "@/hook/settings" // [FORK:tool-hooks]
import type { TaskPromptOps } from "@/tool/task"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { Effect, Cause } from "effect"
import { MessageV2 } from "./message-v2"
import * as Session from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import * as Log from "@opencode-ai/core/util/log"
import { EffectBridge } from "@/effect/bridge"

const log = Log.create({ service: "session.tools" })

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  messages: MessageV2.WithParts[]
  promptOps: TaskPromptOps
}) {
  using _ = log.time("resolveTools")
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service
  const settingsHook = yield* SettingsHook.Service // [FORK:tool-hooks]

  const context = (args: Record<string, unknown>, options: ToolExecutionOptions): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps },
    agent: input.agent.name,
    messages: input.messages,
    metadata: (val) =>
      input.processor.updateToolCall(options.toolCallId, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        return {
          ...match,
          state: {
            title: val.title,
            metadata: val.metadata,
            status: "running",
            input: args,
            time: { start: Date.now() },
          },
        }
      }),
    ask: (req) =>
      permission
        .ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
        })
        .pipe(Effect.orDie),
  })

  for (const item of yield* registry.tools({
    modelID: ModelID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
  })) {
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    tools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const ctx = context(args, options)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
              { args },
            )

            // ── [FORK:tool-hooks] PreToolUse settings hook ──
            const preHook = yield* settingsHook.trigger(
              { event: "PreToolUse", toolName: item.id, toolInput: args },
              { sessionID: ctx.sessionID, transcriptPath: "" },
            )
            // CC contract: permissionDecision="deny" short-circuits before execution
            if (preHook.permissionDecision === "deny") {
              const reason = preHook.permissionDecisionReason ?? "Denied by hook"
              return { title: "", metadata: {}, output: `Hook denied: ${reason}` }
            }
            if (preHook.blocked) {
              return { title: "", metadata: {}, output: `Hook blocked: ${preHook.blocked.reason}` }
            }
            // CC contract: continue=false short-circuits tool execution
            if (preHook.preventContinuation) {
              const reason = preHook.stopReason ?? "Hook requested stop"
              return { title: "", metadata: {}, output: `Hook stopped: ${reason}` }
            }
            // CC contract: hookSpecificOutput.updatedInput rewrites tool args
            const effectiveArgs = preHook.updatedInput ?? args

            const result = yield* item.execute(effectiveArgs, ctx).pipe(
              // [FORK:tool-hooks] PostToolUseFailure fires when tool execution fails
              Effect.tapCause((cause: Cause.Cause<unknown>) =>
                Effect.gen(function* () {
                  const err = cause.reasons.find(Cause.isFailReason)?.error
                  if (err === undefined) return
                  // Permission/Question rejections are control-flow, not tool failures
                  if (err instanceof Permission.RejectedError || err instanceof Question.RejectedError) return
                  yield* settingsHook.trigger(
                    {
                      event: "PostToolUseFailure",
                      toolName: item.id,
                      toolInput: effectiveArgs,
                      error: err instanceof Error ? err.message : String(err),
                    },
                    { sessionID: ctx.sessionID, transcriptPath: "" },
                  )
                }).pipe(Effect.ignore),
              ),
            )

            // ── Abort check immediately after execute (before hooks) ──
            // When aborted, finalize the tool call with raw result and return.
            // PostToolUse hooks are skipped to avoid interrupting the finalization.
            if (options.abortSignal?.aborted) {
              const output = {
                ...result,
                attachments: result.attachments?.map((attachment) => ({
                  ...attachment,
                  id: PartID.ascending(),
                  sessionID: ctx.sessionID,
                  messageID: input.processor.message.id,
                })),
              }
              yield* input.processor.completeToolCall(options.toolCallId, output)
              return output
            }

            // ── [FORK:tool-hooks] PostToolUse settings hook ──
            const postHook = yield* settingsHook.trigger(
              {
                event: "PostToolUse",
                toolName: item.id,
                toolInput: effectiveArgs,
                toolResponse: result.output,
              },
              { sessionID: ctx.sessionID, transcriptPath: "" },
            )

            // ── [FORK:tool-hooks] FileChanged for edit/write ──
            if (item.id === "edit" || item.id === "write") {
              const filePath = (effectiveArgs as { filePath?: unknown }).filePath
              if (typeof filePath === "string") {
                yield* settingsHook
                  .trigger(
                    { event: "FileChanged", path: filePath, changeType: item.id },
                    { sessionID: ctx.sessionID, transcriptPath: "" },
                  )
                  .pipe(Effect.ignore)
              }
            }

            // Aggregate hook additionalContexts
            const postContexts = postHook.preventContinuation ? [] : postHook.additionalContexts
            const hookContexts = [...preHook.additionalContexts, ...postContexts]

            const output = {
              ...result,
              output:
                hookContexts.length > 0
                  ? result.output +
                    hookContexts.map((c) => `\n<hook_additional_context>${c}</hook_additional_context>`).join("")
                  : result.output,
              attachments: result.attachments?.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
              output,
            )
            return output
          }),
        )
      },
    })
  }

  for (const [key, item] of Object.entries(yield* mcp.tools())) {
    const execute = item.execute
    if (!execute) continue

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    const transformed = ProviderTransform.schema(input.model, schema)
    item.inputSchema = jsonSchema(transformed)
    item.execute = (args, opts) =>
      run.promise(
        Effect.gen(function* () {
          const ctx = context(args, opts)
          yield* plugin.trigger(
            "tool.execute.before",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )

          // ── [FORK:tool-hooks] PreToolUse settings hook for MCP tools ──
          const preHook = yield* settingsHook.trigger(
            { event: "PreToolUse", toolName: key, toolInput: args },
            { sessionID: ctx.sessionID, transcriptPath: "" },
          )
          if (preHook.permissionDecision === "deny") {
            const reason = preHook.permissionDecisionReason ?? "Denied by hook"
            return { title: "", metadata: {}, output: `Hook denied: ${reason}`, content: [{ type: "text" as const, text: `Hook denied: ${reason}` }] }
          }
          if (preHook.blocked) {
            return { title: "", metadata: {}, output: `Hook blocked: ${preHook.blocked.reason}`, content: [{ type: "text" as const, text: `Hook blocked: ${preHook.blocked.reason}` }] }
          }
          if (preHook.preventContinuation) {
            const reason = preHook.stopReason ?? "Hook requested stop"
            return { title: "", metadata: {}, output: `Hook stopped: ${reason}`, content: [{ type: "text" as const, text: `Hook stopped: ${reason}` }] }
          }
          const effectiveArgs = preHook.updatedInput ?? args

          const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
            yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
            return yield* Effect.promise(() => execute(effectiveArgs, opts))
          }).pipe(
            Effect.withSpan("Tool.execute", {
              attributes: {
                "tool.name": key,
                "tool.call_id": opts.toolCallId,
                "session.id": ctx.sessionID,
                "message.id": input.processor.message.id,
              },
            }),
            // [FORK:tool-hooks] PostToolUseFailure for MCP tools
            Effect.tapCause((cause: Cause.Cause<unknown>) =>
              Effect.gen(function* () {
                const err = cause.reasons.find(Cause.isFailReason)?.error
                if (err === undefined) return
                if (err instanceof Permission.RejectedError || err instanceof Question.RejectedError) return
                yield* settingsHook.trigger(
                  {
                    event: "PostToolUseFailure",
                    toolName: key,
                    toolInput: effectiveArgs,
                    error: err instanceof Error ? err.message : String(err),
                  },
                  { sessionID: ctx.sessionID, transcriptPath: "" },
                )
              }).pipe(Effect.ignore),
            ),
          )

          // ── Abort check immediately after execute (before hooks) ──
          if (opts.abortSignal?.aborted) {
            const textParts: string[] = []
            const attachments: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[] = []
            for (const contentItem of result.content) {
              if (contentItem.type === "text") textParts.push(contentItem.text)
              else if (contentItem.type === "image") {
                attachments.push({
                  type: "file",
                  mime: contentItem.mimeType,
                  url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
                })
              } else if (contentItem.type === "resource") {
                const { resource } = contentItem
                if (resource.text) textParts.push(resource.text)
                if (resource.blob) {
                  attachments.push({
                    type: "file",
                    mime: resource.mimeType ?? "application/octet-stream",
                    url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                    filename: resource.uri,
                  })
                }
              }
            }
            const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
            const output = {
              title: "",
              metadata: { ...result.metadata, truncated: truncated.truncated, ...(truncated.truncated && { outputPath: truncated.outputPath }) },
              output: truncated.content,
              attachments: attachments.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
              content: result.content,
            }
            yield* input.processor.completeToolCall(opts.toolCallId, output)
            return output
          }

          // Extract text output for PostToolUse hook
          const textOutput = result.content
            .filter((c: { type: string }): c is { type: "text"; text: string } => c.type === "text")
            .map((c: { type: "text"; text: string }) => c.text)
            .join("\n")

          // ── [FORK:tool-hooks] PostToolUse settings hook for MCP tools ──
          const postHook = yield* settingsHook.trigger(
            {
              event: "PostToolUse",
              toolName: key,
              toolInput: effectiveArgs,
              toolResponse: textOutput,
            },
            { sessionID: ctx.sessionID, transcriptPath: "" },
          )

          yield* plugin.trigger(
            "tool.execute.after",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
            result,
          )

          const textParts: string[] = []
          const attachments: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[] = []
          for (const contentItem of result.content) {
            if (contentItem.type === "text") textParts.push(contentItem.text)
            else if (contentItem.type === "image") {
              attachments.push({
                type: "file",
                mime: contentItem.mimeType,
                url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
              })
            } else if (contentItem.type === "resource") {
              const { resource } = contentItem
              if (resource.text) textParts.push(resource.text)
              if (resource.blob) {
                attachments.push({
                  type: "file",
                  mime: resource.mimeType ?? "application/octet-stream",
                  url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                  filename: resource.uri,
                })
              }
            }
          }

          const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
          const metadata = {
            ...result.metadata,
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          }

          // [FORK:tool-hooks] Aggregate hook additionalContexts
          const postContexts = postHook.preventContinuation ? [] : postHook.additionalContexts
          const hookContexts = [...preHook.additionalContexts, ...postContexts]

          const output = {
            title: "",
            metadata,
            output:
              hookContexts.length > 0
                ? truncated.content +
                  hookContexts.map((c) => `\n<hook_additional_context>${c}</hook_additional_context>`).join("")
                : truncated.content,
            attachments: attachments.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
            content: result.content,
          }
          return output
        }),
      )
    tools[key] = item
  }

  return tools
})

export * as SessionTools from "./tools"
