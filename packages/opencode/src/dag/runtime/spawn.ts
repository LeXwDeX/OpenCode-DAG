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

import { Effect, Semaphore, Scope, Fiber, Schema, Option, Clock, Cause } from "effect"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "@/session/schema"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { SessionPrompt } from "@/session/prompt"
import { Dag } from "../dag"
import { InvalidTransitionError } from "@opencode-ai/core/dag/core/types"
import type { DagStore } from "@opencode-ai/core/dag/store"

type PromptParts = SessionPrompt.PromptInput["parts"]

/** System-wide default node timeout (10 minutes) when worker_config.timeout_ms is omitted. */
const DEFAULT_NODE_TIMEOUT_MS = 10 * 60 * 1000

/** Grace period for confirming an abandoned session stopped after restart-induced abort. */
const ABANDONED_SESSION_GRACE_MS = 30 * 1000

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
  timeoutMs?: number
  reportToParent?: boolean
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

    // Resolve timeout and compute absolute deadline (D0 path 1).
    // The deadline is computed at spawn time and persisted so crash-recovery
    // can inherit it. The actual timeout race uses the REMAINING time from
    // when the semaphore permit is acquired — queue wait counts toward the
    // deadline, preventing a node that queued past its deadline from running.
    const timeoutMs = input.timeoutMs ?? DEFAULT_NODE_TIMEOUT_MS
    const spawnTime = yield* Clock.currentTimeMillis
    const deadlineMs = spawnTime + timeoutMs

    yield* dag.nodeStarted(input.dagID, input.nodeID, childSession.id, deadlineMs, input.reportToParent)

    const fiber = yield* Effect.forkIn(scope)(
      Effect.gen(function* () {
        // P1(#1): Acquire permit with a deadline-bounded timeout so the node
        // doesn't wait unbounded in the semaphore queue. If the deadline
        // elapses while waiting, fail immediately.
        const queueTime = yield* Clock.currentTimeMillis
        const queueRemaining = deadlineMs - queueTime
        if (queueRemaining <= 0) {
          yield* dag.nodeFailed(input.dagID, input.nodeID, `node exceeded timeout before acquiring execution permit`, "timeout").pipe(
            Effect.catchIf(
              (err): err is InvalidTransitionError => err instanceof InvalidTransitionError,
              () => Effect.logWarning("nodeFailed (pre-permit timeout) guard rejected — node already terminal"),
            ),
          )
          return
        }
        // Race permit acquisition against the remaining queue budget
        const permitAcquired = yield* Effect.gen(function* () { yield* semaphore.take(1) }).pipe(
          Effect.timeoutOption(queueRemaining),
        )
        if (Option.isNone(permitAcquired)) {
          yield* dag.nodeFailed(input.dagID, input.nodeID, `node exceeded timeout while waiting for execution permit`, "timeout").pipe(
            Effect.catchIf(
              (err): err is InvalidTransitionError => err instanceof InvalidTransitionError,
              () => Effect.logWarning("nodeFailed (permit-wait timeout) guard rejected — node already terminal"),
            ),
          )
          return
        }
        // Permit acquired — run the actual prompt with remaining time budget
        const permitTime = yield* Clock.currentTimeMillis
        const remainingMs = Math.max(0, deadlineMs - permitTime)
        try {
          const resultOpt = yield* promptSvc.prompt({
            messageID: MessageID.ascending(),
            sessionID: childSession.id,
            model,
            agent: agent.name,
            parts: input.promptParts,
          }).pipe(Effect.timeoutOption(remainingMs))
          if (Option.isNone(resultOpt)) {
            yield* promptSvc.cancel(childSession.id).pipe(Effect.ignore)
            yield* dag.nodeFailed(input.dagID, input.nodeID, `node exceeded timeout of ${timeoutMs}ms`, "timeout").pipe(
              Effect.catchIf(
                (err): err is InvalidTransitionError => err instanceof InvalidTransitionError,
                () => Effect.logWarning("nodeFailed (timeout) guard rejected — node already terminal"),
              ),
            )
            return
          }
          const rawText = resultOpt.value.parts.findLast((p) => p.type === "text")?.text ?? ""
          const output = input.outputSchema
            ? yield* extractStructuredOutput(rawText, input.outputSchema)
            : rawText
          yield* dag.nodeCompleted(input.dagID, input.nodeID, output).pipe(
            Effect.catchIf(
              (err): err is InvalidTransitionError => err instanceof InvalidTransitionError,
              () => Effect.logWarning("nodeCompleted guard rejected — node already terminal"),
            ),
          )
        } finally {
          yield* semaphore.release(1)
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (Cause.interruptors(cause).size > 0) return
            yield* dag.nodeFailed(input.dagID, input.nodeID, String(cause), "exec_failed").pipe(
              Effect.catchIf(
                (err): err is InvalidTransitionError => err instanceof InvalidTransitionError,
                () => Effect.logWarning("nodeFailed guard rejected — node already terminal"),
              ),
            )
          }),
        ),
      ),
    )

    return { childSessionID: childSession.id as string, fiber }
  })
}

