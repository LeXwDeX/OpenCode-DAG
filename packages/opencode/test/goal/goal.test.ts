import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { Goal } from "@/goal/goal"
import { GoalEvent } from "@/goal/events"
import { GoalPrompts } from "@/goal/prompts"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatus } from "@/session/status"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

// Build the layer so EventV2Bridge.Service is SHARED between Goal's internals
// (which publish via it) and this test (which subscribes via it).
// `Layer.provideMerge` exposes the built EventV2Bridge in the output context
// AND feeds the same instance into Goal.layer — a plain `Layer.provide` would
// consume it internally and the test's `yield* EventV2Bridge.Service` would
// resolve to a different instance, missing every published event.
// Each test uses a unique SessionID so rows never collide across tests
// (goal_state.session_id is the primary key).
const testLayer = Goal.layer.pipe(
  Layer.provide(SessionStatus.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(EventV2Bridge.defaultLayer),
)

const it = testEffect(testLayer)

type CapturedEvent = {
  type: string
  status?: string
  turnsUsed?: number
  subgoals?: ReadonlyArray<unknown>
}

const captureEvents = (events: EventV2Bridge.Service["Service"]) =>
  Effect.gen(function* () {
    const seen: CapturedEvent[] = []
    const unsubscribe = yield* events.listen((event) =>
      Effect.sync(() => {
        // goal.updated carries { sessionID, goal: { status, turnsUsed, subgoals, ... } };
        // goal.cleared carries only { sessionID }.
        const goal = (
          event.data as { goal?: { status?: string; turnsUsed?: number; subgoals?: ReadonlyArray<unknown> } }
        ).goal
        seen.push({
          type: event.type,
          status: goal?.status,
          turnsUsed: goal?.turnsUsed,
          subgoals: goal?.subgoals,
        })
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    return seen
  })

// Returns the single goal.updated(done) event from a capture, failing the test
// loudly if there isn't exactly one (used by markDone / terminal-flow tests).
const doneUpdated = (events: ReadonlyArray<CapturedEvent>) => {
  const done = events.filter((e) => e.type === GoalEvent.Updated.type && e.status === "done")
  expect(done.length).toBe(1)
  return done[0]
}

// Forks a synthetic "loop fiber" that blocks forever and records whether it has
// been interrupted. The Goal service's fiber map (`fibers`) is private inside
// its layer closure, so fiber-map behavior can only be observed through
// interruption side effects: register the tracked fiber, trigger the action
// under test, then read `holder.interrupted`.
//
// The `ready` deferred is awaited before returning so the child has STARTED and
// registered its onInterrupt finalizer before the caller touches the map —
// without it, an interrupt fired before the child scheduled could miss the
// finalizer and the test would race (see AGENTS.md "Synchronizing With
// Concurrent Work": wait on a published readiness signal, never Effect.sleep).
const trackedFiber = () =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const holder = { interrupted: false }
    const fiber = yield* Effect.gen(function* () {
      yield* Deferred.succeed(ready, undefined)
      yield* Effect.never
    }).pipe(
      Effect.onInterrupt(() => Effect.sync(() => (holder.interrupted = true))),
      Effect.forkChild,
    )
    yield* Deferred.await(ready)
    return { fiber, holder }
  })

describe("Goal.updateAfterJudge — continue branch", () => {
  // §2.1 baseline: continue increments turns_used exactly once and publishes
  // goal.updated(active). This is the ONE branch that is correct pre-fix and
  // must stay correct after the bug fixes.
  it.live("continue verdict increments turns_used by exactly one and publishes goal.updated", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      const sessionID = SessionID.descending()

      yield* goal.set(sessionID, "build feature X", 10)
      seen.length = 0 // drop the set() goal.updated(active)

      const result = yield* goal.updateAfterJudge(sessionID, "continue", "more steps", false)

      expect(result?.shouldContinue).toBe(true)
      const loaded = yield* goal.load(sessionID)
      expect(Number(loaded?.turns_used)).toBe(1)
      expect(loaded?.status).toBe("active")

      const updates = seen.filter((e) => e.type === GoalEvent.Updated.type)
      expect(updates.length).toBe(1)
      expect(updates[0].status).toBe("active")
      expect(updates[0].turnsUsed).toBe(1)
    }),
  )
})

