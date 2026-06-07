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
 * - List all workflows
 */

import * as Tool from "./tool"
import DESCRIPTION from "./dagworker.txt"
import { Schema, Effect } from "effect"
import { Session } from "@/session/session"
import { Agent } from "@/agent/agent"
import { SettingsHook } from "@/hook/settings"
import { EffectBridge } from "@/effect/bridge"
import { WorkflowEngine, registerEngine } from "../dag/session/workflow-engine"
import type { WorkflowStatusSnapshot } from "../dag/session/workflow-engine"
import type { WorkflowExecutor } from "../dag/session/workflow-executor"
import { createWorkflowExecutor } from "../dag/session/workflow-executor"
import { DAGSessionService } from "../dag/session/session-service"
import type { IDAGSessionService } from "../dag/session/session-service"
import type { DAGConfig, DAGNodeConfig, DAGWorkflowSession, ReplanPatch } from "../dag/session/types"
import { RequiredNodesValidator } from "../dag/session/required-nodes-validator"
import type { PromptOps } from "@/session/prompt-ops"
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
  template_id: Schema.optional(Schema.String).annotate({
    description: `Template id for 'template_show' / 'template_start'. One of: ${DAG_TEMPLATE_IDS.join(", ")}.`,
  }),
  template_input: Schema.optional(Schema.String).annotate({
    description: "JSON-stringified DAGTemplateInput for 'template_show' / 'template_start'. Requires at least {goal:string}. Optional for 'template_show' (uses empty goal).",
  }),
})

function formatOutput(text: string): string {
  return [
    "<dagworker_result>",
    text,
    "</dagworker_result>",
  ].join("\n")
}

function formatWorkflowStatus(workflowId: string, workflow: DAGWorkflowSession, status: WorkflowStatusSnapshot): string {
  const lines = [
    `Workflow ${workflowId}:`,
    `  Name: ${workflow.config.name}`,
    `  Status: ${status.status}`,
    `  Total Nodes: ${status.totalNodes}`,
    `  Completed: ${status.completedNodes}`,
    `  Failed: ${status.failedNodes}`,
    `  Running: ${status.runningNodes}`,
    `  Ready: ${status.readyNodes}`,
    `  Violations: ${status.violations_count}`,
  ]
  
  if (status.violations.length > 0) {
    lines.push("  Violation Details:")
    status.violations.forEach((v, i) => {
      lines.push(`    ${i + 1}. [${v.severity}] ${v.type}: ${v.message}`)
    })
  }
  
  if (workflow.duration_ms !== null) {
    lines.push(`  Duration: ${workflow.duration_ms}ms`)
  }
  
  return lines.join("\n")
}

export type WorkerTypeAgentRegistry = {
  readonly get: (agent: string) => Effect.Effect<Agent.Info | undefined, unknown>
  readonly list: () => Effect.Effect<Agent.Info[], unknown>
}

export const validateWorkerTypes = (
  agentService: WorkerTypeAgentRegistry,
  nodes: DAGNodeConfig[],
) =>
  Effect.gen(function* () {
    const unique = [...new Set(nodes.map((n) => n.worker_type))]
    const missing: string[] = []
    for (const workerType of unique) {
      const found = yield* agentService.get(workerType).pipe(
        Effect.catchCause(() => Effect.succeed(undefined)),
      )
      if (!found) missing.push(workerType)
    }
    if (missing.length === 0) return
    const registered = yield* agentService.list().pipe(
      Effect.catchCause(() => Effect.succeed([] as Agent.Info[])),
    )
    const names = registered.map((a) => a.name).sort()
    return yield* Effect.fail(
      new Error(
        `Unknown DAG worker_type: ${missing.join(", ")}. Currently registered agents: ${names.length ? names.join(", ") : "<none>"}. Configure custom agents in opencode.json agent.* or change worker_type before starting DAG.`,
      ),
    )
  })

/**
 * Shared start workflow body used by both the `start` and `template_start`
 * actions. Performs validation, materialises nodes with namespaced IDs,
 * registers a WorkflowEngine, forks the executor daemon and wires the
 * abort listener. Returns the new workflow id and node count.
 */
export const startWorkflowFromConfig = Effect.fn("dagworker.startWorkflowFromConfig")(function* (args: {
  workflowConfig: DAGConfig
  ctx: Tool.Context
  dagSessionService: IDAGSessionService
  agentService: WorkerTypeAgentRegistry
}) {
  const { workflowConfig, ctx, dagSessionService, agentService } = args

  const validator = new RequiredNodesValidator()
  const validationResult = validator.validate(workflowConfig)

  if (!validationResult.valid) {
    const errorsText = validationResult.errors.map((e, i) => `${i + 1}. ${e}`).join("\n")
    return yield* Effect.fail(new Error(`Invalid workflow configuration:\n${errorsText}`))
  }

  if (validationResult.warnings.length > 0) {
    const warningsText = validationResult.warnings.map((w, i) => `⚠️ ${w}`).join("\n")
    console.warn(`Workflow configuration warnings:\n${warningsText}`)
  }

  yield* validateWorkerTypes(agentService, workflowConfig.nodes)

  const workflow = yield* dagSessionService.createWorkflow({
    chatSessionId: ctx.sessionID,
    name: workflowConfig.name,
    config: workflowConfig,
  })

  for (const cfg of workflowConfig.nodes) {
    yield* dagSessionService.createNode({
      workflowId: workflow.id,
      nodeId: `${workflow.id}::${cfg.id}`,
      name: cfg.name,
      nodeName: cfg.name,
      nodeType: cfg.worker_type,
      config: cfg,
      dependencyNodes: (cfg.dependencies ?? []).map((d: string) => `${workflow.id}::${d}`),
      timeoutMs: cfg.timeout_ms,
      retryCount: 0,
      maxRetries: cfg.retry?.max_attempts ?? 0,
    })
  }

  const promptOps = ctx.extra?.promptOps as PromptOps | undefined
  if (!promptOps) {
    return yield* Effect.fail(
      new Error("dagworker requires promptOps in ctx.extra — must be called inside a session prompt turn"),
    )
  }

  const workflowEngine = yield* WorkflowEngine.make
  workflowEngine.setPromptOps(promptOps)
  const executor: WorkflowExecutor = createWorkflowExecutor(workflowEngine, workflowConfig)

  registerEngine(workflow.id, workflowEngine)
  yield* workflowEngine.startWorkflow(workflow.id, workflowConfig)
  yield* executor.start(workflow.id).pipe(Effect.forkDetach)

  const onAbort = () => {
    Effect.runPromise(workflowEngine.cancelWorkflow(workflow.id).pipe(Effect.ignore))
  }
  ctx.abort.addEventListener("abort", onAbort, { once: true })

  return { workflowId: workflow.id, nodeCount: workflowConfig.nodes.length }
})

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
          
          const workflowEngine = yield* WorkflowEngine.make
          const executor: WorkflowExecutor = createWorkflowExecutor(workflowEngine, workflow.config)
          
          const status = yield* executor.getStatus(workflowId)
          const statusText = formatWorkflowStatus(workflowId, workflow, status)
          
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
          
          const workflowEngine = yield* WorkflowEngine.make
          yield* workflowEngine.cancelWorkflow(workflowId)
          
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

          const workflowEngine = yield* WorkflowEngine.make
          const result = yield* workflowEngine.replanWorkflow(parsedPatch.workflow_id, parsedPatch)

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