/**
 * Re-attachment watcher for crash recovery.
 *
 * After a restart, a node left in `running` whose child session is still
 * active has no fiber to observe the session's terminal event. This watcher
 * periodically checks the child session's status and publishes the terminal
 * DAG event when the session completes or fails.
 *
 * Polling uses exponential backoff: 1s initial, doubling up to 10s cap.
 * The watcher holds a semaphore permit for its lifetime so recovered nodes
 * count against the workflow's concurrency limit.
 *
 * It does NOT falsely fail a still-active session — if the session stays
 * active or returns 'unknown' (0 messages), the watcher keeps checking
 * until the workflow terminates and cleans up the fiber.
 */
export function attachNodeCompletionWatcher(
  dagID: string,
  nodeID: string,
  childSessionID: string,
  checkStatus: (childSessionID: string) => Effect.Effect<"active" | "completed" | "failed" | "unknown", Error>,
  semaphore: Semaphore.Semaphore,
  deadlineMs?: number | null,
  startedAt?: number | null,
): Effect.Effect<Fiber.Fiber<void, unknown>, Error, Dag.Service | Scope.Scope> {
  return Effect.gen(function* () {
    const dag = yield* Dag.Service
    const scope = yield* Scope.Scope

    // P1-7: fallback for pre-existing nodes that have deadline_ms = null
    const effectiveDeadline = deadlineMs ?? (startedAt ? startedAt + DEFAULT_NODE_TIMEOUT_MS : null)

    return yield* Effect.forkIn(scope)(
      Effect.gen(function* () {
        if (effectiveDeadline) {
          const now = yield* Clock.currentTimeMillis
          if (now >= effectiveDeadline) {
            const status = yield* checkStatus(childSessionID).pipe(Effect.catch(() => Effect.succeed("unknown" as const)))
            if (status === "completed") {
              yield* dag.nodeCompleted(dagID, nodeID, undefined).pipe(Effect.ignore)
              return
            }
            if (status === "failed") {
              yield* dag.nodeFailed(dagID, nodeID, "child session failed (recovered)", "exec_failed").pipe(Effect.ignore)
              return
            }
            yield* dag.nodeFailed(dagID, nodeID, `node exceeded timeout (deadline passed during recovery)`, "timeout").pipe(Effect.ignore)
            return
          }
          // P1(#1): race permit acquisition against deadline
          const waitRemaining = effectiveDeadline - now
          const permitAcquired = yield* Effect.gen(function* () { yield* semaphore.take(1) }).pipe(
            Effect.timeoutOption(waitRemaining),
          )
          if (Option.isNone(permitAcquired)) {
            yield* dag.nodeFailed(dagID, nodeID, `node exceeded timeout while waiting for permit during recovery`, "timeout").pipe(
              Effect.catchIf(
                (err): err is InvalidTransitionError => err instanceof InvalidTransitionError,
                () => Effect.logWarning("Recovery watcher: permit-wait timeout guard rejected — node already terminal"),
              ),
            )
            return
          }
          try {
            yield* runPollLoop(dag, dagID, nodeID, childSessionID, checkStatus, effectiveDeadline)
          } finally {
            yield* semaphore.release(1)
          }
        } else {
          yield* semaphore.withPermits(1)(
            runPollLoop(dag, dagID, nodeID, childSessionID, checkStatus, null),
          )
        }
      }),
    )
  })
}

