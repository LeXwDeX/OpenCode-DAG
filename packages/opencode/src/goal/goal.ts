export * as Goal from "./goal"

import { Effect, Layer, Context, Schema, Fiber } from "effect"
import { Bus } from "@/bus"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"
import { GoalState } from "./state"
import { GoalStateTable } from "./goal.sql"
import { GoalEvent } from "./events"
import { GoalPrompts } from "./prompts"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"

const db = <T>(fn: (d: Parameters<typeof Database.use>[0] extends (trx: infer D) => any ? D : never) => T) =>
  Effect.sync(() => Database.use(fn))

function loadState(sessionID: SessionID) {
  const row = Database.use((d) =>
    d.select().from(GoalStateTable).where(eq(GoalStateTable.session_id, sessionID)).get(),
  )
  if (!row) return undefined
  return Schema.decodeUnknownSync(GoalState.Info)(JSON.parse(row.payload))
}

function saveState(sessionID: SessionID, state: GoalState.Info) {
  const payload = JSON.stringify(Schema.encodeSync(GoalState.Info)(state))
  Database.use((d) =>
    d
      .insert(GoalStateTable)
      .values({
        session_id: sessionID,
        payload,
        updated_at: Date.now(),
      })
      .onConflictDoUpdate({
        target: GoalStateTable.session_id,
        set: { payload, updated_at: Date.now() },
      })
      .run(),
  )
}

function deleteState(sessionID: SessionID) {
  Database.use((d) => d.delete(GoalStateTable).where(eq(GoalStateTable.session_id, sessionID)).run())
}

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
    const bus = yield* Bus.Service
    const sessionStatus = yield* SessionStatus.Service

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

    const load = Effect.fn("Goal.load")(function* (sessionID: SessionID) {
      return loadState(sessionID)
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
      saveState(sessionID, state)
      yield* bus.publish(GoalEvent.Event.Set, {
        sessionID,
        goal,
        maxTurns: state.max_turns,
      })
      return state
    })

    const pause = Effect.fn("Goal.pause")(function* (sessionID: SessionID, reason: string) {
      const state = loadState(sessionID)
      if (!state || state.status !== "active") return undefined
      const updated = new GoalState.Info({
        ...state,
        status: "paused",
        paused_reason: reason,
        last_turn_at: Date.now(),
      })
      saveState(sessionID, updated)
      yield* clearFiber(sessionID)
      yield* bus.publish(GoalEvent.Event.Paused, { sessionID, reason })
      return updated
    })

    const resume = Effect.fn("Goal.resume")(function* (sessionID: SessionID) {
      const state = loadState(sessionID)
      if (!state || state.status !== "paused") return undefined
      const updated = new GoalState.Info({
        ...state,
        status: "active",
        turns_used: 0 as any,
        consecutive_parse_failures: 0 as any,
        paused_reason: undefined,
        last_turn_at: Date.now(),
      })
      saveState(sessionID, updated)
      yield* bus.publish(GoalEvent.Event.Updated, {
        sessionID,
        goal: updated.goal,
        status: updated.status,
        turnsUsed: updated.turns_used,
        maxTurns: updated.max_turns,
      })
      return updated
    })

    const clear = Effect.fn("Goal.clear")(function* (sessionID: SessionID) {
      deleteState(sessionID)
      yield* clearFiber(sessionID)
      yield* bus.publish(GoalEvent.Event.Cleared, { sessionID })
    })

    const markDone = Effect.fn("Goal.markDone")(function* (sessionID: SessionID, reason: string) {
      const state = loadState(sessionID)
      if (!state) return undefined
      const updated = new GoalState.Info({
        ...state,
        status: "done",
        last_verdict: "done",
        last_reason: reason,
        last_turn_at: Date.now(),
      })
      saveState(sessionID, updated)
      yield* clearFiber(sessionID)
      yield* bus.publish(GoalEvent.Event.Achieved, { sessionID, reason })
      return updated
    })

    const addSubgoal = Effect.fn("Goal.addSubgoal")(function* (sessionID: SessionID, subgoal: string) {
      const state = loadState(sessionID)
      if (!state) return undefined
      const updated = new GoalState.Info({
        ...state,
        subgoals: [...(state.subgoals ?? []), subgoal],
        last_turn_at: Date.now(),
      })
      saveState(sessionID, updated)
      yield* bus.publish(GoalEvent.Event.Updated, {
        sessionID,
        goal: updated.goal,
        status: updated.status,
        turnsUsed: updated.turns_used,
        maxTurns: updated.max_turns,
      })
      return updated
    })

    const removeSubgoal = Effect.fn("Goal.removeSubgoal")(function* (sessionID: SessionID, index: number) {
      const state = loadState(sessionID)
      if (!state) return undefined
      const subgoals = state.subgoals ?? []
      const idx = index - 1
      if (idx < 0 || idx >= subgoals.length) return state
      const updated = new GoalState.Info({
        ...state,
        subgoals: subgoals.filter((_, i) => i !== idx),
        last_turn_at: Date.now(),
      })
      saveState(sessionID, updated)
      yield* bus.publish(GoalEvent.Event.Updated, {
        sessionID,
        goal: updated.goal,
        status: updated.status,
        turnsUsed: updated.turns_used,
        maxTurns: updated.max_turns,
      })
      return updated
    })

    const clearSubgoals = Effect.fn("Goal.clearSubgoals")(function* (sessionID: SessionID) {
      const state = loadState(sessionID)
      if (!state) return undefined
      const updated = new GoalState.Info({
        ...state,
        subgoals: [],
        last_turn_at: Date.now(),
      })
      saveState(sessionID, updated)
      yield* bus.publish(GoalEvent.Event.Updated, {
        sessionID,
        goal: updated.goal,
        status: updated.status,
        turnsUsed: updated.turns_used,
        maxTurns: updated.max_turns,
      })
      return updated
    })

    const statusLine = Effect.fn("Goal.statusLine")(function* (sessionID: SessionID) {
      const state = loadState(sessionID)
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
      const state = loadState(sessionID)
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
        saveState(sessionID, updated)
        yield* bus.publish(GoalEvent.Event.Achieved, { sessionID, reason })
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
        saveState(sessionID, updated)
        yield* clearFiber(sessionID)
        yield* bus.publish(GoalEvent.Event.Paused, { sessionID, reason: pauseReason })
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
        saveState(sessionID, updated)
        yield* clearFiber(sessionID)
        yield* bus.publish(GoalEvent.Event.Paused, { sessionID, reason: "轮次预算耗尽" })
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
      saveState(sessionID, updated)
      yield* bus.publish(GoalEvent.Event.Continued, {
        sessionID,
        turnsUsed: updated.turns_used,
        maxTurns: updated.max_turns,
        reason,
      })
      return {
        state: updated,
        shouldContinue: true,
        message: `↻ 继续推进目标（${updated.turns_used}/${updated.max_turns}）：${reason}`,
      }
    })

    const dispatch = Effect.fn("Goal.dispatch")(function* (sessionID: SessionID, args: string) {
      const trimmed = args.trim()
      const lower = trimmed.toLowerCase()

      // I5: a busy session must not accept a new goal text. Control sub-commands
      // (status / pause / resume / clear / stop / done and the empty status query)
      // remain allowed so users can introspect or stop a running turn.
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

      // New goal text — set it and kick start
      const existing = loadState(sessionID)
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
        const state = loadState(sessionID)
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

      // Default: treat as add
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
  Layer.provide(Bus.layer),
)
