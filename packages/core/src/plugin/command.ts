/// <reference path="../markdown.d.ts" />

export * as CommandPlugin from "./command"

import { define } from "./internal"
import { Effect } from "effect"
import { Location } from "../location"
import PROMPT_INITIALIZE from "./command/initialize.txt"
import PROMPT_REVIEW from "./command/review.txt"
import DAG_FLOW_PROMPT from "./command/dag-flow.txt"
import workflowContent from "./command/workflow.md" with { type: "text" }

export const DagFlowDescription = "Start a dependency-graph multi-agent workflow for the supplied task"
export const WorkflowContent = workflowContent
export const DagFlowContent = `${DAG_FLOW_PROMPT}\n\n${WorkflowContent}`

export const Plugin = define({
  id: "command",
  effect: Effect.fn(function* (ctx) {
    const location = yield* Location.Service
    yield* ctx.command.transform((draft) => {
      draft.update("init", (command) => {
        command.template = PROMPT_INITIALIZE.replace("${path}", location.project.directory)
        command.description = "guided AGENTS.md setup"
      })
      draft.update("review", (command) => {
        command.template = PROMPT_REVIEW.replace("${path}", location.project.directory)
        command.description = "review changes [commit|branch|pr], defaults to uncommitted"
        command.subtask = true
      })
      draft.update("dag-flow", (command) => {
        command.template = DagFlowContent
        command.description = DagFlowDescription
      })
    })
  }),
})
