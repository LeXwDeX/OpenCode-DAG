import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Goal } from "@/goal/goal"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Goal.defaultLayer, SessionStatus.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("dispatch during busy session (I5)", () => {
  it.live("/goal status during busy is allowed", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const goal = yield* Goal.Service
        const status = yield* SessionStatus.Service
        const id = SessionID.descending()
        yield* status.set(id, { type: "busy" })
        const out = yield* goal.dispatch(id, "status")
        expect(out.type).toBe("message")
        expect(out.text).toContain("没有活跃")
      }),
    ),
  )

  it.live("/goal <new> during busy is rejected with friendly text and no state change", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const goal = yield* Goal.Service
        const status = yield* SessionStatus.Service
        const id = SessionID.descending()
        yield* status.set(id, { type: "busy" })
        const out = yield* goal.dispatch(id, "ship feature X")
        expect(out.type).toBe("message")
        expect(out.text).toContain("/stop")
        const state = yield* goal.load(id)
        expect(state).toBeUndefined()
      }),
    ),
  )

  it.live("/goal pause during busy is allowed (control subcommand)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const goal = yield* Goal.Service
        const status = yield* SessionStatus.Service
        const id = SessionID.descending()
        yield* goal.set(id, "g")
        yield* status.set(id, { type: "busy" })
        const out = yield* goal.dispatch(id, "pause")
        expect(out.type).toBe("message")
        expect(out.text).toContain("已暂停")
        const state = yield* goal.load(id)
        expect(state?.status).toBe("paused")
      }),
    ),
  )

  it.live("/goal clear during busy is allowed (control subcommand)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const goal = yield* Goal.Service
        const status = yield* SessionStatus.Service
        const id = SessionID.descending()
        yield* goal.set(id, "g")
        yield* status.set(id, { type: "busy" })
        const out = yield* goal.dispatch(id, "clear")
        expect(out.type).toBe("message")
        expect(out.text).toContain("清除")
        const state = yield* goal.load(id)
        expect(state).toBeUndefined()
      }),
    ),
  )
})
