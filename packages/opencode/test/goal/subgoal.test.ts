import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Goal } from "@/goal/goal"
import { GoalPrompts } from "@/goal/prompts"
import { SessionID } from "@/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Goal.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("Goal.dispatchSubgoal", () => {
  it.live("add appends to subgoals", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const goal = yield* Goal.Service
        const id = SessionID.descending()
        yield* goal.set(id, "g")
        yield* goal.dispatchSubgoal(id, "add write tests")
        yield* goal.dispatchSubgoal(id, "add update docs")
        const s = yield* goal.load(id)
        expect(s?.subgoals).toEqual(["write tests", "update docs"])
      }),
    ),
  )

  it.live("bare text falls through to add (P2-2)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const goal = yield* Goal.Service
        const id = SessionID.descending()
        yield* goal.set(id, "g")
        const out = yield* goal.dispatchSubgoal(id, "raw subgoal text")
        expect(out.type).toBe("message")
        expect(out.text).toContain("raw subgoal text")
        const s = yield* goal.load(id)
        expect(s?.subgoals).toEqual(["raw subgoal text"])
      }),
    ),
  )

  it.live("reserved word 'list' returns list (no add)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const goal = yield* Goal.Service
        const id = SessionID.descending()
        yield* goal.set(id, "g")
        yield* goal.dispatchSubgoal(id, "add a")
        const out = yield* goal.dispatchSubgoal(id, "list")
        expect(out.text).toContain("a")
        const s = yield* goal.load(id)
        expect(s?.subgoals).toEqual(["a"]) // not ["a", "list"]
      }),
    ),
  )

  it.live("remove N (1-based) drops correct entry", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const goal = yield* Goal.Service
        const id = SessionID.descending()
        yield* goal.set(id, "g")
        yield* goal.dispatchSubgoal(id, "add a")
        yield* goal.dispatchSubgoal(id, "add b")
        yield* goal.dispatchSubgoal(id, "add c")
        yield* goal.dispatchSubgoal(id, "remove 2")
        const s = yield* goal.load(id)
        expect(s?.subgoals).toEqual(["a", "c"])
      }),
    ),
  )

  it.live("remove N out of range leaves list unchanged", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const goal = yield* Goal.Service
        const id = SessionID.descending()
        yield* goal.set(id, "g")
        yield* goal.dispatchSubgoal(id, "add a")
        yield* goal.dispatchSubgoal(id, "remove 5")
        const s = yield* goal.load(id)
        expect(s?.subgoals).toEqual(["a"])
      }),
    ),
  )

  it.live("clear empties array", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const goal = yield* Goal.Service
        const id = SessionID.descending()
        yield* goal.set(id, "g")
        yield* goal.dispatchSubgoal(id, "add a")
        yield* goal.dispatchSubgoal(id, "add b")
        yield* goal.dispatchSubgoal(id, "clear")
        const s = yield* goal.load(id)
        expect(s?.subgoals).toEqual([])
      }),
    ),
  )

  it.live("subgoals without active goal returns 'no active goal' error", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const goal = yield* Goal.Service
        const id = SessionID.descending()
        const out = yield* goal.dispatchSubgoal(id, "add x")
        expect(out.text).toContain("没有活跃的目标")
      }),
    ),
  )
})

describe("prompt rendering with subgoals", () => {
  test("renderContinuation includes subgoals section when non-empty", () => {
    const text = GoalPrompts.renderContinuation("ship X", ["check tests", "update docs"])
    expect(text).toContain("Additional criteria")
    expect(text).toContain("1. check tests")
    expect(text).toContain("2. update docs")
  })

  test("renderContinuation omits subgoals section when empty", () => {
    const text = GoalPrompts.renderContinuation("ship X", [])
    expect(text).not.toContain("Additional criteria")
  })

  test("renderJudgeUserPrompt includes subgoals section when non-empty", () => {
    const text = GoalPrompts.renderJudgeUserPrompt("ship X", "did stuff", ["criterion A"])
    expect(text).toContain("Additional criteria")
    expect(text).toContain("1. criterion A")
    expect(text).toContain("did stuff")
  })

  test("renderJudgeUserPrompt omits subgoals section when empty", () => {
    const text = GoalPrompts.renderJudgeUserPrompt("ship X", "did stuff", [])
    expect(text).not.toContain("Additional criteria")
  })
})