describe("Goal.updateAfterJudge — done branch (turn budget)", () => {
  // §2.2 — done is a STATE TRANSITION, not a continuation dispatch, so it must
  // NOT consume budget. Pre-fix this fails (code does +1); post-§3 it passes.
  it.live("done verdict does not increment turns_used (state transitions are budget-neutral)", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.descending()
      yield* goal.set(sessionID, "ship feature X", 10)
      const before = yield* goal.load(sessionID)
      const n = Number(before?.turns_used)

      yield* goal.updateAfterJudge(sessionID, "done", "delivered", false)

      const after = yield* goal.load(sessionID)
      expect(after?.status).toBe("done")
      expect(Number(after?.turns_used)).toBe(n)
    }),
  )
})

describe("Goal.updateAfterJudge — done branch (terminal event contract)", () => {
  // §2.3 — updateAfterJudge's done branch must NOT publish goal.updated; only
  // deleteAndPublishDone owns the terminal sequence. Pre-fix this fails (code
  // publishes); post-§4 it passes.
  it.live("done verdict does not publish goal.updated (single-owner: deleteAndPublishDone)", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      const sessionID = SessionID.descending()

      yield* goal.set(sessionID, "ship feature X", 10)
      seen.length = 0

      yield* goal.updateAfterJudge(sessionID, "done", "delivered", false)

      const updates = seen.filter((e) => e.type === GoalEvent.Updated.type)
      expect(updates.length).toBe(0)
    }),
  )

  // §4.3 — full judge-done flow: updateAfterJudge persists the done row WITHOUT
  // publishing, then deleteAndPublishDone publishes the terminal sequence
  // exactly once: goal.updated(done) → goal.cleared, no duplicate updated.
  it.live("full judge-done flow publishes goal.updated(done) -> goal.cleared exactly once", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      const sessionID = SessionID.descending()

      yield* goal.set(sessionID, "ship feature X", 10)
      seen.length = 0

      yield* goal.updateAfterJudge(sessionID, "done", "delivered", false)
      yield* goal.deleteAndPublishDone(sessionID, "delivered")

      const types = seen.map((e) => e.type)
      expect(types).toEqual([GoalEvent.Updated.type, GoalEvent.Cleared.type])
      doneUpdated(seen)
      const cleared = seen.filter((e) => e.type === GoalEvent.Cleared.type)
      expect(cleared.length).toBe(1)

      // row is gone after the terminal sequence
      const loaded = yield* goal.load(sessionID)
      expect(loaded).toBeUndefined()
    }),
  )
})

describe("Goal.markDone — turns_used is budget-neutral", () => {
  // §2.4 — user/agent-initiated completion on a goal that never ran a continue
  // dispatch. turns_used must stay at its current value (budget counts
  // continuation dispatches only). Pre-fix this fails (+1); post-§3 it passes.
  // The row is deleted by deleteAndPublishDone, so turns_used is read from the
  // published goal.updated(done) payload.
  it.live("markDone on a fresh active goal does not increment turns_used", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      const sessionID = SessionID.descending()

      yield* goal.set(sessionID, "ship feature X", 10)
      const before = yield* goal.load(sessionID)
      seen.length = 0

      yield* goal.markDone(sessionID, "agent self-declared")

      const event = doneUpdated(seen)
      expect(event.turnsUsed).toBe(Number(before?.turns_used))
    }),
  )

  // §2.5 — agent self-declares completion mid-loop: a continue dispatch already
  // incremented turns_used (N → N+1); markDone must NOT add a second increment.
  // The reported count reflects only the continuation dispatch, not the
  // completion call (reasoner C1). Pre-fix this fails (double-count → N+2);
  // post-§3 it passes (N+1).
  it.live("markDone after a continue dispatch does not double-count", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      const sessionID = SessionID.descending()

      yield* goal.set(sessionID, "ship feature X", 10)
      // Simulate one continuation dispatch (the budget-consuming event).
      yield* goal.updateAfterJudge(sessionID, "continue", "more steps", false)
      const continued = yield* goal.load(sessionID)
      seen.length = 0

      yield* goal.markDone(sessionID, "agent self-declared")

      const event = doneUpdated(seen)
      // Only the continue increment; markDone adds nothing.
      expect(event.turnsUsed).toBe(Number(continued?.turns_used))
    }),
  )
})

