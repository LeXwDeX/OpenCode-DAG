import * as Tool from "./tool"
import { SkillPlugin } from "@opencode-ai/core/plugin/skill"
import { Effect, Option, Schema } from "effect"
import { Dag } from "@/dag/dag"
import type { NodeConfig, WorkflowConfig } from "@/dag/dag"

const id = "workflow"

// ============================================================================
// Schemas (flat Struct with action discriminator — matches codebase convention)
// ============================================================================

const NodeSchema = Schema.Struct({
  id: Schema.String.annotate({ description: "Unique node identifier, used in depends_on" }),
  name: Schema.String.annotate({ description: "Human-readable node name" }),
  worker_type: Schema.String.annotate({ description: "Agent type (explore, build, general, plan, or custom)" }),
  depends_on: Schema.Array(Schema.String).annotate({ description: "Node IDs this node waits for ([] for root)" }),
  required: Schema.optional(Schema.Boolean).annotate({ description: "If true and this node fails, the workflow is cancelled. Default: false" }),
  prompt_template: Schema.Struct({
    id: Schema.optional(Schema.String),
    inline: Schema.optional(Schema.String),
    input: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }).annotate({ description: 'Template: { id: "..." } or { inline: "...", input: {...} }' }),
  worker_config: Schema.optional(
    Schema.Struct({
      timeout_ms: Schema.optional(Schema.Number),
    }),
  ).annotate({ description: "{ timeout_ms } — bounds node execution (defaults to 10 minutes)" }),
  input_mapping: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({ description: "Map upstream node outputs into template variables" }),
  report_to_parent: Schema.optional(Schema.Boolean).annotate({ description: "If true, the parent agent is woken when this node completes or fails" }),
  condition: Schema.optional(Schema.String).annotate({ description: "Expression evaluated before spawn; node is skipped if false" }),
  model: Schema.optional(Schema.Struct({ modelID: Schema.String, providerID: Schema.String })).annotate({ description: "{ modelID, providerID } override for this node" }),
  restart: Schema.optional(Schema.Boolean).annotate({ description: "(replan only) Re-spawn this running node with new prompt" }),
  cancel: Schema.optional(Schema.Boolean).annotate({ description: "(replan only) Cancel this node" }),
  output_schema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({ description: "JSON Schema; child agent must call submit_result to submit structured output" }),
})

const WorkflowGraphSchema = Schema.Struct({
  name: Schema.String.annotate({ description: "Workflow name" }),
  max_concurrency: Schema.optional(Schema.Number).annotate({ description: "Max parallel nodes. Default: 5" }),
  max_node_replan_attempts: Schema.optional(Schema.Number).annotate({ description: "Max replan restarts per node ID. Default: 5" }),
  max_total_nodes: Schema.optional(Schema.Number).annotate({ description: "Cumulative node cap across the workflow lifetime. Default: 100" }),
  nodes: Schema.Array(NodeSchema).annotate({ description: "Node declarations" }),
})

export const Parameters = Schema.Struct({
  action: Schema.Literals(["start", "extend", "control"]).annotate({ description: "start: create workflow; extend: add nodes; control: pause/resume/cancel/replan/step/complete" }),
  config: Schema.optional(WorkflowGraphSchema).annotate({ description: "(start) Workflow graph definition" }),
  session_id: Schema.optional(Schema.String).annotate({ description: "(start) Parent session ID" }),
  project_id: Schema.optional(Schema.String).annotate({ description: "(start) Project ID" }),
  title: Schema.optional(Schema.String).annotate({ description: "(start) Workflow title" }),
  workflow_id: Schema.optional(Schema.String).annotate({ description: "(extend/control) Target workflow ID" }),
  nodes: Schema.optional(Schema.Array(NodeSchema)).annotate({ description: "(extend) Nodes to add" }),
  operation: Schema.optional(Schema.Literals(["pause", "resume", "cancel", "replan", "step", "complete"])).annotate({ description: "(control) Operation to perform" }),
  fragment: Schema.optional(WorkflowGraphSchema).annotate({ description: "(control replan) Replan fragment with node definitions" }),
})

// ============================================================================
// Tool definition
// ============================================================================

type Metadata = { workflowId?: string; added?: string[]; cancel?: string[]; restart?: string[]; replace?: string[] }

export const WorkflowTool = Tool.define<typeof Parameters, Metadata, Dag.Service>(
  id,
  Effect.gen(function* () {
    return {
      description: SkillPlugin.WorkflowContent,
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
              const r = yield* dag.extend(params.workflow_id, params.nodes as NodeConfig[]).pipe(Effect.orDie)
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
