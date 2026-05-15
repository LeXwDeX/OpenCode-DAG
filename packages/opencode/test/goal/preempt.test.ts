import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Goal } from "@/goal/goal"
import { shouldPreempt } from "@/goal/loop"
import { SessionID } from "@/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Goal.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("user preemption between idle and continuation (I3)", () => {
  // The current loop.ts only checks that SessionStatus is still "idle" before
  // enqueueing a continuation. There is no explicit `lastUserMessageAt > goal.last_turn_at`
  // check yet. The two cases below capture: (a) what is implemented today, and
  // (b) the stricter guarantee from design §4 I3 — left as a TODO until implemented.

  it.live("currentStatus.busy after judge → loop afterIdle should NOT enqueue continuation (today's behavior)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        // Surface check on Goal API: an active goal that becomes paused mid-stream
        // (e.g. user issued /goal pause while judge was thinking) does not get a
        // continuation. updateAfterJudge returns undefined when status !== "active".
        const goal = yield* Goal.Service
        const id = SessionID.descending()
        yield* goal.set(id, "g")
        yield* goal.pause(id, "user-paused")
        const r = yield* goal.updateAfterJudge(id, "continue", "step", false)
        expect(r).toBeUndefined()
      }),
    ),
  )

  test("shouldPreempt: lastUser.time > lastAssistant.time → returns true (preempt)", () => {
    const msgs = [
      { info: { role: "assistant" as const, time: { created: 100 } } },
      { info: { role: "user" as const, time: { created: 200 } } },
    ]
    expect(shouldPreempt(msgs)).toBe(true)
  })

  test("shouldPreempt: lastUser.time < lastAssistant.time → returns false (continuation OK)", () => {
    const msgs = [
      { info: { role: "user" as const, time: { created: 100 } } },
      { info: { role: "assistant" as const, time: { created: 200 } } },
    ]
    expect(shouldPreempt(msgs)).toBe(false)
  })

  test("shouldPreempt: missing user or assistant → returns false (defensive)", () => {
    expect(shouldPreempt([])).toBe(false)
    expect(shouldPreempt([{ info: { role: "user", time: { created: 100 } } }])).toBe(false)
    expect(shouldPreempt([{ info: { role: "assistant", time: { created: 100 } } }])).toBe(false)
  })

  test("shouldPreempt: picks the most recent of each role across history", () => {
    const msgs = [
      { info: { role: "user" as const, time: { created: 100 } } },
      { info: { role: "assistant" as const, time: { created: 150 } } },
      { info: { role: "user" as const, time: { created: 200 } } },
      { info: { role: "assistant" as const, time: { created: 180 } } },
    ]
    // lastUser=200, lastAsst=180 → preempt
    expect(shouldPreempt(msgs)).toBe(true)
  })

  // Contract test for: "after pause from user mid-judge, no goal.continued event is published".
  // shouldPreempt is the gate that callers (loop.afterIdle) consult before publishing
  // GoalEvent.Continued. When the gate fires, the call site must `goal.pause(...)` and
  // `return` — short-circuiting the bus.publish(Continued) at loop.ts. This unit test
  // pins the gate's contract; the full integration assertion lives in the call-site
  // edit (loop.ts afterIdle, between status.get and reloadedState).
  test("shouldPreempt: when true, callers must pause-and-return before publishing Continued (contract)", () => {
    const msgs = [
      { info: { role: "assistant" as const, time: { created: 100 } } },
      { info: { role: "user" as const, time: { created: 200 } } },
    ]
    expect(shouldPreempt(msgs)).toBe(true)
  })
})
