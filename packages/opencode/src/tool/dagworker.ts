// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * DAGWorker Tool
 * 
 * Provides workflow execution capabilities through LLM tool calls.
 * This tool allows the LLM to:
 * - Start workflows
 * - Check workflow status
 * - Cancel workflows
 * - Pause and resume workflows
 * - List all workflows
 */

import * as Tool from "./tool"
import DESCRIPTION from "./dagworker.txt"
import { Schema, Effect, Option } from "effect"
import { Session } from "@/session/session"
import { Agent } from "@/agent/agent"
import { SettingsHook } from "@/hook/settings"
import { EffectBridge } from "@/effect/bridge"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { WorkflowEngine, getReadyNodes } from "../dag/session/workflow-engine"
import type { WorkflowStatusSnapshot } from "../dag/session/workflow-engine"
import { DAGSessionService } from "../dag/session/session-service"
import type { IDAGSessionService } from "../dag/session/session-service"
import type { DAGConfig, DAGNodeSession, DAGViolation, DAGWorkflowSession, ReplanPatch, ReplanResult } from "../dag/session/types"
import {
  bootstrapWorkflowFromConfig,
  type WorkerTypeAgentRegistry,
  type BootstrapCheckFn,
} from "../dag/session/core-start"
import { runBootstrapCheck, buildBootstrapCheckQAPrompt } from "../dag/session/dag-config-check"
// Re-export for backward compatibility: existing consumers (dagworker.test.ts
// and any future code) continue to import these from "./dagworker".
export { validateWorkerTypes, type WorkerTypeAgentRegistry } from "../dag/session/core-start"
import {
  DAG_TEMPLATE_IDS,
  listDAGTemplates,
  getDAGTemplate,
  instantiateDAGTemplate,
  type DAGTemplateInput,
} from "../dag/integration/templates"

/**
 * worker_type resolution
 *
 * The `agent.get(node.config.worker_type)` call in
 * `workflow-engine.ts:spawnReadyNode` resolves the agent by name from the
 * active `Agent.Service` registry.
 *
 * Default registered agents usually include `build`, `plan`, `general`,
 * `explore`; `scout` availability depends on the experimental-scout
 * feature flag. Names such as `implement`, `verify`, `review`,
 * `archgate`, `patcher` are **user-defined custom agents** and must
 * be configured under opencode.json / opencode.jsonc via the singular
 * `agent` field (NOT `agents`):
 *   `{ "agent": { "implement": {...}, "verify": {...} } }`
 *
 * Runtime fail-fast validation (P0a, commit 1b425ddc2): `dagworker
 * start` validates all unique `worker_type` values against the active
 * `Agent.Service` registry BEFORE creating any workflow rows. If any
 * worker_type is unknown, start fails with an actionable error that
 * lists currently registered agent names (via `agentService.list()`)
 * and points to the singular `agent.*` config location.
 *
 * When constructing DAGs programmatically or via LLM, ensure every
 * `worker_type` is either a currently registered built-in or has been
 * wired into the singular `agent.*` config before calling `dagworker
 * start`.
 */
const id = "dagworker"

export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Union([
    Schema.Literal("start"),
    Schema.Literal("status"),
    Schema.Literal("cancel"),
    Schema.Literal("list"),
    Schema.Literal("replan"),
    Schema.Literal("template_list"),
    Schema.Literal("template_show"),
    Schema.Literal("template_start"),
    Schema.Literal("node_detail"),
    Schema.Literal("history"),
    Schema.Literal("logs"),
    Schema.Literal("pause"),
    Schema.Literal("resume"),
    Schema.Literal("step"),
  ])).annotate({
    description: "Action to perform. Defaults to 'start' if not specified.",
  }),
  workflow: Schema.optional(Schema.String).annotate({
    description: "Workflow configuration (JSON string) for 'start' action, or workflow ID for 'status'/'cancel' actions.",
  }),
  wait: Schema.optional(Schema.Boolean).annotate({
    description: "For 'start' action: wait for workflow completion before returning. Defaults to false (async).",
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "Maximum execution time in milliseconds for the workflow.",
  }),
  patch: Schema.optional(Schema.String).annotate({
    description: "JSON-stringified ReplanPatch for 'replan' action. Shape: {workflow_id, add_nodes?, remove_nodes?, update_nodes?, new_max_concurrency?, changed_by?}",
  }),
  previewOnly: Schema.optional(Schema.Boolean).annotate({
    description: "For 'replan' action: when true, validates and previews the patch without applying it.",
  }),
  template_id: Schema.optional(Schema.String).annotate({
    description: `Template id for 'template_show' / 'template_start'. One of: ${DAG_TEMPLATE_IDS.join(", ")}.`,
  }),
  template_input: Schema.optional(Schema.String).annotate({
    description: "JSON-stringified DAGTemplateInput for 'template_show' / 'template_start'. Requires at least {goal:string}. Optional for 'template_show' (uses empty goal).",
  }),
  node_id: Schema.optional(Schema.String).annotate({
    description: "Node ID for 'node_detail' or 'logs' action.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum number of results for 'history' or 'logs' action. Defaults to 100.",
  }),
})

