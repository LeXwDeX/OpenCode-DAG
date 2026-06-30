export * as Goal from "./goal"

import { Effect, Layer, Context, Schema, Fiber } from "effect"
import { eq } from "drizzle-orm"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GoalState } from "./state"
import { GoalStateTable } from "./goal.sql"
import { GoalEvent } from "./events"
import { GoalPrompts } from "./prompts"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"

export interface Interface {
  readonly load: (sessionID: SessionID) => Effect.Effect<GoalState.Info | undefined>
  readonly set: (sessionID: SessionID, goal: string, maxTurns?: number) => Effect.Effect<GoalState.Info>
  readonly pause: (sessionID: SessionID, reason: string) => Effect.Effect<GoalState.Info | undefined>
  readonly resume: (sessionID: SessionID) => Effect.Effect<GoalState.Info | undefined>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
  readonly markDone: (sessionID: SessionID, reason: string) => Effect.Effect<GoalState.Info | undefined>
  readonly addSubgoal: (sessionID: SessionID, subgoal: string) => Effect.Effect<GoalState.Info | undefined>
  readonly removeSubgoal: (sessionID: SessionID, index: number) => Effect.Effect<GoalState.Info | undefined>
  readonly clearSubgoals: (sessionID: SessionID) => Effect.Effect<GoalState.Info | undefined>
  readonly statusLine: (sessionID: SessionID) => Effect.Effect<string | undefined>
  readonly dispatch: (sessionID: SessionID, args: string) => Effect.Effect<{
    type: "message" | "kick"
    text: string
    announce?: string
  }>
  readonly dispatchSubgoal: (sessionID: SessionID, args: string) => Effect.Effect<{
    type: "message"
    text: string
  }>
  readonly updateAfterJudge: (
    sessionID: SessionID,
    verdict: "done" | "continue",
    reason: string,
    parseFailed: boolean,
  ) => Effect.Effect<
    | {
        state: GoalState.Info
        shouldContinue: boolean
        message: string
      }
    | undefined
  >
  readonly registerLoopFiber: (sessionID: SessionID, fiber: Fiber.Fiber<unknown, unknown>) => Effect.Effect<void>
  readonly clearLoopFiber: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Goal") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service
    const sessionStatus = yield* SessionStatus.Service

    // Unified event publisher — every state change publishes goal.updated
    // with the full snapshot, identical to Todo's todo.updated pattern.
    const publishGoal = (sessionID: SessionID, state: GoalState.Info) =>
      events.publish(GoalEvent.Updated, {
        sessionID,
        goal: {
          goal: state.goal,
          status: state.status as "active" | "paused" | "done",
          turnsUsed: Number(state.turns_used),
          maxTurns: Number(state.max_turns),
        },
      })

    const fibers = new Map<SessionID, Fiber.Fiber<unknown, unknown>>()

    const registerFiber = Effect.fnUntraced(function* (
      sessionID: SessionID,
      fiber: Fiber.Fiber<unknown, unknown>,
    ) {
      const existing = fibers.get(sessionID)
      if (existing) yield* Fiber.interrupt(existing)
      fibers.set(sessionID, fiber)
    })

    const clearFiber = Effect.fnUntraced(function* (sessionID: SessionID) {
      const existing = fibers.get(sessionID)
      if (existing) {
        yield* Fiber.interrupt(existing)
        fibers.delete(sessionID)
      }
    })

    function loadState(sessionID: SessionID) {
      return db
        .select()
        .from(GoalStateTable)
        .where(eq(GoalStateTable.session_id, sessionID))
        .get()
        .pipe(
          Effect.orDie,
          Effect.map((row) => {
            if (!row) return undefined
            return Schema.decodeUnknownSync(GoalState.Info)(JSON.parse(row.payload))
          }),
        )
    }

    function saveState(sessionID: SessionID, state: GoalState.Info) {
      const payload = JSON.stringify(Schema.encodeSync(GoalState.Info)(state))
      return db
        .insert(GoalStateTable)
        .values({ session_id: sessionID, payload, updated_at: Date.now() })
        .onConflictDoUpdate({
          target: GoalStateTable.session_id,
          set: { payload, updated_at: Date.now() },
        })
        .run()
        .pipe(Effect.orDie)
    }

