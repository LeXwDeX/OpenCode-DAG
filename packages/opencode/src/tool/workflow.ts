import * as Tool from "./tool"
import DESCRIPTION from "./workflow.md"
import { Effect, Option, Schema } from "effect"
import { Dag } from "@/dag/dag"
import type { NodeConfig, WorkflowConfig } from "@/dag/dag"

const id = "workflow"

// ============================================================================
// Schemas (flat Struct with action discriminator — matches codebase convention)
// ============================================================================

const NodeSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  worker_type: Schema.String,
  depends_on: Schema.Array(Schema.String),
  required: Schema.optional(Schema.Boolean),
  prompt_template: Schema.Struct({
    id: Schema.optional(Schema.String),
    inline: Schema.optional(Schema.String),
    input: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  worker_config: Schema.optional(
    Schema.Struct({
      use_worktree: Schema.optional(Schema.Boolean),
      timeout_ms: Schema.optional(Schema.Number),
      retry: Schema.optional(Schema.Struct({ max_attempts: Schema.Number, delay_ms: Schema.Number })),
    }),
  ),
  input_mapping: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  report_to_parent: Schema.optional(Schema.Boolean),
  condition: Schema.optional(Schema.String),
  model: Schema.optional(Schema.Struct({ modelID: Schema.String, providerID: Schema.String })),
  restart: Schema.optional(Schema.Boolean),
  cancel: Schema.optional(Schema.Boolean),
  output_schema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

const WorkflowGraphSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  max_concurrency: Schema.optional(Schema.Number),
  timeout_ms: Schema.optional(Schema.Number),
  report_strategy: Schema.optional(Schema.Literals(["silent", "on_completion", "on_converge"])),
  replan_policy: Schema.optional(
    Schema.Struct({
      allow_kill_running: Schema.optional(Schema.Boolean),
      orphan_strategy: Schema.optional(Schema.Literals(["auto_cancel", "auto_fail", "rewire_required"])),
    }),
  ),
  max_node_replan_attempts: Schema.optional(Schema.Number),
  max_total_nodes: Schema.optional(Schema.Number),
  nodes: Schema.Array(NodeSchema),
})

export const Parameters = Schema.Struct({
  action: Schema.Literals(["start", "extend", "control"]),
  // start fields
  config: Schema.optional(WorkflowGraphSchema),
  session_id: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  // extend + control fields
  workflow_id: Schema.optional(Schema.String),
  nodes: Schema.optional(Schema.Array(NodeSchema)),
  // control fields
  operation: Schema.optional(Schema.Literals(["pause", "resume", "cancel", "replan", "step", "complete"])),
  fragment: Schema.optional(WorkflowGraphSchema),
})

// ============================================================================
// Tool definition
// ============================================================================

type Metadata = { workflowId?: string; added?: string[]; cancel?: string[]; restart?: string[]; replace?: string[] }

export const WorkflowTool = Tool.define<typeof Parameters, Metadata, Dag.Service>(
  id,
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const dagOpt = yield* Effect.serviceOption(Dag.Service)
          if (Option.isNone(dagOpt)) return yield* Effect.die(new Error("DAG service not wired"))
          const dag = dagOpt.value
          switch (params.action) {
            case "start": {
              if (!params.config) return yield* Effect.die(new Error("start requires 'config'"))
              const dagID = yield* dag.create({
                projectID: params.project_id ?? ctx.sessionID,
                sessionID: params.session_id ?? ctx.sessionID,
                title: params.title ?? params.config.name,
                config: params.config as WorkflowConfig,
              }).pipe(Effect.orDie)
              return {
                title: `Workflow started: ${params.config.name}`,
                output: `<workflow id="${dagID}" state="running">\n${params.config.nodes.length} nodes registered.\n</workflow>`,
                metadata: { workflowId: dagID } as Metadata,
              }
            }
            case "extend": {
              if (!params.workflow_id || !params.nodes) return yield* Effect.die(new Error("extend requires 'workflow_id' and 'nodes'"))
              const r = yield* dag.replan(params.workflow_id, { nodes: params.nodes as NodeConfig[] }).pipe(Effect.orDie)
              return {
                title: `Workflow extended: ${r.add.length} nodes added`,
                output: `<workflow id="${params.workflow_id}" action="extend">\nAdded: ${r.add.join(", ")}\n</workflow>`,
                metadata: { workflowId: params.workflow_id, added: r.add } as Metadata,
              }
            }
            case "control": {
              if (!params.workflow_id || !params.operation) return yield* Effect.die(new Error("control requires 'workflow_id' and 'operation'"))
              const wfId = params.workflow_id
              switch (params.operation) {
                case "pause":
                  yield* dag.pause(wfId).pipe(Effect.orDie)
                  return { title: "Workflow paused", output: `<workflow id="${wfId}" state="paused"/>`, metadata: { workflowId: wfId } as Metadata }
                case "resume":
                  yield* dag.resume(wfId).pipe(Effect.orDie)
                  return { title: "Workflow resumed", output: `<workflow id="${wfId}" state="running"/>`, metadata: { workflowId: wfId } as Metadata }
                case "cancel":
                  yield* dag.cancel(wfId).pipe(Effect.orDie)
                  return { title: "Workflow cancelled", output: `<workflow id="${wfId}" state="cancelled"/>`, metadata: { workflowId: wfId } as Metadata }
                case "complete":
                  yield* dag.complete(wfId).pipe(Effect.orDie)
                  return { title: "Workflow completed (early)", output: `<workflow id="${wfId}" state="completed"/>`, metadata: { workflowId: wfId } as Metadata }
                case "replan": {
                  if (!params.fragment) return yield* Effect.die(new Error("replan operation requires 'fragment'"))
                  const r = yield* dag.replan(wfId, { nodes: params.fragment.nodes as NodeConfig[] }).pipe(Effect.orDie)
                  return {
                    title: `Workflow replanned: +${r.add.length} -${r.cancel.length} ↻${r.restart.length}`,
                    output: `<workflow id="${wfId}" action="replan">\nAdded: ${r.add.join(", ")}\nCancelled: ${r.cancel.join(", ")}\nRestarted: ${r.restart.join(", ")}\nReplaced: ${r.replace.join(", ")}\n</workflow>`,
                    metadata: { workflowId: wfId, ...r } as Metadata,
                  }
                }
                case "step":
                  yield* dag.pause(wfId).pipe(Effect.orDie)
                  return { title: "Workflow stepped (paused)", output: `<workflow id="${wfId}" state="paused" action="step"/>`, metadata: { workflowId: wfId } as Metadata }
              }
            }
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
