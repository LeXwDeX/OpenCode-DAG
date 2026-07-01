import { Effect, Option, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./goal.txt"
import { Goal } from "../goal/goal"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["status", "complete"]).annotate({
    description: "`status` to query current goal state; `complete` to declare the goal achieved.",
  }),
  reason: Schema.optional(Schema.String).annotate({
    description: "Required when action=complete. One-sentence summary of what was delivered.",
  }),
})

type Metadata = {
  goal?: {
    text: string
    status: "active" | "paused" | "done"
    turnsUsed: number
    maxTurns: number
    subgoals: ReadonlyArray<string>
    pausedReason?: string
  } | null
}

// Goal.Service is resolved lazily (serviceOption) rather than declared as
// a hard dependency of the tool layer. This keeps ToolRegistry's requirement
// set small and lets the tool degrade gracefully if Goal isn't provided by
// the entry point — matching how src/session/prompt.ts and
// src/session/session.ts access Goal.Service.
export const GoalTool = Tool.define<typeof Parameters, Metadata, never>(
  "goal",
  Effect.gen(function* () {
    const goal = Option.getOrUndefined(yield* Effect.serviceOption(Goal.Service))

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          // Goal state belongs to the session itself; it is not an external
          // resource boundary (no filesystem, no network, no cross-session
          // write), so it does not need a permission gate.

          if (!goal) {
            // Goal service not wired into this entry point (some headless
            // / test runtimes omit it). Return a clear message rather than
            // crashing — the tool must never break a session.
            return {
              title: "goal service unavailable",
              output:
                "The autonomous goal service is not available in this runtime. Goal state cannot be queried or modified here.",
              metadata: { goal: null },
            }
          }

          if (params.action === "status") {
            const state = yield* goal.load(ctx.sessionID)
            if (!state) {
              return {
                title: "no goal",
                output: "No autonomous goal is active for this session.",
                metadata: { goal: null },
              }
            }
            const remaining = Math.max(0, Number(state.max_turns) - Number(state.turns_used))
            const subgoals = state.subgoals ?? []
            const line = [
              `Goal: ${state.goal}`,
              `Status: ${state.status}`,
              `Turns: ${state.turns_used}/${state.max_turns} (${remaining} remaining)`,
              subgoals.length > 0 ? `Subgoals (${subgoals.length}):` : "Subgoals: none",
              ...subgoals.map((s, i) => `  ${i + 1}. ${s}`),
              state.status === "paused" && state.paused_reason
                ? `Paused because: ${state.paused_reason}`
                : null,
              state.last_verdict
                ? `Last judge verdict: ${state.last_verdict}${state.last_reason ? ` — ${state.last_reason}` : ""}`
                : null,
            ]
              .filter(Boolean)
              .join("\n")
            return {
              title: `goal ${state.status} (${state.turns_used}/${state.max_turns})`,
              output: line,
              metadata: {
                goal: {
                  text: state.goal,
                  status: state.status as "active" | "paused" | "done",
                  turnsUsed: Number(state.turns_used),
                  maxTurns: Number(state.max_turns),
                  subgoals,
                  pausedReason: state.paused_reason,
                },
              },
            }
          }

          // action === "complete"
          if (!params.reason || params.reason.trim().length === 0) {
            throw new Tool.InvalidArgumentsError({
              tool: "goal",
              detail: "`reason` is required when action is `complete`. Describe in one sentence what was delivered.",
            })
          }
          const state = yield* goal.load(ctx.sessionID)
          if (!state || state.status !== "active") {
            return {
              title: "no active goal",
              output: "Cannot complete goal: no active goal for this session. The loop may have already finished, been paused, or been cleared.",
              metadata: { goal: null },
            }
          }
          // markDone performs: clearFiber → saveState(turns_used+1) →
          // deleteAndPublishDone (publish goal.updated(done) → deleteState →
          // publish goal.cleared). It returns the post-increment snapshot,
          // so use its return value (NOT the pre-call `state` above) for
          // the completion message — otherwise the "N turns" count shown
          // to the user would be 1 less than what was persisted.
          const finalState = yield* goal.markDone(ctx.sessionID, params.reason.trim())

          const displayState = finalState ?? state
          const completionMsg = `✓ 目标已达成（${displayState.turns_used}/${displayState.max_turns} 轮）：${displayState.goal}\nReason: ${params.reason.trim()}`
          return {
            title: `goal completed (${displayState.turns_used}/${displayState.max_turns})`,
            output: completionMsg,
            metadata: {
              goal: {
                text: displayState.goal,
                status: "done" as const,
                turnsUsed: Number(displayState.turns_used),
                maxTurns: Number(displayState.max_turns),
                subgoals: displayState.subgoals ?? [],
              },
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
