import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer, Stream } from "effect"
import { Bus } from "../../src/bus"
import { Goal } from "@/goal/goal"
import { GoalEvent } from "@/goal/events"
import { GoalPrompts } from "@/goal/prompts"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(Goal.defaultLayer, SessionStatus.defaultLayer, Bus.layer, CrossSpawnSpawner.defaultLayer),
)

const sid = () => SessionID.descending()

describe("Goal afterIdle (logic via updateAfterJudge + pause)", () => {
  it.live("done verdict → publishes goal.achieved + transitions to done", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const goal = yield* Goal.Service
        const bus = yield* Bus.Service
        const id = sid()

        const seen = yield* Deferred.make<{ sessionID: string; reason: string }>()
        yield* Stream.runForEach(bus.subscribe(GoalEvent.Event.Achieved), (evt) =>
          Effect.sync(() => Deferred.doneUnsafe(seen, Effect.succeed(evt.properties as any))),
        ).pipe(Effect.forkScoped)

        yield* goal.set(id, "ship X")
        yield* Effect.sleep("10 millis")
        const r = yield* goal.updateAfterJudge(id, "done", "all green", false)
        expect(r?.shouldContinue).toBe(false)
        expect(r?.state.status).toBe("done")
        const evt = yield* Deferred.await(seen).pipe(Effect.timeout("2 seconds"))
        expect(evt.reason).toBe("all green")
      }),
    ),
  )

  it.live("continue verdict → publishes goal.continued + state stays active", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const goal = yield* Goal.Service
        const bus = yield* Bus.Service
        const id = sid()

        const seen = yield* Deferred.make<{ turnsUsed: number }>()
        yield* Stream.runForEach(bus.subscribe(GoalEvent.Event.Continued), (evt) =>
          Effect.sync(() => Deferred.doneUnsafe(seen, Effect.succeed(evt.properties as any))),
        ).pipe(Effect.forkScoped)

        yield* goal.set(id, "ship X", 5)
        yield* Effect.sleep("10 millis")
        const r = yield* goal.updateAfterJudge(id, "continue", "still going", false)
        expect(r?.shouldContinue).toBe(true)
        expect(r?.state.status).toBe("active")
        expect(r?.state.turns_used).toBe(1)
        const evt = yield* Deferred.await(seen).pipe(Effect.timeout("2 seconds"))
        expect(evt.turnsUsed).toBe(1)
      }),
    ),
  )

  it.live("idle.cause='abort' → goal.pause publishes goal.paused with given reason", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const goal = yield* Goal.Service
        const bus = yield* Bus.Service
        const id = sid()

        const seen = yield* Deferred.make<{ reason: string }>()
        yield* Stream.runForEach(bus.subscribe(GoalEvent.Event.Paused), (evt) =>
          Effect.sync(() => Deferred.doneUnsafe(seen, Effect.succeed(evt.properties as any))),
        ).pipe(Effect.forkScoped)

        yield* goal.set(id, "ship X")
        yield* Effect.sleep("10 millis")
        const r = yield* goal.pause(id, "当前轮被中断")
        expect(r?.status).toBe("paused")
        const evt = yield* Deferred.await(seen).pipe(Effect.timeout("2 seconds"))
        expect(evt.reason).toBe("当前轮被中断")
      }),
    ),
  )

  it.live("turns_used >= max_turns → pause without continuation", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const goal = yield* Goal.Service
        const id = sid()
        yield* goal.set(id, "g", 1) // budget = 1, first updateAfterJudge bumps to 1 → exhausted
        const r = yield* goal.updateAfterJudge(id, "continue", "step 1", false)
        expect(r?.shouldContinue).toBe(false)
        expect(r?.state.status).toBe("paused")
        expect(r?.state.paused_reason ?? "").toContain("/goal resume")
      }),
    ),
  )

  it.live("Nth consecutive parse failure → pause with judge-config reason (I2)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const goal = yield* Goal.Service
        const id = sid()
        yield* goal.set(id, "g", 100)
        for (let i = 1; i < GoalPrompts.MAX_CONSECUTIVE_PARSE_FAILURES; i++) {
          const r = yield* goal.updateAfterJudge(id, "continue", "garbled", true)
          expect(r?.state.status).toBe("active")
        }
        const final = yield* goal.updateAfterJudge(id, "continue", "garbled", true)
        expect(final?.shouldContinue).toBe(false)
        expect(final?.state.status).toBe("paused")
        expect(final?.state.paused_reason ?? "").toContain("auxiliary.goalJudge")
      }),
    ),
  )
})
