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
        // Inject visible completion message when goal is achieved, then
        // auto-clear the goal state. `updateAfterJudge` already persisted
        // a done snapshot and published goal.updated — that snapshot is
        // only kept long enough to emit the completion message, then the
        // row is removed so done is a transient visual-only state (mirrors
        // how /goal clear behaves). This is what makes goal completion
        // not require a manual /goal clear afterwards.
        if (verdict.verdict === "done") {
          yield* promptSvc.prompt({
            sessionID,
            noReply: true,
            parts: [{ type: "text", text: updateResult.message }],
          }).pipe(Effect.ignore)
          // Use deleteAndPublishDone (NOT goal.clear) because we ARE the
          // loop fiber: goal.clear() internally calls clearFiber which
          // would interrupt ourselves before events.publish(GoalEvent.Cleared)
          // runs — the .pipe(Effect.ignore) would silently swallow the
          // self-interrupt and goal.cleared would never reach SSE/TUI.
          // deleteAndPublishDone only touches DB + event bus, never the
          // fiber map, so it is safe to call from inside the loop fiber.
          yield* goal.deleteAndPublishDone(sessionID, verdict.reason).pipe(Effect.ignore)
        } else {
          // Auto-pause branch: updateAfterJudge paused the goal due to
          // judge-parse-failure or budget exhaustion (verdict.verdict is
          // still "continue"). Without surfacing the message here, these
          // automatic pauses would be invisible to the user — updateAfterJudge
          // already saved the paused state and published goal.updated, but
          // nothing rendered the "⏸ 目标已暂停 — …" line into the transcript.
          // Emit it as a noReply part so it shows up without spawning a new
          // agent turn; the fiber then naturally terminates (no clearFiber
          // needed, see updateAfterJudge).
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

      // Reload messages after judge LLM call — the snapshot from before judge
      // may be stale if user sent messages during the 5-30s judge latency
      const freshMsgs = yield* sessions.messages({ sessionID, limit: 20 })

      if (shouldPreempt(freshMsgs)) {
        // Same self-interrupt hazard as the done branch above: we ARE the
        // fiber tracked in the fibers map, so goal.pause() (which internally
        // calls clearFiber) would interrupt ourselves before
        // publishGoal(paused) reaches the event bus. Use pauseAndPublish
        // which skips fiber management — the fiber naturally terminates
        // when this function returns.
        yield* goal.pauseAndPublish(sessionID, "当前轮被中断").pipe(Effect.ignore) // user preempted
        return
      }

      const reloadedState = yield* goal.load(sessionID)
      if (!reloadedState || reloadedState.status !== "active") return
      const continuationText = GoalPrompts.renderContinuation(reloadedState.goal, reloadedState.subgoals ?? [])

      // Surface the per-turn progress indicator visibly (e.g.
      // "↻ 继续推进目标（2/10）：…"). updateAfterJudge computed this message;
      // emit it as a noReply non-synthetic part so it renders in the transcript
      // without spawning another agent turn. The continuation prompt below
      // (ignored) is what actually drives the next loop iteration.
      yield* promptSvc.prompt({
        sessionID,
        noReply: true,
        parts: [{ type: "text", text: updateResult.message }],
      }).pipe(Effect.ignore)

      yield* promptSvc.prompt({
        sessionID,
        parts: [{ type: "text", text: continuationText, ignored: true }],
      })

      // NOTE: We deliberately DO NOT call goal.clearLoopFiber here. The
      // promptSvc.prompt above triggers a fresh agent loop, which when it
      // goes idle will cause the SessionStatus idle subscription to fork
      // a NEW afterIdle fiber and registerLoopFiber will auto-override the
      // (naturally completed) current fiber in the map. An explicit
      // clearLoopFiber from within ourselves would race with that override
      // and could interrupt the newly registered fiber C, silently
      // stalling the goal loop.
    })

    const init = Effect.fn("GoalLoop.init")(function* () {
      yield* InstanceState.get(state)
    })

    return Service.of({ init })
  }),
)

// GoalLoop.defaultLayer self-provides its construction deps. Because
// Layer.provideMerge(self, layer) requires `layer` (GoalLoop) to be
// self-contained — self's context is NOT fed into layer — every dep in the
// chain must be provided here, transitively. memoMap dedups these with the
// AppLayer's own instances so no duplicate services are created.
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