// ---------------------------------------------------------------------------
// §5 — Expand state-machine coverage (lock the contract). All PASS against
// current post-bug-fix behavior; they exist to catch regressions when §6-§10
// land.
// ---------------------------------------------------------------------------

describe("Goal.set — saves active row + publishes goal.updated(active)", () => {
  // §5.1 — the entry point of the lifecycle. Locks the initial row shape and
  // the published event: status active, turns_used 0, empty subgoals.
  it.live("set persists an active row with turns_used 0 / subgoals [] and publishes goal.updated(active)", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      const sessionID = SessionID.descending()

      const state = yield* goal.set(sessionID, "build feature X", 10)

      expect(state.status).toBe("active")
      expect(Number(state.turns_used)).toBe(0)
      expect(state.subgoals).toEqual([])

      const loaded = yield* goal.load(sessionID)
      expect(loaded?.status).toBe("active")
      expect(Number(loaded?.turns_used)).toBe(0)
      expect(loaded?.subgoals).toEqual([])

      const updates = seen.filter((e) => e.type === GoalEvent.Updated.type)
      expect(updates.length).toBe(1)
      expect(updates[0].status).toBe("active")
      expect(updates[0].turnsUsed).toBe(0)
      expect(updates[0].subgoals).toEqual([])
    }),
  )
})

describe("Goal.pause — active→paused, clears loop fiber, publishes goal.updated(paused)", () => {
  // §5.2 — pause must (a) transition to paused, (b) clear the loop fiber via
  // clearFiber (verified through the tracked fiber's interrupt side effect),
  // and (c) publish goal.updated(paused) carrying the reason.
  it.live("pause transitions to paused, interrupts the loop fiber, and publishes with the reason", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      const sessionID = SessionID.descending()

      yield* goal.set(sessionID, "build feature X", 10)
      const tracked = yield* trackedFiber()
      yield* goal.registerLoopFiber(sessionID, tracked.fiber)
      seen.length = 0

      const result = yield* goal.pause(sessionID, "user-paused: checking in")

      expect(result?.status).toBe("paused")
      expect(result?.paused_reason).toBe("user-paused: checking in")
      // pause() calls clearFiber → Fiber.interrupt on the registered loop fiber
      expect(tracked.holder.interrupted).toBe(true)

      const loaded = yield* goal.load(sessionID)
      expect(loaded?.status).toBe("paused")

      const updates = seen.filter((e) => e.type === GoalEvent.Updated.type)
      expect(updates.length).toBe(1)
      expect(updates[0].status).toBe("paused")
    }),
  )
})