function formatOutput(text: string): string {
  return [
    "<dagworker_result>",
    text,
    "</dagworker_result>",
  ].join("\n")
}

/**
 * 将毫秒时长格式化为人类直读字符串（整数秒精度，供 agent 直接使用，无需自己做 epoch 数学）。
 *
 * - < 1s   → "0s"
 * - < 1min → "12s"
 * - >=1min → "3m 12s" / "1h 5m 12s"
 *
 * 这是超时误判 bug 的根治点：agent（LLM）对裸 epoch 毫秒数（如 1781533800017）
 * 做减法极易出错，产生幻觉式耗时判断。harness 直接输出精确到秒的已过时长，
 * agent 只需读字符串即可正确感知时间。
 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "unknown"
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 1) return "0s"
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/**
 * 格式化 workflow status 输出（agent 可读文本）。
 *
 * 时间呈现铁律（超时误判 bug 根治）：所有耗时字段都由 harness 预计算为
 * 精确到秒的人类可读字符串（formatDuration），agent 无需对裸 epoch ms
 * 做任何数学运算。workflow 级输出 created(ISO) + elapsed；
 * per-node 摘要输出每个节点的 status + elapsed + since_update，
 * 让 agent 一眼看清"哪个节点跑了多久""哪个节点多久没动"。
 */
function formatWorkflowStatus(
  workflowId: string,
  workflow: DAGWorkflowSession,
  status: WorkflowStatusSnapshot,
  nodes: DAGNodeSession[],
): string {
  const now = Date.now()
  const wfElapsedMs = workflow.end_time != null
    ? workflow.end_time - workflow.start_time
    : now - workflow.start_time
  const lines = [
    `Workflow ${workflowId}:`,
    `  Name: ${workflow.config.name}`,
    `  Status: ${status.status}`,
    `  Created: ${new Date(workflow.created_at).toISOString()}`,
    `  Elapsed: ${formatDuration(wfElapsedMs)}${workflow.duration_ms != null ? ` (final, duration=${formatDuration(workflow.duration_ms)})` : ""}`,
    `  Nodes: ${status.totalNodes} total | ${status.completedNodes} completed | ${status.failedNodes} failed | ${status.runningNodes} running | ${status.readyNodes} ready`,
    `  Violations: ${status.violations_count}`,
  ]

  if (status.violations.length > 0) {
    lines.push("  Violation Details:")
    status.violations.forEach((v, i) => {
      lines.push(`    ${i + 1}. [${v.severity}] ${v.type}: ${v.message}`)
    })
  }

  // Per-node 摘要：每个节点一行，含 status + 已运行时长 + 距上次更新时长。
  // 这是 agent 判断"是否卡住/超时"的直接依据——无需自己算 epoch 差值。
  if (nodes.length > 0) {
    lines.push("", "  Nodes:")
    for (const node of nodes) {
      const nodeElapsedMs = node.start_time != null
        ? (node.end_time ?? node.completed_at ?? now) - node.start_time
        : null
      const sinceUpdateMs = now - node.updated_at
      const cfgId = node.node_id.includes("::") ? node.node_id.split("::")[1] : node.node_id
      const parts = [`    - ${cfgId} [${node.status}]`]
      if (nodeElapsedMs != null) {
        parts.push(`elapsed=${formatDuration(nodeElapsedMs)}`)
      }
      // running 节点额外给 since_update（"多久没动"），是判断卡死的关键信号
      if (node.status === "running" || node.status === "queued") {
        parts.push(`since_update=${formatDuration(sinceUpdateMs)}`)
      }
      if (node.retry_count > 0) {
        parts.push(`retries=${node.retry_count}/${node.max_retries}`)
      }
      lines.push(parts.join(" "))
    }
  }

  return lines.join("\n")
}

