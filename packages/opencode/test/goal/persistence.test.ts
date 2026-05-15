import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Goal } from "@/goal/goal"
import { SessionID } from "@/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Goal.defaultLayer, CrossSpawnSpawner.defaultLayer))

// Reads happen via loadState() which queries the DB on every call, so a fresh
// Goal.Service over the same Instance dir always sees the latest persisted state.
// Layer.fresh forces re-construction (new in-memory fibers Map) while the
// outer provideTmpdirInstance keeps the same database directory.
const reload = <A>(eff: Effect.Effect<A, never, Goal.Service>) =>
  eff.pipe(Effect.provide(Layer.fresh(Goal.defaultLayer)))

describe("Goal persistence (I4)", () => {
  it.live("set goal → reload via fresh Goal.Service in same instance dir → state restored", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const id = SessionID.descending()
        yield* Effect.gen(function* () {
          const goal = yield* Goal.Service
          yield* goal.set(id, "ship X", 7)
        })
        const reloaded = yield* reload(
          Effect.gen(function* () {
            const goal = yield* Goal.Service
            return yield* goal.load(id)
          }),
        )
        expect(reloaded?.goal).toBe("ship X")
        expect(reloaded?.max_turns).toBe(7)
        expect(reloaded?.status).toBe("active")
      }),
    ),
  )

  it.live("update increments turns_used and persists across reload", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const id = SessionID.descending()
        const goal = yield* Goal.Service
        yield* goal.set(id, "g", 10)
        yield* goal.updateAfterJudge(id, "continue", "step", false)
        yield* goal.updateAfterJudge(id, "continue", "step", false)
        const reloaded = yield* reload(
          Effect.gen(function* () {
            const g = yield* Goal.Service
            return yield* g.load(id)
          }),
        )
        expect(reloaded?.turns_used).toBe(2)
      }),
    ),
  )

  it.live("clear deletes row → reload returns undefined", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const id = SessionID.descending()
        const goal = yield* Goal.Service
        yield* goal.set(id, "g")
        yield* goal.clear(id)
        const reloaded = yield* reload(
          Effect.gen(function* () {
            const g = yield* Goal.Service
            return yield* g.load(id)
          }),
        )
        expect(reloaded).toBeUndefined()
      }),
    ),
  )

  it.live("subgoals persist across reload", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const id = SessionID.descending()
        const goal = yield* Goal.Service
        yield* goal.set(id, "g")
        yield* goal.addSubgoal(id, "tests")
        yield* goal.addSubgoal(id, "docs")
        const reloaded = yield* reload(
          Effect.gen(function* () {
            const g = yield* Goal.Service
            return yield* g.load(id)
          }),
        )
        expect(reloaded?.subgoals).toEqual(["tests", "docs"])
      }),
    ),
  )
})