function runPollLoop(
  dag: Dag.Interface,
  dagID: string,
  nodeID: string,
  childSessionID: string,
  checkStatus: (childSessionID: string) => Effect.Effect<"active" | "completed" | "failed" | "unknown", Error>,
  effectiveDeadline: number | null,
): Effect.Effect<void, Error, never> {
  return Effect.gen(function* () {
    let status: "active" | "completed" | "failed" | "unknown" = "active"
    let delayMs = 1000
    const maxDelayMs = 10000
    while (status === "active" || status === "unknown") {
      yield* Effect.sleep(`${delayMs} millis`)
      status = yield* checkStatus(childSessionID).pipe(
        Effect.catch(() => Effect.succeed("unknown" as const)),
      )
      if (status !== "active" && status !== "unknown") break
      if (effectiveDeadline) {
        const now = yield* Clock.currentTimeMillis
        if (now >= effectiveDeadline) {
          yield* dag.nodeFailed(dagID, nodeID, `node exceeded timeout (deadline elapsed during recovery polling)`, "timeout").pipe(
            Effect.catchIf(
              (err): err is InvalidTransitionError => err instanceof InvalidTransitionError,
              () => Effect.logWarning("Recovery watcher: nodeFailed (timeout) guard rejected — node already terminal"),
            ),
          )
          return
        }
      }
      delayMs = Math.min(delayMs * 2, maxDelayMs)
    }

    if (status === "completed") {
      yield* dag.nodeCompleted(dagID, nodeID, undefined).pipe(
        Effect.catchIf(
          (err): err is InvalidTransitionError => err instanceof InvalidTransitionError,
          () => Effect.logWarning("Recovery watcher: nodeCompleted guard rejected — node already terminal"),
        ),
      )
      return
    }

    yield* dag.nodeFailed(dagID, nodeID, "child session failed (recovered)", "exec_failed").pipe(
      Effect.catchIf(
        (err): err is InvalidTransitionError => err instanceof InvalidTransitionError,
        () => Effect.logWarning("Recovery watcher: nodeFailed guard rejected — node already terminal"),
      ),
    )
  })
}

/**
 * Bounded grace-period watcher for abandoned child sessions after restart (task 1.9).
 *
 * When a node is restarted via replan, the old child session may continue
 * running due to Effect.uninterruptibleMask. This watcher checks whether the
 * old session settles to stopped within a grace period, and logs a warning
 * if it does not — converting a silent leak into an observed one.
 */
export function attachAbandonedSessionWatcher(
  oldChildSessionID: string,
  nodeID: string,
  checkStatus: (childSessionID: string) => Effect.Effect<"active" | "completed" | "failed" | "unknown", Error>,
  scope: Scope.Scope,
): Effect.Effect<Fiber.Fiber<void, unknown>, Error> {
  return Effect.forkIn(scope)(
    Effect.gen(function* () {
      const graceDeadline = ABANDONED_SESSION_GRACE_MS
      let elapsed = 0
      let delayMs = 1000
      const maxDelayMs = 5000
      while (elapsed < graceDeadline) {
        yield* Effect.sleep(`${delayMs} millis`)
        elapsed += delayMs
        delayMs = Math.min(delayMs * 2, maxDelayMs)
        const status = yield* checkStatus(oldChildSessionID).pipe(
          Effect.catch(() => Effect.succeed("unknown" as const)),
        )
        if (status === "completed" || status === "failed") return
      }
      yield* Effect.logWarning("DAG: abandoned child session not confirmed stopped within grace period", {
        nodeID,
        childSessionID: oldChildSessionID,
      })
    }),
  )
}