describe("Goal.resume — preserves turns_used (no fresh budget), resets parse failures", () => {
  // §5.3 — CRITICAL regression guard: resume must NOT reset turns_used. A
  // paused goal that exhausted its budget would otherwise get a fresh full
  // budget on every resume, defeating max_turns as a runaway guard. Also
  // resets consecutive_parse_failures so a resumed goal gets a clean slate
  // for judge-parse-failure auto-pause.
  it.live("resume transitions paused→active, preserves turns_used, and resets consecutive_parse_failures", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      const sessionID = SessionID.descending()

      yield* goal.set(sessionID, "build feature X", 10)
      // One continuation dispatch with a parse failure → turns_used=1, cpf=1
      yield* goal.updateAfterJudge(sessionID, "continue", "more steps", true)
      const beforePause = yield* goal.load(sessionID)
      expect(Number(beforePause?.turns_used)).toBe(1)
      expect(Number(beforePause?.consecutive_parse_failures)).toBe(1)
      // User-initiated pause preserves turns_used + cpf
      yield* goal.pause(sessionID, "user paused")
      seen.length = 0

      const result = yield* goal.resume(sessionID)

      expect(result?.status).toBe("active")
      // turns_used preserved — NOT reset to 0
      expect(Number(result?.turns_used)).toBe(Number(beforePause?.turns_used))
      // parse-failure counter reset on resume
      expect(Number(result?.consecutive_parse_failures)).toBe(0)

      const loaded = yield* goal.load(sessionID)
      expect(loaded?.status).toBe("active")
      expect(Number(loaded?.turns_used)).toBe(1)
      expect(Number(loaded?.consecutive_parse_failures)).toBe(0)

      const updates = seen.filter((e) => e.type === GoalEvent.Updated.type)
      expect(updates.length).toBe(1)
      expect(updates[0].status).toBe("active")
    }),
  )

  // §5.4 — budget-exhausted pause: resume flips to active but keeps turns_used
  // intact (== max_turns). The next judge iteration immediately re-pauses; the
  // dispatch layer surfaces a warning (goal.ts:506-509). This locks that resume
  // does NOT silently grant a fresh budget.
  it.live("resume on a budget-exhausted paused goal keeps turns_used at max (no budget reset)", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.descending()

      // max_turns=2: a second continue verdict trips the budget-pause branch
      yield* goal.set(sessionID, "build feature X", 2)
      yield* goal.updateAfterJudge(sessionID, "continue", "step 1", false) // turns_used 1
      yield* goal.updateAfterJudge(sessionID, "continue", "step 2", false) // turns_used 2 >= max → paused

      const paused = yield* goal.load(sessionID)
      expect(paused?.status).toBe("paused")
      expect(Number(paused?.turns_used)).toBe(2)

      const result = yield* goal.resume(sessionID)

      // Active again, but turns_used unchanged — immediately re-exhaustible.
      expect(result?.status).toBe("active")
      expect(Number(result?.turns_used)).toBe(2)
      expect(Number(result?.turns_used) >= Number(result?.max_turns)).toBe(true)
    }),
  )
})

describe("Goal.clear — deletes row, clears loop fiber, publishes goal.cleared", () => {
  // §5.5 — clear tears down everything: row deleted, loop fiber interrupted,
  // exactly one goal.cleared published, and NO goal.updated (clear is not a
  // state transition, it is removal).
  it.live("clear removes the row, interrupts the loop fiber, and publishes exactly one goal.cleared", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      const sessionID = SessionID.descending()

      yield* goal.set(sessionID, "build feature X", 10)
      const tracked = yield* trackedFiber()
      yield* goal.registerLoopFiber(sessionID, tracked.fiber)
      seen.length = 0

      yield* goal.clear(sessionID)

      expect(tracked.holder.interrupted).toBe(true)
      const loaded = yield* goal.load(sessionID)
      expect(loaded).toBeUndefined()

      const cleared = seen.filter((e) => e.type === GoalEvent.Cleared.type)
      expect(cleared.length).toBe(1)
      const updates = seen.filter((e) => e.type === GoalEvent.Updated.type)
      expect(updates.length).toBe(0)
    }),
  )
})

describe("Goal.registerLoopFiber — interrupts the previous fiber before storing the new one", () => {
  // §5.6 — registering a new fiber for a session that already has one must
  // interrupt the old one first (prevents a leaked/orphaned loop fiber when a
  // new afterIdle run supersedes the prior). Verified by: (a) old fiber
  // interrupted, (b) new fiber intact, (c) a subsequent clearLoopFiber
  // interrupts the NEW fiber (proves it was actually stored).
  it.live("registering a new fiber interrupts the previously-registered fiber for the same session", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.descending()

      const first = yield* trackedFiber()
      yield* goal.registerLoopFiber(sessionID, first.fiber)
      expect(first.holder.interrupted).toBe(false)

      const second = yield* trackedFiber()
      yield* goal.registerLoopFiber(sessionID, second.fiber)

      // previous fiber interrupted by the re-register
      expect(first.holder.interrupted).toBe(true)
      // new fiber is intact and is now the one stored in the map
      expect(second.holder.interrupted).toBe(false)
      // clearing now interrupts the NEW fiber, proving it was stored
      yield* goal.clearLoopFiber(sessionID)
      expect(second.holder.interrupted).toBe(true)
    }),
  )
})

