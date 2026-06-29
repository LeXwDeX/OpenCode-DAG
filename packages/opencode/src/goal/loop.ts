export * as GoalLoop from "./loop"

import { Effect, Layer, Context, Stream, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatus } from "@/session/status"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Provider } from "@/provider/provider"
import { Goal } from "./goal"
import { GoalJudge } from "./judge"
import { GoalPrompts } from "./prompts"
import { GoalEvent } from "./events"
import { generateText } from "ai"
import { SessionID } from "@/session/schema"

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/GoalLoop") {}

/**
 * Pure predicate: returns true when the most recent user message in `msgs`
 * is newer than the most recent assistant message.
 *
 * Used by GoalLoop.afterIdle as a strict-preempt guard: if the user has
 * inserted a new turn after the last assistant response, we must abandon
 * the pending continuation and pause the goal instead of re-prompting.
 *
 * Defensive fallback: if either side is missing, returns false (no preempt).
 *
 * Operates on MessageV2 shape (`info.time.created`).
 */
export function shouldPreempt(
  msgs: ReadonlyArray<{ info: { role: "user" | "assistant"; time: { created: number } } }>,
): boolean {
  let lastUserAt = -1
  let lastAsstAt = -1
  for (const m of msgs) {
    const t = m.info.time?.created
    if (typeof t !== "number") continue
    if (m.info.role === "user" && t > lastUserAt) lastUserAt = t
    else if (m.info.role === "assistant" && t > lastAsstAt) lastAsstAt = t
  }
  if (lastUserAt < 0 || lastAsstAt < 0) return false
  return lastUserAt > lastAsstAt
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const sessions = yield* Session.Service
    const promptSvc = yield* SessionPrompt.Service
    const provider = yield* Provider.Service
    const goal = yield* Goal.Service
    const status = yield* SessionStatus.Service

    const state = yield* InstanceState.make(
      Effect.fn("GoalLoop.state")(function* (_ctx) {
        const scope = yield* Scope.Scope
        yield* events.subscribe(SessionStatus.Event.Status).pipe(
          Stream.filter((evt) => evt.data.status.type === "idle"),
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const sid = evt.data.sessionID
              // v1.17.11: idle has no cause field; afterIdle handles
              // abort detection via shouldPreempt (user message after cancel)
              const fiber = yield* afterIdle(sid).pipe(Effect.ignore, Effect.forkIn(scope))
              yield* goal.registerLoopFiber(sid, fiber)
            }).pipe(Effect.ignore),
          ),
          Effect.forkScoped,
        )
        return {}
      }),
    )

    const afterIdle = Effect.fn("GoalLoop.afterIdle")(function* (sessionID: SessionID) {
      const goalState = yield* goal.load(sessionID)
      if (!goalState || goalState.status !== "active") return

      const msgs = yield* sessions.messages({ sessionID, limit: 20 })
      const lastAssistant = [...msgs].reverse().find((m) => m.info.role === "assistant")
      if (!lastAssistant) return
      const responseText = lastAssistant.parts
        .filter((p): p is Extract<(typeof lastAssistant.parts)[number], { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("\n")
        .slice(-4000)
      if (!responseText) return

      const callLLM = (opts: { system: string; user: string; temperature: number; maxTokens: number; timeout: number }) =>
        Effect.gen(function* () {
          const defaultM = yield* provider.defaultModel()
          const model = yield* provider.getModel(defaultM.providerID, defaultM.modelID)
          const language = yield* provider.getLanguage(model)
          const result = yield* Effect.tryPromise({
            try: (signal) =>
              generateText({
                model: language,
                system: opts.system,
                prompt: opts.user,
                temperature: opts.temperature,
                maxOutputTokens: opts.maxTokens,
                abortSignal: signal,
              }),
            catch: (e) => new Error(`judge LLM call failed: ${e}`),
          }).pipe(Effect.timeout(`${opts.timeout} seconds`))
          if (!result) return ""
          return result.text
        })

      const verdict = yield* GoalJudge.run(
        goalState.goal,
        responseText,
        goalState.subgoals ?? [],
        callLLM,
      )

      const updateResult = yield* goal.updateAfterJudge(sessionID, verdict.verdict, verdict.reason, verdict.parseFailed)
      if (!updateResult) return

      if (!updateResult.shouldContinue) {
        // Inject visible completion message when goal is achieved
        if (verdict.verdict === "done") {
          yield* promptSvc.prompt({
            sessionID,
            noReply: true,
            parts: [{ type: "text", text: updateResult.message }],
          }).pipe(Effect.ignore)
        }
        return
      }

      const currentStatus = yield* status.get(sessionID)
      if (currentStatus.type !== "idle") {
        return // session no longer idle, skip continuation
      }

      if (shouldPreempt(msgs)) {
        yield* goal.pause(sessionID, "当前轮被中断").pipe(Effect.ignore) // user preempted
        return
      }

      const reloadedState = yield* goal.load(sessionID)
      if (!reloadedState || reloadedState.status !== "active") return
      const continuationText = GoalPrompts.renderContinuation(reloadedState.goal, reloadedState.subgoals ?? [])

      yield* promptSvc.prompt({
        sessionID,
        parts: [{ type: "text", text: continuationText, ignored: true }],
      })

      yield* events.publish(GoalEvent.Continued, {
        sessionID,
        turnsUsed: reloadedState.turns_used,
        maxTurns: reloadedState.max_turns,
        reason: verdict.reason,
      })

      yield* goal.clearLoopFiber(sessionID)
    })

    const init = Effect.fn("GoalLoop.init")(function* () {
      yield* InstanceState.get(state)
    })

    return Service.of({ init })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(SessionPrompt.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Goal.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
)

export const node = LayerNode.make(layer, [
  EventV2Bridge.node,
  Session.node,
  SessionPrompt.node,
  Provider.node,
  Goal.node,
  SessionStatus.node,
])