    function deleteState(sessionID: SessionID) {
      return db
        .delete(GoalStateTable)
        .where(eq(GoalStateTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
    }

    const load = Effect.fn("Goal.load")(function* (sessionID: SessionID) {
      return yield* loadState(sessionID)
    })

    const set = Effect.fn("Goal.set")(function* (sessionID: SessionID, goal: string, maxTurns?: number) {
      const now = Date.now()
      const state = new GoalState.Info({
        goal,
        status: "active",
        turns_used: 0 as any,
        max_turns: (maxTurns ?? GoalPrompts.DEFAULT_MAX_TURNS) as any,
        created_at: now,
        last_turn_at: now,
        consecutive_parse_failures: 0 as any,
        subgoals: [],
      })
      yield* saveState(sessionID, state)
      yield* publishGoal(sessionID, state)
      return state
    })

    const pause = Effect.fn("Goal.pause")(function* (sessionID: SessionID, reason: string) {
      const state = yield* loadState(sessionID)
      if (!state || state.status !== "active") return undefined
      const updated = new GoalState.Info({
        ...state,
        status: "paused",
        paused_reason: reason,
        last_turn_at: Date.now(),
      })
      yield* saveState(sessionID, updated)
      yield* clearFiber(sessionID)
      yield* publishGoal(sessionID, updated)
      return updated
    })

    const resume = Effect.fn("Goal.resume")(function* (sessionID: SessionID) {
      const state = yield* loadState(sessionID)
      if (!state || state.status !== "paused") return undefined
      const updated = new GoalState.Info({
        ...state,
        status: "active",
        turns_used: 0 as any,
        consecutive_parse_failures: 0 as any,
        paused_reason: undefined,
        last_turn_at: Date.now(),
      })
      yield* saveState(sessionID, updated)
      yield* publishGoal(sessionID, updated)
      return updated
    })

    const clear = Effect.fn("Goal.clear")(function* (sessionID: SessionID) {
      yield* deleteState(sessionID)
      yield* clearFiber(sessionID)
      yield* events.publish(GoalEvent.Cleared, { sessionID })
    })

    const markDone = Effect.fn("Goal.markDone")(function* (sessionID: SessionID, reason: string) {
      const state = yield* loadState(sessionID)
      if (!state) return undefined
      const updated = new GoalState.Info({
        ...state,
        status: "done",
        last_verdict: "done",
        last_reason: reason,
        last_turn_at: Date.now(),
      })
      yield* saveState(sessionID, updated)
      yield* clearFiber(sessionID)
      yield* publishGoal(sessionID, updated)
      return updated
    })

    const addSubgoal = Effect.fn("Goal.addSubgoal")(function* (sessionID: SessionID, subgoal: string) {
      const state = yield* loadState(sessionID)
      if (!state) return undefined
      const updated = new GoalState.Info({
        ...state,
        subgoals: [...(state.subgoals ?? []), subgoal],
        last_turn_at: Date.now(),
      })
      yield* saveState(sessionID, updated)
      yield* publishGoal(sessionID, updated)
      return updated
    })

    const removeSubgoal = Effect.fn("Goal.removeSubgoal")(function* (sessionID: SessionID, index: number) {
      const state = yield* loadState(sessionID)
      if (!state) return undefined
      const subgoals = state.subgoals ?? []
      const idx = index - 1
      if (idx < 0 || idx >= subgoals.length) return state
      const updated = new GoalState.Info({
        ...state,
        subgoals: subgoals.filter((_, i) => i !== idx),
        last_turn_at: Date.now(),
      })
      yield* saveState(sessionID, updated)
      yield* publishGoal(sessionID, updated)
      return updated
    })

    const clearSubgoals = Effect.fn("Goal.clearSubgoals")(function* (sessionID: SessionID) {
      const state = yield* loadState(sessionID)
      if (!state) return undefined
      const updated = new GoalState.Info({
        ...state,
        subgoals: [],
        last_turn_at: Date.now(),
      })
      yield* saveState(sessionID, updated)
      yield* publishGoal(sessionID, updated)
      return updated
    })

    const statusLine = Effect.fn("Goal.statusLine")(function* (sessionID: SessionID) {
      const state = yield* loadState(sessionID)
      if (!state) return undefined
      const subgoals = state.subgoals ?? []
      const sub = subgoals.length > 0 ? `，${subgoals.length} 个子目标` : ""
      if (state.status === "active")
        return `⊙ 目标（进行中，${state.turns_used}/${state.max_turns} 轮${sub}）：${state.goal}`
      if (state.status === "paused") {
        const reason = state.paused_reason ? ` — ${state.paused_reason}` : ""
        return `⏸ 目标（已暂停，${state.turns_used}/${state.max_turns} 轮${reason}）：${state.goal}`
      }
      if (state.status === "done")
        return `✓ 目标已完成（${state.turns_used}/${state.max_turns} 轮）：${state.goal}`
      return undefined
    })

    const updateAfterJudge = Effect.fn("Goal.updateAfterJudge")(function* (
      sessionID: SessionID,
      verdict: "done" | "continue",
      reason: string,
      parseFailed: boolean,
    ) {
      const state = yield* loadState(sessionID)
      if (!state || state.status !== "active") return undefined

      const now = Date.now()
      const newParseFailures = parseFailed ? state.consecutive_parse_failures + 1 : 0

      if (verdict === "done") {
        const updated = new GoalState.Info({
          ...state,
          status: "done",
          turns_used: (state.turns_used + 1) as any,
          last_turn_at: now,
          last_verdict: "done",
          last_reason: reason,
          consecutive_parse_failures: newParseFailures as any,
        })
        yield* saveState(sessionID, updated)
        yield* publishGoal(sessionID, updated)
        return {
          state: updated,
          shouldContinue: false,
          message: `✓ 目标已达成：${reason}`,
        }
      }

      const turnsUsed = (state.turns_used + 1) as any

      if (newParseFailures >= GoalPrompts.MAX_CONSECUTIVE_PARSE_FAILURES) {
        const pauseReason =
          "judge 模型未返回有效 JSON 判定。请配置 auxiliary.goalJudge 指向更可靠的模型，然后 /goal resume。"
        const updated = new GoalState.Info({
          ...state,
          status: "paused",
          turns_used: turnsUsed,
          last_turn_at: now,
          last_verdict: "continue",
          last_reason: reason,
          paused_reason: pauseReason,
          consecutive_parse_failures: newParseFailures as any,
        })
        yield* saveState(sessionID, updated)
        yield* clearFiber(sessionID)
        yield* publishGoal(sessionID, updated)
        return {
          state: updated,
          shouldContinue: false,
          message: `⏸ 目标已暂停 — ${pauseReason}`,
        }
      }

      if (turnsUsed >= state.max_turns) {
        const pauseReason = `已用 ${turnsUsed}/${state.max_turns} 轮。使用 /goal resume 继续，或 /goal clear 停止。`
        const updated = new GoalState.Info({
          ...state,
          status: "paused",
          turns_used: turnsUsed,
          last_turn_at: now,
          last_verdict: "continue",
          last_reason: reason,
          paused_reason: pauseReason,
          consecutive_parse_failures: newParseFailures as any,
        })
        yield* saveState(sessionID, updated)
        yield* clearFiber(sessionID)
        yield* publishGoal(sessionID, updated)
        return {
          state: updated,
          shouldContinue: false,
          message: `⏸ 目标已暂停 — ${pauseReason}`,
        }
      }

      const updated = new GoalState.Info({
        ...state,
        status: "active",
        turns_used: turnsUsed,
        last_turn_at: now,
        last_verdict: "continue",
        last_reason: reason,
        consecutive_parse_failures: newParseFailures as any,
      })
      yield* saveState(sessionID, updated)
      yield* publishGoal(sessionID, updated)
      return {
        state: updated,
        shouldContinue: true,
        message: `↻ 继续推进目标（${updated.turns_used}/${updated.max_turns}）：${reason}`,
      }
    })

    const dispatch = Effect.fn("Goal.dispatch")(function* (sessionID: SessionID, args: string) {
      const trimmed = args.trim()
      const lower = trimmed.toLowerCase()

      const isControlCommand =
        lower === "" ||
        lower === "status" ||
        lower === "pause" ||
        lower === "resume" ||
        lower === "clear" ||
        lower === "stop" ||
        lower === "done"
      if (!isControlCommand) {
        const status = yield* sessionStatus.get(sessionID)
        if (status.type === "busy") {
          return {
            type: "message" as const,
            text: "Session 正在执行中。请先 /stop 中断后再设定新目标。",
          }
        }
      }

      if (lower === "" || lower === "status") {
        const line = yield* statusLine(sessionID)
        return { type: "message" as const, text: line ?? "没有活跃的目标。使用 /goal <text> 设定一个目标。" }
      }

      if (lower === "pause") {
        const result = yield* pause(sessionID, "user-paused")
        return {
          type: "message" as const,
          text: result
            ? `⏸ 目标已暂停。/goal resume 继续。`
            : "没有活跃的目标可以暂停。",
        }
      }

      if (lower === "resume") {
        const result = yield* resume(sessionID)
        if (!result) return { type: "message" as const, text: "没有已暂停的目标可以恢复。" }
        return {
          type: "kick" as const,
          text: result.goal,
        }
      }

      if (lower === "clear" || lower === "stop" || lower === "done") {
        yield* clear(sessionID)
        return { type: "message" as const, text: "目标已清除。" }
      }

      const existing = yield* loadState(sessionID)
      if (existing && existing.status === "active") {
        return {
          type: "message" as const,
          text: "已有活跃目标。请先 /goal clear 再设定新目标。",
        }
      }
      const maxTurns = GoalPrompts.DEFAULT_MAX_TURNS
      const state = yield* set(sessionID, trimmed, maxTurns)
      return {
        type: "kick" as const,
        text: state.goal,
        announce: `⊙ 目标已设定（${state.max_turns} 轮预算）：${state.goal}`,
      }
    })

    const dispatchSubgoal = Effect.fn("Goal.dispatchSubgoal")(function* (sessionID: SessionID, args: string) {
      const trimmed = args.trim()
      const lower = trimmed.toLowerCase()

      if (lower === "" || lower === "list") {
        const state = yield* loadState(sessionID)
        const subgoals = state?.subgoals ?? []
        if (!state || subgoals.length === 0)
          return { type: "message" as const, text: "没有子目标。使用 /subgoal add <text> 添加。" }
        const lines = subgoals.map((s, i) => `${i + 1}. ${s}`)
        return { type: "message" as const, text: `子目标：\n${lines.join("\n")}` }
      }

      if (lower === "clear") {
        const result = yield* clearSubgoals(sessionID)
        return {
          type: "message" as const,
          text: result ? "子目标已清除。" : "没有活跃的目标。",
        }
      }

      if (lower.startsWith("remove ") || lower.startsWith("rm ")) {
        const indexStr = trimmed.replace(/^(?:remove|rm)\s+/i, "")
        const index = parseInt(indexStr, 10)
        if (isNaN(index) || index < 1) return { type: "message" as const, text: "用法：/subgoal remove <编号>" }
        const result = yield* removeSubgoal(sessionID, index)
        return {
          type: "message" as const,
          text: result ? `子目标 #${index} 已移除。` : "没有活跃的目标。",
        }
      }

      if (lower.startsWith("add ")) {
        const subgoal = trimmed.slice(4).trim()
        if (!subgoal) return { type: "message" as const, text: "用法：/subgoal add <text>" }
        const result = yield* addSubgoal(sessionID, subgoal)
        return {
          type: "message" as const,
          text: result ? `子目标已添加：${subgoal}` : "没有活跃的目标。先使用 /goal <text> 设定一个目标。",
        }
      }

      const result = yield* addSubgoal(sessionID, trimmed)
      return {
        type: "message" as const,
        text: result ? `子目标已添加：${trimmed}` : "没有活跃的目标。先使用 /goal <text> 设定一个目标。",
      }
    })

    return Service.of({
      load,
      set,
      pause,
      resume,
      clear,
      markDone,
      addSubgoal,
      removeSubgoal,
      clearSubgoals,
      statusLine,
      dispatch,
      dispatchSubgoal,
      updateAfterJudge,
      registerLoopFiber: registerFiber,
      clearLoopFiber: clearFiber,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SessionStatus.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
)

export const node = LayerNode.make(layer, [EventV2Bridge.node, Database.node, SessionStatus.node])