describe("Goal fiber-safe terminal paths — do NOT touch the fiber map", () => {
  // §5.7 — deleteAndPublishDone and pauseAndPublish are called from INSIDE the
  // loop fiber itself (loop.ts done / shouldPreempt branches). They must NOT
  // manage the fiber map — doing so would self-interrupt before the terminal
  // / pause event reaches the bus (the event would never be published). This
  // locks the self-interrupt-hazard discipline: caller manages the fiber.
  it.live("deleteAndPublishDone leaves the registered loop fiber intact", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.descending()

      yield* goal.set(sessionID, "build feature X", 10)
      const tracked = yield* trackedFiber()
      yield* goal.registerLoopFiber(sessionID, tracked.fiber)

      yield* goal.deleteAndPublishDone(sessionID, "judge done")

      // fiber NOT interrupted — map untouched
      expect(tracked.holder.interrupted).toBe(false)
      // the map still holds it: clearing now interrupts the registered fiber
      yield* goal.clearLoopFiber(sessionID)
      expect(tracked.holder.interrupted).toBe(true)
    }),
  )

  it.live("pauseAndPublish leaves the registered loop fiber intact", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.descending()

      yield* goal.set(sessionID, "build feature X", 10)
      const tracked = yield* trackedFiber()
      yield* goal.registerLoopFiber(sessionID, tracked.fiber)

      yield* goal.pauseAndPublish(sessionID, "loop self-pause")

      // fiber NOT interrupted — map untouched
      expect(tracked.holder.interrupted).toBe(false)
      // the map still holds it: clearing now interrupts the registered fiber
      yield* goal.clearLoopFiber(sessionID)
      expect(tracked.holder.interrupted).toBe(true)
    }),
  )
})

// ---------------------------------------------------------------------------
// §9 — Transport errors count toward pause budget (D5). Transport failures
// (timeout, network) now return parseFailed: true from the judge, feeding the
// same consecutive_parse_failures counter as parse failures. Three in a row
// triggers auto-pause; alternating transport/parse failures must NOT reset the
// counter (pre-fix transport returned parseFailed: false, which reset it to 0
// and let a flaky provider burn the full budget without ever pausing).
// ---------------------------------------------------------------------------

describe("Goal.updateAfterJudge — transport failures trigger auto-pause (D5)", () => {
  // §9.3a — three consecutive transport failures (parseFailed: true, simulating
  // what judge.ts now returns on timeout/network) must reach
  // MAX_CONSECUTIVE_PARSE_FAILURES (3) and auto-pause on the third.
  it.live("three consecutive transport failures auto-pause the goal", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      const sessionID = SessionID.descending()

      yield* goal.set(sessionID, "build feature X", 10)
      seen.length = 0

      // Two transport failures — still active, counter climbing 1 → 2
      const r1 = yield* goal.updateAfterJudge(sessionID, "continue", "transport error 1", true)
      const r2 = yield* goal.updateAfterJudge(sessionID, "continue", "transport error 2", true)
      expect(r1?.shouldContinue).toBe(true)
      expect(r2?.shouldContinue).toBe(true)

      const midState = yield* goal.load(sessionID)
      expect(midState?.status).toBe("active")
      expect(Number(midState?.consecutive_parse_failures)).toBe(2)

      // Third transport failure — counter reaches 3 → auto-pause
      const r3 = yield* goal.updateAfterJudge(sessionID, "continue", "transport error 3", true)
      expect(r3?.shouldContinue).toBe(false)

      const finalState = yield* goal.load(sessionID)
      expect(finalState?.status).toBe("paused")
      expect(Number(finalState?.consecutive_parse_failures)).toBeGreaterThanOrEqual(
        GoalPrompts.MAX_CONSECUTIVE_PARSE_FAILURES,
      )

      const paused = seen.filter((e) => e.type === GoalEvent.Updated.type && e.status === "paused")
      expect(paused.length).toBe(1)
    }),
  )

  // §9.3b — alternating transport + parse failures. Before §9, transport errors
  // returned parseFailed: false which reset consecutive_parse_failures to 0 on
  // every transport blip, so alternating transport/parse/transport never
  // reached the threshold. After §9, both failure modes set parseFailed: true,
  // so the counter climbs monotonically across the mix and pauses on the 3rd.
  it.live("alternating transport + parse failures still triggers auto-pause", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.descending()

      yield* goal.set(sessionID, "build feature X", 10)

      // transport-fail (parseFailed: true) → counter 1
      yield* goal.updateAfterJudge(sessionID, "continue", "transport error", true)
      let state = yield* goal.load(sessionID)
      expect(Number(state?.consecutive_parse_failures)).toBe(1)
      expect(state?.status).toBe("active")

      // parse-fail (parseFailed: true) → counter 2
      yield* goal.updateAfterJudge(sessionID, "continue", "无法解析", true)
      state = yield* goal.load(sessionID)
      expect(Number(state?.consecutive_parse_failures)).toBe(2)
      expect(state?.status).toBe("active")

      // transport-fail (parseFailed: true) → counter 3 → PAUSE
      const r3 = yield* goal.updateAfterJudge(sessionID, "continue", "transport error", true)
      expect(r3?.shouldContinue).toBe(false)

      state = yield* goal.load(sessionID)
      expect(state?.status).toBe("paused")
    }),
  )
})

