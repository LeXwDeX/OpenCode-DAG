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
import { WorkflowEngine } from "../dag/session/workflow-engine"
import type { WorkflowStatusSnapshot } from "../dag/session/workflow-engine"
import type { WorkflowExecutor } from "../dag/session/workflow-executor"
import { createWorkflowExecutor } from "../dag/session/workflow-executor"
import { DAGSessionService } from "../dag/session/session-service"
import type { DAGConfig, DAGWorkflowSession } from "../dag/session/types"
import { RequiredNodesValidator } from "../dag/session/required-nodes-validator"

const id = "dagworker"

export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Union([
    Schema.Literal("start"),
    Schema.Literal("status"),
    Schema.Literal("cancel"),
    Schema.Literal("list")
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
          
          // Create workflow engine and executor
          const workflowEngine = yield* WorkflowEngine.make
          const executor: WorkflowExecutor = createWorkflowExecutor(workflowEngine, workflowConfig)
          
          // Start workflow
          yield* executor.start(workflow.id)
          
          return {
            title: `Workflow Started: ${workflow.id}`,
            output: JSON.stringify({
              workflowId: workflow.id,
              message: "Workflow started successfully",
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
