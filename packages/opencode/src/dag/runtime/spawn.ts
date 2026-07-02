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

import { Effect, Semaphore } from "effect"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "@/session/schema"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import type { TaskPromptOps } from "@/tool/task"
import { Dag } from "../dag"
import type { DagStore } from "@opencode-ai/core/dag/store"
import type { SessionPrompt } from "@/session/prompt"

type PromptParts = SessionPrompt.PromptInput["parts"]

export interface NodeSpawnInput {
  dagID: string
  nodeID: string
  node: DagStore.NodeRow
  parentSessionID: string
  parentModelID: string
  parentProviderID: string
  promptParts: PromptParts
  promptOps: TaskPromptOps
}

export interface NodeSpawnResult {
  childSessionID: string
}

/**
 * Spawn a DAG node as a real child session, under the concurrency semaphore.
 *
 * Returns after publishing NodeStarted and forking the prompt. Completion
 * (NodeCompleted or NodeFailed) is published from inside the forked fiber
 * when the prompt resolves or fails — the caller does not wait for it.
 */
export function spawnNode(
  semaphore: Semaphore.Semaphore,
  input: NodeSpawnInput,
): Effect.Effect<NodeSpawnResult, Error, Dag.Service | Agent.Service | Session.Service> {
  return Effect.gen(function* () {
    const dag = yield* Dag.Service
    const agentService = yield* Agent.Service
    const sessions = yield* Session.Service

    // 1. Resolve agent
    const agent = yield* agentService.get(input.node.workerType).pipe(
      Effect.catchCause(() => Effect.succeed(undefined)),
    )
    if (!agent) {
      yield* dag.nodeFailed(input.dagID, input.nodeID, `unknown worker_type: ${input.node.workerType}`, "exec_failed")
      return yield* Effect.fail(new Error(`Unknown worker_type: ${input.node.workerType}`))
    }

    // 2. Derive permissions (same as task.ts)
    const parent = yield* sessions.get(SessionID.make(input.parentSessionID))
    const childPermission = deriveSubagentSessionPermission({
      parentSessionPermission: parent.permission ?? [],
      subagent: agent,
    })

    // 3. Create child session
    const childSession = yield* sessions.create({
      parentID: SessionID.make(input.parentSessionID),
      title: `${input.node.name} (DAG node)`,
      agent: agent.name,
      permission: childPermission,
    })

    // 4. Publish NodeStarted
    yield* dag.nodeStarted(input.dagID, input.nodeID, childSession.id)

    // 5. Resolve model: node override (only if BOTH id+provider present) > agent
    //    default > parent fallback. A half-specified override (id without provider)
    //    falls through to agent/parent rather than producing an empty providerID.
    //    agent.model is Model.Ref { id, providerID, variant? }
    //    promptOps.prompt expects { modelID, providerID }
    const nodeModel =
      input.node.modelId && input.node.modelProviderId
        ? { modelID: input.node.modelId as never, providerID: input.node.modelProviderId as never }
        : undefined
    const model = nodeModel
      ?? (agent.model ? { modelID: agent.model.modelID, providerID: agent.model.providerID } : undefined)
      ?? { modelID: input.parentModelID as never, providerID: input.parentProviderID as never }

    // 6. Run prompt under concurrency semaphore. Completion is published from
    //    inside the forked fiber: success → NodeCompleted (output = final text
    //    part, same extraction as task.ts:221), failure → NodeFailed.
    //    Level 1 boundary: output is plain text. input_mapping field references
    //    (nodeID.output.field) resolve to undefined until Level 2 structured
    //    output is defined — see eval.ts.
    yield* Effect.forkDetach(
      semaphore.withPermits(1)(
        Effect.gen(function* () {
          const result = yield* input.promptOps.prompt({
            messageID: MessageID.ascending(),
            sessionID: childSession.id,
            model,
            agent: agent.name,
            parts: input.promptParts,
          })
          const output = result.parts.findLast((p) => p.type === "text")?.text ?? ""
          yield* dag.nodeCompleted(input.dagID, input.nodeID, output)
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* dag.nodeFailed(input.dagID, input.nodeID, String(cause), "exec_failed")
            }),
          ),
        ),
      ),
    )

    return { childSessionID: childSession.id as string }
  })
}
