/**
 * DAG node spawn — reuses the `task` tool's spawn path.
 *
 * A ready node spawns a real child Session through the same contract as task.ts:
 * Agent.Service.get → Session.Service.create(parentID) → deriveSubagentSessionPermission → promptOps.prompt.
 *
 * Completion model (mirrors task.ts:210-221): a node completes when its child
 * session's prompt() resolves; it fails when prompt() fails. The completion
 * signal (NodeCompleted / NodeFailed) is published from inside the forked
 * execution fiber, preserving concurrency.
 *
 * Output (Level 1): the final text part of the prompt result, same extraction
 * as task.ts. Structured field-level output for input_mapping/condition
 * (Level 2) is a documented boundary — see eval.ts.
 */

import { Effect, Semaphore, Scope, Fiber, Schema, Option } from "effect"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "@/session/schema"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { SessionPrompt } from "@/session/prompt"
import { Dag } from "../dag"
import { InvalidTransitionError } from "@opencode-ai/core/dag/core/types"
import type { DagStore } from "@opencode-ai/core/dag/store"

type PromptParts = SessionPrompt.PromptInput["parts"]

const parseJsonOption = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

function validateAgainstSchema(parsed: unknown, schema: Record<string, unknown>): boolean {
  const required = schema["required"]
  if (Array.isArray(required) && typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>
    if (!required.every((field) => typeof field === "string" && field in obj)) return false
  }
  const type = schema["type"]
  if (typeof type === "string") {
    if (type === "object" && (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))) return false
    if (type === "array" && !Array.isArray(parsed)) return false
    if (type === "string" && typeof parsed !== "string") return false
    if (type === "number" && typeof parsed !== "number") return false
    if (type === "boolean" && typeof parsed !== "boolean") return false
  }
  return true
}

const extractStructuredOutput = Effect.fn("Dag.extractStructuredOutput")(function* (rawText: string, outputSchema: Record<string, unknown>) {
  const parsed = parseJsonOption(rawText)
  if (Option.isNone(parsed)) {
    yield* Effect.logWarning("DAG node output schema not satisfied: invalid JSON", { nodeOutput: rawText.slice(0, 200) })
    return rawText
  }
  if (!validateAgainstSchema(parsed.value, outputSchema)) {
    yield* Effect.logWarning("DAG node output schema not satisfied: parsed JSON does not match declared schema")
    return rawText
  }
  return parsed.value
})

export interface NodeSpawnInput {
  dagID: string
  nodeID: string
  node: DagStore.NodeRow
  parentSessionID: string
  promptParts: PromptParts
  outputSchema?: Record<string, unknown>
}

export interface NodeSpawnResult {
  childSessionID: string
  fiber: Fiber.Fiber<unknown, unknown>
}

export function spawnNode(
  semaphore: Semaphore.Semaphore,
  input: NodeSpawnInput,
): Effect.Effect<NodeSpawnResult, Error, Dag.Service | Agent.Service | Session.Service | SessionPrompt.Service | Scope.Scope> {
  return Effect.gen(function* () {
    const dag = yield* Dag.Service
    const agentService = yield* Agent.Service
    const sessions = yield* Session.Service
    const promptSvc = yield* SessionPrompt.Service
    const scope = yield* Scope.Scope

    const agent = yield* agentService.get(input.node.workerType).pipe(
      Effect.catchCause(() => Effect.succeed(undefined)),
    )
    if (!agent) {
      yield* dag.nodeFailed(input.dagID, input.nodeID, `unknown worker_type: ${input.node.workerType}`, "exec_failed")
      return yield* Effect.fail(new Error(`Unknown worker_type: ${input.node.workerType}`))
    }

    const nodeModel =
      input.node.modelId && input.node.modelProviderId
        ? { modelID: input.node.modelId as never, providerID: input.node.modelProviderId as never }
        : undefined
    const model = nodeModel
      ?? (agent.model ? { modelID: agent.model.modelID, providerID: agent.model.providerID } : undefined)
    if (!model) {
      yield* dag.nodeFailed(input.dagID, input.nodeID, `no model configured for agent: ${agent.name}`, "exec_failed")
      return yield* Effect.fail(new Error(`No model configured for agent: ${agent.name}`))
    }

    const parent = yield* sessions.get(SessionID.make(input.parentSessionID))
    const childPermission = deriveSubagentSessionPermission({
      parentSessionPermission: parent.permission ?? [],
      subagent: agent,
    })

    const childSession = yield* sessions.create({
      parentID: SessionID.make(input.parentSessionID),
      title: `${input.node.name} (DAG node)`,
      agent: agent.name,
      permission: childPermission,
    })

    yield* dag.nodeStarted(input.dagID, input.nodeID, childSession.id)

    const fiber = yield* Effect.forkIn(scope)(
      semaphore.withPermits(1)(
        Effect.gen(function* () {
          const result = yield* promptSvc.prompt({
            messageID: MessageID.ascending(),
            sessionID: childSession.id,
            model,
            agent: agent.name,
            parts: input.promptParts,
          })
          const rawText = result.parts.findLast((p) => p.type === "text")?.text ?? ""
          const output = input.outputSchema
            ? yield* extractStructuredOutput(rawText, input.outputSchema)
            : rawText
          yield* dag.nodeCompleted(input.dagID, input.nodeID, output).pipe(
            Effect.catchIf(
              (err): err is InvalidTransitionError => err instanceof InvalidTransitionError,
              () => Effect.logWarning("nodeCompleted guard rejected — node already terminal"),
            ),
          )
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* dag.nodeFailed(input.dagID, input.nodeID, String(cause), "exec_failed").pipe(
                Effect.catchIf(
                  (err): err is InvalidTransitionError => err instanceof InvalidTransitionError,
                  () => Effect.logWarning("nodeFailed guard rejected — node already terminal"),
                ),
              )
            }),
          ),
        ),
      ),
    )

    return { childSessionID: childSession.id as string, fiber }
  })
}
