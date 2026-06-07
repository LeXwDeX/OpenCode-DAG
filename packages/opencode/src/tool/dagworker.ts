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
import { SettingsHook } from "@/hook/settings"
import { EffectBridge } from "@/effect/bridge"
import { WorkflowEngine, registerEngine } from "../dag/session/workflow-engine"
import type { WorkflowStatusSnapshot } from "../dag/session/workflow-engine"
import type { WorkflowExecutor } from "../dag/session/workflow-executor"
import { createWorkflowExecutor } from "../dag/session/workflow-executor"
import { DAGSessionService } from "../dag/session/session-service"
import type { DAGConfig, DAGNodeConfig, DAGWorkflowSession, ReplanPatch } from "../dag/session/types"
import { RequiredNodesValidator } from "../dag/session/required-nodes-validator"
import type { PromptOps } from "@/session/prompt-ops"

/**
 * worker_type resolution
 *
 * The `agent.get(node.config.worker_type)` call in
 * `workflow-engine.ts:spawnReadyNode` resolves the agent by name from the
 * `Agent.Service` registry.
 *
 * Built-in agents (always available): `build`, `plan`, `general`, `explore`,
 * `scout`.
 *
 * Many documented examples (USER_GUIDE.md, dagworker-reference.md,
 * dag-worker.txt) use `implement`, `verify`, `review`, `archgate`, etc.
 * These are NOT built-in — they are **user-defined custom agents** that must
 * be configured via opencode.json / opencode.jsonc:
 *   `{ "agents": { "implement": {...}, "verify": {...} } }`
 *
 * If the LLM constructs a DAG using `worker_type: "implement"` without the
 * user having configured a custom `implement` agent, the spawn will fail at
 * runtime with an `agent.get()` error.
 *
 * When constructing DAGs programmatically or via LLM, always verify that
 * `worker_type` is either a built-in or a user-configured custom agent
 * before calling `dagworker start`.
 */
const id = "dagworker"

export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Union([
    Schema.Literal("start"),
    Schema.Literal("status"),
    Schema.Literal("cancel"),
    Schema.Literal("list"),
    Schema.Literal("replan"),
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

export const DAGWorkerTool = Tool.define(
  id,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const settingsHook = yield* SettingsHook.Service
    const dagSessionService = yield* DAGSessionService.make
    
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
          
          // Parse workflow configuration
          let workflowConfig: DAGConfig
          try {
            workflowConfig = JSON.parse(workflowConfigStr)
          } catch (e) {
            return yield* Effect.fail(
              new Error(`Invalid workflow configuration: ${e instanceof Error ? e.message : String(e)}`)
            )
          }
          
          // Validate workflow configuration
          const validator = new RequiredNodesValidator()
          const validationResult = validator.validate(workflowConfig)
          
          if (!validationResult.valid) {
            const errorsText = validationResult.errors.map((e, i) => `${i + 1}. ${e}`).join("\n")
            return yield* Effect.fail(
              new Error(`Invalid workflow configuration:\n${errorsText}`)
            )
          }
          
          if (validationResult.warnings.length > 0) {
            const warningsText = validationResult.warnings.map((w, i) => `⚠️ ${w}`).join("\n")
            console.warn(`Workflow configuration warnings:\n${warningsText}`)
          }
          
          // Create workflow
          const workflow = yield* dagSessionService.createWorkflow({
            chatSessionId: ctx.sessionID,
            name: workflowConfig.name,
            config: workflowConfig,
          })

          // Materialize nodes with namespaced IDs (${workflowId}::${cfgId})
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

          // Wire promptOps (required for subagent spawning)
          const promptOps = ctx.extra?.promptOps as PromptOps | undefined
          if (!promptOps) {
            return yield* Effect.fail(new Error("dagworker requires promptOps in ctx.extra — must be called inside a session prompt turn"))
          }

          // Create workflow engine and executor
          const workflowEngine = yield* WorkflowEngine.make
          workflowEngine.setPromptOps(promptOps)
          const executor: WorkflowExecutor = createWorkflowExecutor(workflowEngine, workflowConfig)

          // Register engine in global registry (enables node_complete tool routing)
          registerEngine(workflow.id, workflowEngine)

          // Start workflow status update
          yield* workflowEngine.startWorkflow(workflow.id, workflowConfig)

          // Fork executor daemon (dagworker returns immediately)
          yield* executor.start(workflow.id).pipe(Effect.forkDetach)

          // Abort listener: cancel workflow on parent abort
          const onAbort = () => {
            Effect.runPromise(workflowEngine.cancelWorkflow(workflow.id).pipe(Effect.ignore))
          }
          ctx.abort.addEventListener("abort", onAbort, { once: true })

          return {
            title: `Workflow Started: ${workflow.id}`,
            output: JSON.stringify({
              workflowId: workflow.id,
              message: "Workflow started in background",
              nodes: workflow.config.nodes.length,
            }),
            metadata: {
              workflowId: workflow.id,
              action: "start",
              wait: params.wait ?? false,
            },
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