// ---------------------------------------------------------------------------
// §10 — Zombie-goal freshness guard (D6). When afterIdle detects an active goal
// with turns_used 0, no assistant message, and created_at older than
// FRESHNESS_THRESHOLD, it calls pauseAndPublish with a freshness reason. This
// tests that the pause transition (the mechanism the guard uses) publishes the
// paused event with the freshness reason — the guard's predicate logic itself
// is locked in loop.test.ts (isStaleZombie).
// ---------------------------------------------------------------------------

describe("Goal.pauseAndPublish — freshness-guard pause (D6)", () => {
  // §10.3 — the exact pause transition afterIdle's freshness guard performs:
  // pauseAndPublish with the freshness reason string. Verifies the goal flips
  // to paused, the reason is persisted, and goal.updated(paused) fires on the
  // bus so the TUI/SSE surfaces the orphaned goal instead of leaving it silent.
  it.live("freshness pause transitions active→paused and publishes with the reason", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      const sessionID = SessionID.descending()

      yield* goal.set(sessionID, "build feature X", 10)
      seen.length = 0

      const reason = `initial kick produced no assistant response within ${GoalPrompts.FRESHNESS_THRESHOLD / 1000}s — likely provider error or model refusal. Use /goal resume to retry.`
      const result = yield* goal.pauseAndPublish(sessionID, reason)

      expect(result?.status).toBe("paused")
      expect(result?.paused_reason).toBe(reason)

      const loaded = yield* goal.load(sessionID)
      expect(loaded?.status).toBe("paused")
      expect(loaded?.paused_reason).toBe(reason)

      const paused = seen.filter((e) => e.type === GoalEvent.Updated.type && e.status === "paused")
      expect(paused.length).toBe(1)
    }),
  )

  // §10.4 — a fresh goal (within threshold) does NOT hit the freshness guard.
  // pauseAndPublish with a freshness reason is never invoked; the goal stays
  // active. This is verified at the predicate level in loop.test.ts
  // (isStaleZombie returns false for fresh goals); here we confirm a fresh
  // goal row remains active and unpauseable by anything other than an explicit
  // pause call — the guard's absence is the expected behavior.
  it.live("fresh goal stays active (freshness guard does not fire)", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.descending()

      // A freshly-set goal: created_at is now, turns_used 0 — the exact state
      // the guard checks, but within the threshold so the predicate is false.
      yield* goal.set(sessionID, "build feature X", 10)

      const state = yield* goal.load(sessionID)
      expect(state?.status).toBe("active")
      expect(Number(state?.turns_used)).toBe(0)
      // created_at is recent (within the last second), well inside the threshold
      expect(Date.now() - Number(state?.created_at)).toBeLessThan(GoalPrompts.FRESHNESS_THRESHOLD)
    }),
  )
})
