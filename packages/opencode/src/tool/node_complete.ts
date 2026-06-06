import * as Tool from "./tool"
import DESCRIPTION from "./node_complete.txt"
import { Schema, Effect } from "effect"
import { WorkflowEngine } from "../dag/session/workflow-engine"

const id = "node_complete"

export const Parameters = Schema.Struct({
  node_id: Schema.String.annotate({
    description: "The namespaced node id (${workflowId}::${cfgId}) to signal completion for",
  }),
  status: Schema.Union([Schema.Literal("completed"), Schema.Literal("failed")]).annotate({
    description: "Completion status. Use 'failed' only for fatal errors.",
  }),
  output: Schema.optional(Schema.String).annotate({
    description: "Structured result text (used on 'completed').",
  }),
  error: Schema.optional(Schema.String).annotate({
    description: "Error message (used on 'failed').",
  }),
})

export const NodeCompleteTool = Tool.define(
  id,
  Effect.gen(function* () {
    const run = Effect.fn("NodeCompleteTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      _ctx: Tool.Context,
    ) {
      const workflowId = params.node_id.split("::")[0]
      const engine = WorkflowEngine.get(workflowId)
      if (!engine) {
        return yield* Effect.fail(new Error(`No running workflow for node: ${params.node_id}`))
      }

      if (params.status === "completed") {
        yield* engine.handleNodeCompletion(workflowId, params.node_id, params.output ?? "")
      } else {
        yield* engine.handleNodeFailure(workflowId, params.node_id, new Error(params.error ?? "node reported failure"))
      }

      return {
        title: `Signaled ${params.status}: ${params.node_id}`,
        output: `${params.node_id} marked ${params.status}.`,
        metadata: { nodeId: params.node_id, status: params.status } as any,
        attachments: [],
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
              title: `node_complete error: ${params.node_id}`,
              metadata: {} as any,
              output: `node_complete failed: ${e instanceof Error ? e.message : String(e)}`,
              attachments: [],
            }),
          ),
        ),
    }
  }),
)