/**
 * Thin adapter (tool path) for `bootstrapWorkflowFromConfig` (WP-D1 core).
 *
 * Destructures Tool.Context → extracts chatSessionId / promptOps,
 * then delegates to the headless core function. Returns the new workflow id
 * and node count.
 *
 * All substantive startup logic (validation, DB rows, engine assembly, daemon)
 * lives in core-start.ts (single source — architecture
 * constraint 1). This adapter preserves the original startWorkflowFromConfig
 * external signature for backward compatibility with existing callers
 * (cases "start" and "template_start" in the DAGWorkerTool switch).
 *
 * **promptOps extraction** is adapter-only logic here (not in core) because
 * `ctx.extra?.promptOps` is the turn-binding point the core function abstracts
 * over. If absent, fails with the same error as before (backward compat).
 *
 * §4.3 初始化检查：当 opencode.json `dag.bootstrap_check === true` 时，
 * 从 Config + Provider 服务构建 BootstrapCheckFn 注入 core 函数。
 * 检查失败时 core 函数 fail，返回的错误消息包含可用模型分级供 agent 驱动 QA。
 */
export const startWorkflowFromConfig = Effect.fn("dagworker.startWorkflowFromConfig")(function* (args: {
  workflowConfig: DAGConfig
  ctx: Tool.Context
  dagSessionService: IDAGSessionService
  agentService: WorkerTypeAgentRegistry
}) {
  const { workflowConfig, ctx, dagSessionService, agentService } = args

  const promptOps = ctx.extra?.promptOps as import("@/session/prompt-ops").PromptOps | undefined
  if (!promptOps) {
    return yield* Effect.fail(
      new Error("dagworker requires promptOps in ctx.extra — must be called inside a session prompt turn"),
    )
  }

  // §4.3 构建初始化检查函数（best-effort，Config/Provider 服务不可用时返回 undefined）。
  const effectiveBootstrapCheckFn = yield* buildBootstrapCheckFn()

  return yield* bootstrapWorkflowFromConfig({
    dagConfig: workflowConfig,
    chatSessionId: ctx.sessionID,
    promptOps,
    dagSessionService,
    agentService,
    bootstrapCheckFn: effectiveBootstrapCheckFn,
  })
})

/**
 * 构建 §4.3 初始化检查函数。
 * 当 Config/Provider 服务不可用时返回 undefined（跳过检查，向后兼容）。
 */
