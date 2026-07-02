/**
 * DAG node spawn — reuses the `task` tool's spawn path.
 *
 * A ready node spawns a real child Session through the same contract as task.ts:
 * Agent.Service.get → Session.Service.create(parentID) → deriveSubagentSessionPermission → promptOps.prompt.
 *
 * Key differences from the old dag-iron-laws spawnReadyNode:
 * - NO `node_complete` instruction (D3): completion is inferred from child session lifecycle
 * - Self-held Effect.Semaphore for max_concurrency (D9/2.12): SessionRunCoordinator has no global ceiling
 * - Three-layer model resolution: node.model > agent.model > parent session model
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
 * The caller (scheduling.ts) subscribes to the child session's lifecycle events
 * to infer completion (D3) — this function returns after publishing NodeStarted
 * and does NOT wait for the prompt to finish.
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

    // 6. Run prompt under concurrency semaphore — NO node_complete instruction.
    //    Fork-detached: scheduling.ts infers completion from child session lifecycle.
    yield* Effect.forkDetach(
      semaphore.withPermits(1)(
        input.promptOps
          .prompt({
            messageID: MessageID.ascending(),
            sessionID: childSession.id,
            model,
            agent: agent.name,
            parts: input.promptParts,
          })
          .pipe(
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
