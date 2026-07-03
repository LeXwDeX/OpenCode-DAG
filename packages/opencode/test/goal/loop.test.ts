import { describe, expect, test } from "bun:test"
import { GoalLoop } from "@/goal/loop"
import { GoalPrompts } from "@/goal/prompts"

type Msg = Parameters<typeof GoalLoop.shouldPreempt>[0][number]

const mk = (role: "user" | "assistant", created: number): Msg => ({
  info: { role, time: { created } },
})

describe("shouldPreempt", () => {
  // §1.7 — last user message newer than last assistant → preempt (true)
  test("user message newer than last assistant returns true", () => {
    const msgs = [mk("assistant", 100), mk("user", 200)]
    expect(GoalLoop.shouldPreempt(msgs)).toBe(true)
  })

  // §1.8 — last assistant newer → no preempt (false)
  test("assistant message newer than last user returns false", () => {
    const msgs = [mk("user", 100), mk("assistant", 200)]
    expect(GoalLoop.shouldPreempt(msgs)).toBe(false)
  })

  // §1.9 — missing user OR assistant → defensive false
  test("missing user message returns false", () => {
    const msgs = [mk("assistant", 100), mk("assistant", 200)]
    expect(GoalLoop.shouldPreempt(msgs)).toBe(false)
  })

  test("missing assistant message returns false", () => {
    const msgs = [mk("user", 100), mk("user", 200)]
    expect(GoalLoop.shouldPreempt(msgs)).toBe(false)
  })

  test("empty message list returns false", () => {
    expect(GoalLoop.shouldPreempt([])).toBe(false)
  })

  // strict `>` comparison: equal timestamps are NOT a preempt
  test("equal timestamps return false (strict greater-than)", () => {
    const msgs = [mk("assistant", 200), mk("user", 200)]
    expect(GoalLoop.shouldPreempt(msgs)).toBe(false)
  })

  // tracks the MAXIMUM timestamp per role across interleaved messages
  test("uses the most recent timestamp per role regardless of order", () => {
    const msgs = [
      mk("assistant", 500),
      mk("user", 100),
      mk("assistant", 200),
      mk("user", 600),
    ]
    // lastUserAt = 600, lastAsstAt = 500 → preempt
    expect(GoalLoop.shouldPreempt(msgs)).toBe(true)
  })

  // messages missing `time.created` are skipped (defensive)
  test("messages missing created timestamp are skipped", () => {
    const msgs = [
      { info: { role: "assistant", time: { created: 100 } } },
      { info: { role: "user", time: {} } },
    ] as ReadonlyArray<Msg>
    // no valid user timestamp → false
    expect(GoalLoop.shouldPreempt(msgs)).toBe(false)
  })
})

describe("isStaleZombie — freshness guard predicate (D6)", () => {
  // Helper: builds a goal-state-shaped object for the predicate. created_at is
  // expressed relative to a fixed `now` to keep tests deterministic.
  const state = (overrides: Partial<{ status: string; turns_used: number; created_at: number }> = {}) => ({
    status: "active",
    turns_used: 0,
    created_at: 0,
    ...overrides,
  })
  const NOW = 1_000_000

  // §10.3 — the fire condition: active, turns_used 0, older than the threshold,
  // and no assistant message. This is exactly the orphan state afterIdle must
  // convert into a visible pause.
  test("stale active goal with zero turns and no assistant → true", () => {
    const s = state({ created_at: NOW - GoalPrompts.FRESHNESS_THRESHOLD - 1 })
    expect(GoalLoop.isStaleZombie(s, false, NOW)).toBe(true)
  })

  // §10.4 — fresh goal: created within the threshold. Must NOT pause even with
  // no assistant message — the initial kick may just be slow, not failed.
  test("fresh active goal (within threshold) → false", () => {
    const s = state({ created_at: NOW - 1000 })
    expect(GoalLoop.isStaleZombie(s, false, NOW)).toBe(false)
  })

  // Exactly at the threshold is NOT stale (strict >).
  test("goal exactly at threshold boundary → false (strict greater-than)", () => {
    const s = state({ created_at: NOW - GoalPrompts.FRESHNESS_THRESHOLD })
    expect(GoalLoop.isStaleZombie(s, false, NOW)).toBe(false)
  })

  // Has an assistant message → not orphaned, the initial kick succeeded.
  test("stale goal but assistant message exists → false", () => {
    const s = state({ created_at: NOW - GoalPrompts.FRESHNESS_THRESHOLD - 1 })
    expect(GoalLoop.isStaleZombie(s, true, NOW)).toBe(false)
  })

  // Already ran continuations → turns_used > 0, not a zombie.
  test("stale goal but turns_used > 0 → false", () => {
    const s = state({ turns_used: 3, created_at: NOW - GoalPrompts.FRESHNESS_THRESHOLD - 1 })
    expect(GoalLoop.isStaleZombie(s, false, NOW)).toBe(false)
  })

  // Not active (paused/done) → predicate short-circuits; pauseAndPublish would
  // be a no-op anyway, but the guard must not fire.
  test("paused goal → false", () => {
    const s = state({ status: "paused", created_at: NOW - GoalPrompts.FRESHNESS_THRESHOLD - 1 })
    expect(GoalLoop.isStaleZombie(s, false, NOW)).toBe(false)
  })
})