function buildBootstrapCheckFn(): Effect.Effect<BootstrapCheckFn | undefined, never> {
  return Effect.gen(function* () {
    // 检查 Config 服务是否可用（serviceOption 不 fail，返回 Option）
    const configService = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
    if (!configService) return undefined

    // 读取当前配置
    const opencodeConfig = yield* configService.get().pipe(
      Effect.catchCause(() => Effect.succeed(undefined as Config.Info | undefined)),
    )

    // 如果 dag.bootstrap_check 未启用，不注入检查函数（向后兼容）
    if (!opencodeConfig?.dag?.bootstrap_check) return undefined

    // 获取已注册的 provider 列表（best-effort）
    const providerService = Option.getOrUndefined(yield* Effect.serviceOption(Provider.Service))
    let registeredProviders: string[] = []
    if (providerService) {
      const providerMap = yield* providerService.list().pipe(
        Effect.catchCause(() => Effect.succeed({} as Record<string, unknown>)),
      )
      registeredProviders = Object.keys(providerMap)
    }

    // 返回检查函数（闭包捕获 config 和 providers）
    return ((dagConfig: DAGConfig) =>
      Effect.gen(function* () {
        const result = yield* runBootstrapCheck({
          dagConfig,
          opencodeConfig,
          registeredProviders,
        })
        if (result.ok) {
          return { ok: true as const, warnings: result.warnings }
        }
        // 构建包含可用模型分级的 QA 提示（agent 可据此枚举模型供用户选择）
        const qaPrompt = buildBootstrapCheckQAPrompt(result)
        return {
          ok: false as const,
          errors: [qaPrompt],
          warnings: result.warnings,
        }
      })) satisfies BootstrapCheckFn
  }).pipe(
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
}

export const DAGWorkerTool = Tool.define(
  id,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const settingsHook = yield* SettingsHook.Service
    const dagSessionService = yield* DAGSessionService.make
    const agentService = yield* Agent.Service
    
    const run = Effect.fn("DAGWorkerTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const action = params.action || "start"
      
      yield* ctx.ask({
        permission: id,
        patterns: [action],
        always: ["*"],
        metadata: {
          action,
          workflow: params.workflow,
        },
      })
      
      // Get the session
      const session = yield* sessions.get(ctx.sessionID)
      if (!session) {
        return yield* Effect.fail(new Error(`Session not found: ${ctx.sessionID}`))
      }
      
      switch (action) {
        case "start": {
          if (!params.workflow) {
            return yield* Effect.fail(
              new Error("'start' action requires 'workflow' parameter with workflow configuration")
            )
          }
          
          const workflowConfigStr = params.workflow
          
          let workflowConfig: DAGConfig
          try {
            workflowConfig = JSON.parse(workflowConfigStr)
          } catch (e) {
            return yield* Effect.fail(
              new Error(`Invalid workflow configuration: ${e instanceof Error ? e.message : String(e)}`)
            )
          }

          const started = yield* startWorkflowFromConfig({
            workflowConfig,
            ctx,
            dagSessionService,
            agentService,
          })
          
          return {
            title: `Workflow started: ${started.workflowId}`,
            output: JSON.stringify({
              workflowId: started.workflowId,
              message: "Workflow started in background",
              nodes: started.nodeCount,
            }),
            metadata: {
              workflowId: started.workflowId,
              action: "start",
              wait: params.wait ?? false,
            } as Record<string, unknown>,
            attachments: [],
          }
        }
        
        case "status": {
          if (!params.workflow) {
            return yield* Effect.fail(
              new Error("'status' action requires 'workflow' parameter with workflow ID")
            )
          }
          
          const workflowId = params.workflow
          const workflow = yield* dagSessionService.getWorkflow(workflowId)
          if (!workflow) {
            return yield* Effect.fail(new Error(`Workflow not found: ${workflowId}`))
          }
          
          // WP3: Read-only path via sessionService (no orphan WorkflowEngine.make).
          // Mirrors getWorkflowStatus in workflow-engine.ts for the snapshot shape.
          const allNodes = yield* dagSessionService.listNodes(workflowId).pipe(
            Effect.catchCause(() => Effect.succeed([] as DAGNodeSession[])),
          )
          const violations = yield* dagSessionService.listViolations(workflowId).pipe(
            Effect.catchCause(() => Effect.succeed([] as DAGViolation[])),
          )
          
          const completedNodeIds = new Set<string>(
            allNodes.filter((n: DAGNodeSession) => n.status === "completed").map((n: DAGNodeSession) => n.node_id)
          )
          const failedNodeIds = new Set<string>(
            allNodes.filter((n: DAGNodeSession) => n.status === "failed").map((n: DAGNodeSession) => n.node_id)
          )
          const runningNodeIds = new Set<string>(
            allNodes.filter((n: DAGNodeSession) => n.status === "running").map((n: DAGNodeSession) => n.node_id)
          )
          const readyNodeList = getReadyNodes(allNodes, completedNodeIds, failedNodeIds, runningNodeIds)
          
          const status: WorkflowStatusSnapshot = {
            workflowId,
            status: workflow.status,
            totalNodes: allNodes.length,
            completedNodes: completedNodeIds.size,
            failedNodes: failedNodeIds.size,
            runningNodes: runningNodeIds.size,
            readyNodes: readyNodeList.length,
            violations,
            violations_count: violations.length,
            timestamp: Date.now(),
          }
          const statusText = formatWorkflowStatus(workflowId, workflow, status, allNodes)
          
          return {
            title: `Workflow Status: ${workflowId}`,
            output: formatOutput(statusText),
            metadata: {
              workflowId,
              action: "status",
              status: status.status as string,
              wait: false,
            },
            attachments: [],
          }
        }
        
        case "cancel": {
          if (!params.workflow) {
            return yield* Effect.fail(
              new Error("'cancel' action requires 'workflow' parameter with workflow ID")
            )
          }
          
          const workflowId = params.workflow
          const workflow = yield* dagSessionService.getWorkflow(workflowId)
          if (!workflow) {
            return yield* Effect.fail(new Error(`Workflow not found: ${workflowId}`))
          }
          
          // WP3: Registry-first pattern (aligns with dag-mutation.ts:56-89 HTTP handler).
          // No orphan WorkflowEngine.make — lookup by runtime registry, fallback to DB write.
          const engine = WorkflowEngine.get(workflowId)
          if (engine) {
            // Idempotent: swallow cause if workflow is already terminal (aligns with dag-mutation.ts:56-75).
            yield* engine.cancelWorkflow(workflowId).pipe(Effect.catchCause(() => Effect.void))
          } else {
            // Fallback: direct DB status update (best-effort, never fails).
            yield* dagSessionService.updateWorkflowStatus(workflowId, "cancelled").pipe(
              Effect.catchCause(() => Effect.void)
            )
          }
          
          return {
            title: `Workflow Cancelled: ${workflowId}`,
            output: formatOutput(`Workflow ${workflowId} has been cancelled.`),
            metadata: {
              workflowId,
              action: "cancel",
            } as any,
            attachments: [],
          }
        }
        
        case "list": {
          const workflows = yield* dagSessionService.listAllWorkflows()
          
          if (workflows.length === 0) {
            return {
              title: "No Workflows",
              output: formatOutput("No workflows found."),
              metadata: {
                action: "list",
                count: 0,
              } as any,
              attachments: [],
            }
          }
          
          const lines = [
            `Found ${workflows.length} workflow(s):`,
            "",
          ]
          
          workflows.forEach((workflow: DAGWorkflowSession, i: number) => {
            lines.push(`${i + 1}. Workflow ${workflow.id}`)
            lines.push(`   Name: ${workflow.config.name}`)
            lines.push(`   Status: ${workflow.status}`)
            lines.push(`   Nodes: ${workflow.config.nodes.length}`)
            lines.push(`   Session: ${workflow.chat_session_id.slice(0, 8)}...`)
            lines.push(`   Created: ${new Date(workflow.created_at).toISOString()}`)
            if (workflow.duration_ms !== null) {
              lines.push(`   Duration: ${workflow.duration_ms}ms`)
            }
            lines.push("")
          })
          
          return {
            title: `Workflows List (${workflows.length})`,
            output: formatOutput(lines.join("\n")),
            metadata: {
              action: "list",
              count: workflows.length,
            } as any,
            attachments: [],
          }
        }

        case "replan": {
          if (!params.patch) {
            return yield* Effect.fail(new Error("'replan' action requires 'patch' parameter (JSON ReplanPatch)"))
          }
          let parsedPatch: ReplanPatch
          try {
            parsedPatch = JSON.parse(params.patch)
          } catch (e) {
            return yield* Effect.fail(new Error(`Invalid patch JSON: ${e instanceof Error ? e.message : String(e)}`))
          }
          if (!parsedPatch.workflow_id) {
            return yield* Effect.fail(new Error("patch.workflow_id is required"))
          }

          // WP3: Registry-required pattern (aligns with dag-mutation.ts:142-154 HTTP handler).
          // No orphan WorkflowEngine.make — replan requires a live in-memory engine.
          const engine = WorkflowEngine.get(parsedPatch.workflow_id)
          if (!engine) {
            return yield* Effect.fail(
              new Error(`No registered engine for workflow '${parsedPatch.workflow_id}'. Replan requires a live running workflow.`)
            )
          }
          if (params.previewOnly === true) {
            const preview = yield* (engine.previewReplanWorkflow
              ? engine.previewReplanWorkflow(parsedPatch.workflow_id, parsedPatch)
              : Effect.succeed({ ok: false as const, reason: "preview_unavailable" }))
            if (!preview.ok) {
              const previewDetail = "detail" in preview ? preview.detail : undefined
              return {
                title: `Replan preview rejected: ${parsedPatch.workflow_id}`,
                output: formatOutput(
                  `Replan preview rejected for ${parsedPatch.workflow_id}:\n  reason: ${preview.reason}${previewDetail ? `\n  detail: ${JSON.stringify(previewDetail)}` : ''}`
                ),
                metadata: {
                  workflowId: parsedPatch.workflow_id,
                  action: 'replan',
                  previewOnly: true,
                  ok: false,
                  reason: preview.reason,
                } as Record<string, unknown>,
                attachments: [],
              }
            }
            return {
              title: `Replan preview: ${preview.workflow_id}`,
              output: formatOutput(JSON.stringify(preview, null, 2)),
              metadata: {
                workflowId: preview.workflow_id,
                action: 'replan',
                previewOnly: true,
                ok: true,
              } as Record<string, unknown>,
              attachments: [],
            }
          }

          const result: ReplanResult = yield* engine.replanWorkflow(parsedPatch.workflow_id, parsedPatch)

          if (!result.ok) {
            return {
              title: `Replan rejected: ${parsedPatch.workflow_id}`,
              output: formatOutput(
                `Replan rejected for ${parsedPatch.workflow_id}:\n  reason: ${result.reason}${result.detail ? `\n  detail: ${JSON.stringify(result.detail)}` : ''}`
              ),
              metadata: {
                workflowId: parsedPatch.workflow_id,
                action: 'replan',
                ok: false,
                reason: result.reason,
              } as any,
              attachments: [],
            }
          }

          return {
            title: `Replan applied: ${result.workflow_id}`,
            output: formatOutput([
              `Replan applied for ${result.workflow_id}:`,
              `  nodes added: ${result.nodes_added}`,
              `  nodes removed: ${result.nodes_removed}`,
              `  nodes updated: ${result.nodes_updated}`,
              `  final total: ${result.final_total}`,
              `  history_id: ${result.history_id}`,
            ].join('\n')),
            metadata: {
              workflowId: result.workflow_id,
              action: 'replan',
              ok: true,
              historyId: result.history_id,
              nodesAdded: result.nodes_added,
              nodesRemoved: result.nodes_removed,
              nodesUpdated: result.nodes_updated,
              finalTotal: result.final_total,
            } as any,
            attachments: [],
          }
        }
        
        case "template_list": {
          const items = listDAGTemplates().map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description,
            tags: t.tags,
            requiredAgents: t.requiredAgents,
          }))
          return {
            title: `DAG Templates (${items.length})`,
            output: formatOutput(JSON.stringify(items, null, 2)),
            metadata: {
              action: "template_list",
              count: items.length,
            } as Record<string, unknown>,
            attachments: [],
          }
        }

        case "template_show": {
          if (!params.template_id) {
            return yield* Effect.fail(
              new Error("'template_show' action requires 'template_id' parameter"),
            )
          }
          const templ = getDAGTemplate(params.template_id)
          if (!templ) {
            return yield* Effect.fail(
              new Error(`Unknown template: ${params.template_id}. Available: ${DAG_TEMPLATE_IDS.join(", ")}`),
            )
          }
          let input: DAGTemplateInput = { goal: "" }
          if (params.template_input) {
            try {
              input = JSON.parse(params.template_input)
            } catch (e) {
              return yield* Effect.fail(
                new Error(`Invalid template_input JSON: ${e instanceof Error ? e.message : String(e)}`),
              )
            }
          }
          const configOrError = templ.create(input)
          return {
            title: `Template: ${templ.id}`,
            output: formatOutput(
              JSON.stringify(
                {
                  id: templ.id,
                  name: templ.name,
                  description: templ.description,
                  tags: templ.tags,
                  requiredAgents: templ.requiredAgents,
                  config: configOrError,
                },
                null,
                2,
              ),
            ),
            metadata: {
              action: "template_show",
              templateId: templ.id,
            } as Record<string, unknown>,
            attachments: [],
          }
        }

        case "template_start": {
          if (!params.template_id) {
            return yield* Effect.fail(
              new Error("'template_start' action requires 'template_id' parameter"),
            )
          }
          const templ = getDAGTemplate(params.template_id)
          if (!templ) {
            return yield* Effect.fail(
              new Error(`Unknown template: ${params.template_id}. Available: ${DAG_TEMPLATE_IDS.join(", ")}`),
            )
          }
          if (!params.template_input) {
            return yield* Effect.fail(
              new Error("'template_start' action requires 'template_input' parameter (JSON with at least {goal})"),
            )
          }
          let input: DAGTemplateInput
          try {
            input = JSON.parse(params.template_input)
          } catch (e) {
            return yield* Effect.fail(
              new Error(`Invalid template_input JSON: ${e instanceof Error ? e.message : String(e)}`),
            )
          }
          const instantiated = instantiateDAGTemplate(params.template_id, input)
          if ("error" in instantiated) {
            return yield* Effect.fail(new Error(instantiated.error))
          }
          const started = yield* startWorkflowFromConfig({
            workflowConfig: instantiated,
            ctx,
            dagSessionService,
            agentService,
          })
          return {
            title: `Workflow started: ${started.workflowId} (template: ${templ.id})`,
            output: JSON.stringify({
              workflowId: started.workflowId,
              templateId: templ.id,
              message: "Template-based workflow started in background",
              nodes: started.nodeCount,
            }),
            metadata: {
              workflowId: started.workflowId,
              action: "template_start",
              templateId: templ.id,
              wait: params.wait ?? false,
            } as Record<string, unknown>,
            attachments: [],
          }
        }

        case "node_detail": {
          if (!params.node_id) {
            return yield* Effect.fail(
              new Error("'node_detail' action requires 'node_id' parameter"),
            )
          }
          const node = yield* dagSessionService.getNode(params.node_id)
          if (!node) {
            return yield* Effect.fail(new Error(`Node not found: ${params.node_id}`))
          }
          // 时间字段：同时提供 ISO 字符串（人类可读）+ 预计算差值（ms），
          // 避免 agent 对裸 epoch ms 做数学运算导致耗时幻觉（超时误判 bug 根因）。
          const now = Date.now()
          const elapsedMs = node.start_time != null
            ? (node.end_time ?? node.completed_at ?? now) - node.start_time
            : null
          const ageMs = now - node.created_at
          const sinceUpdateMs = now - node.updated_at
          return {
            title: `Node: ${node.node_id}`,
            output: JSON.stringify({
              node_id: node.node_id,
              workflow_id: node.workflow_id,
              status: node.status,
              retry_count: node.retry_count,
              max_retries: node.max_retries,
              timeout_ms: node.timeout_ms,
              duration_ms: node.duration_ms,
              error_info: node.error_info ?? null,
              // 人类可读时间（ISO）
              start_time: node.start_time != null ? new Date(node.start_time).toISOString() : null,
              end_time: node.end_time != null ? new Date(node.end_time).toISOString() : null,
              completed_at: node.completed_at != null ? new Date(node.completed_at).toISOString() : null,
              created_at: new Date(node.created_at).toISOString(),
              updated_at: new Date(node.updated_at).toISOString(),
              // 预计算差值（agent 无需做 epoch 数学）
              elapsed_ms: elapsedMs,
              elapsed_human: elapsedMs != null ? formatDuration(elapsedMs) : null,
              age_ms: ageMs,
              age_human: formatDuration(ageMs),
              since_update_ms: sinceUpdateMs,
              since_update_human: formatDuration(sinceUpdateMs),
            }, null, 2),
            metadata: {
              nodeId: node.node_id,
              action: "node_detail",
              status: node.status,
            } as Record<string, unknown>,
            attachments: [],
          }
        }

        case "history": {
          if (!params.workflow) {
            return yield* Effect.fail(
              new Error("'history' action requires 'workflow' parameter with workflow ID"),
            )
          }
          const historyRows = yield* dagSessionService.listHistory(params.workflow, params.limit)
          const formatted = historyRows.map((row) => ({
            history_id: row.history_id,
            action: row.action,
            changed_by: row.changed_by,
            created_at: new Date(row.created_at).toISOString(),
            old_state: row.old_state,
            new_state: row.new_state,
            change_details: row.change_details,
          }))
          return {
            title: `History for ${params.workflow} (${formatted.length})`,
            output: JSON.stringify(formatted, null, 2),
            metadata: {
              workflowId: params.workflow,
              action: "history",
              count: formatted.length,
            } as Record<string, unknown>,
            attachments: [],
          }
        }

        case "logs": {
          if (!params.node_id) {
            return yield* Effect.fail(
              new Error("'logs' action requires 'node_id' parameter"),
            )
          }
          const logRows = yield* dagSessionService.listNodeLogs(params.node_id, params.limit)
          const formatted = logRows.map((row) => ({
            log_id: row.log_id,
            log_level: row.log_level,
            log_message: row.log_message,
            log_data: row.log_data,
            execution_phase: row.execution_phase,
            created_at: new Date(row.created_at).toISOString(),
          }))
          return {
            title: `Logs for ${params.node_id} (${formatted.length})`,
            output: JSON.stringify(formatted, null, 2),
            metadata: {
              nodeId: params.node_id,
              action: "logs",
              count: formatted.length,
            } as Record<string, unknown>,
            attachments: [],
          }
        }
        
        case "pause": {
          if (!params.workflow) {
            return yield* Effect.fail(
              new Error("'pause' action requires 'workflow' parameter with workflow ID")
            )
          }
          const workflowId = params.workflow
          const engine = WorkflowEngine.get(workflowId)
          if (!engine) {
            const workflow = yield* dagSessionService.getWorkflow(workflowId)
            return {
              title: `Pause failed: ${workflowId}`,
              output: formatOutput(
                `Cannot pause workflow ${workflowId}: no active engine found. Current DB status: ${workflow?.status ?? "unknown"}`
              ),
              metadata: {
                workflowId,
                action: "pause",
                error: "engine_not_found",
                currentStatus: workflow?.status ?? "unknown",
              } as Record<string, unknown>,
              attachments: [],
            }
          }
          const pauseStatus = yield* engine.pauseWorkflow(workflowId)
          return {
            title: `Workflow Paused: ${workflowId}`,
            output: formatOutput(`Workflow ${workflowId} has been paused. Status: ${pauseStatus}`),
            metadata: {
              workflowId,
              action: "pause",
              status: pauseStatus as string,
            } as Record<string, unknown>,
            attachments: [],
          }
        }

        case "resume": {
          if (!params.workflow) {
            return yield* Effect.fail(
              new Error("'resume' action requires 'workflow' parameter with workflow ID")
            )
          }
          const workflowId = params.workflow
          const engine = WorkflowEngine.get(workflowId)
          if (!engine) {
            const workflow = yield* dagSessionService.getWorkflow(workflowId)
            return {
              title: `Resume failed: ${workflowId}`,
              output: formatOutput(
                `Cannot resume workflow ${workflowId}: no active engine found. Current DB status: ${workflow?.status ?? "unknown"}`
              ),
              metadata: {
                workflowId,
                action: "resume",
                error: "engine_not_found",
                currentStatus: workflow?.status ?? "unknown",
              } as Record<string, unknown>,
              attachments: [],
            }
          }
          const resumeStatus = yield* engine.resumeWorkflow(workflowId)
          return {
            title: `Workflow Resumed: ${workflowId}`,
            output: formatOutput(`Workflow ${workflowId} has been resumed. Status: ${resumeStatus}`),
            metadata: {
              workflowId,
              action: "resume",
              status: resumeStatus as string,
            } as Record<string, unknown>,
            attachments: [],
          }
        }

        case "step": {
          if (!params.workflow) {
            return yield* Effect.fail(
              new Error("'step' action requires 'workflow' parameter with workflow ID")
            )
          }
          const workflowId = params.workflow
          const engine = WorkflowEngine.get(workflowId)
          if (!engine) {
            const workflow = yield* dagSessionService.getWorkflow(workflowId)
            return {
              title: `Step failed: ${workflowId}`,
              output: formatOutput(
                `Cannot step workflow ${workflowId}: no active engine found. Current DB status: ${workflow?.status ?? "unknown"}`
              ),
              metadata: {
                workflowId,
                action: "step",
                error: "engine_not_found",
                currentStatus: workflow?.status ?? "unknown",
              } as Record<string, unknown>,
              attachments: [],
            }
          }
          const stepResult = yield* engine.stepWorkflow(workflowId)
          if (stepResult.ok) {
            return {
              title: `Step completed: ${stepResult.node_id}`,
              output: formatOutput(
                `Node ${stepResult.node_id} completed successfully. Workflow status remains paused.`
              ),
              metadata: {
                workflowId,
                action: "step",
                nodeId: stepResult.node_id,
                nodeStatus: stepResult.status,
              } as Record<string, unknown>,
              attachments: [],
            }
          }
          return {
            title: `Step failed: ${workflowId}`,
            output: formatOutput(
              `Step rejected: reason=${stepResult.reason}${"node_id" in stepResult ? ` node=${stepResult.node_id}` : ""}${"error" in stepResult ? ` error=${stepResult.error}` : ""}`
            ),
            metadata: {
              workflowId,
              action: "step",
              ok: false,
              reason: stepResult.reason,
            } as Record<string, unknown>,
            attachments: [],
          }
        }
        
        default:
          return yield* Effect.fail(new Error(`Unknown action: ${action}`))
      }
    })
    
    return {
      id,
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(
          Effect.catch((e: unknown) =>
            Effect.succeed({
              title: `DAG Worker Error: ${params.action || 'unknown'}`,
              metadata: {} as any,
              output: `DAG Worker failed: ${e instanceof Error ? e.message : String(e)}`,
              attachments: [],
            }),
          ),
        ),
    }
  })
)
