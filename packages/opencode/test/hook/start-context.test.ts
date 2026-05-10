import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { HookStartContext } from "../../src/hook/start-context"
import { SessionID } from "../../src/session/schema"

const it = testEffect(HookStartContext.defaultLayer.pipe(Layer.provideMerge(CrossSpawnSpawner.defaultLayer)))

describe("HookStartContext", () => {
  it.live("append + consume drains store; second consume returns empty", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* HookStartContext.Service
        const sid = SessionID.make("ses_test_1")
        yield* svc.append(sid, "ctx1")
        yield* svc.append(sid, "ctx2")
        const r1 = yield* svc.consume(sid)
        expect(r1).toEqual(["ctx1", "ctx2"])
        const r2 = yield* svc.consume(sid)
        expect(r2).toEqual([])
      }),
    ),
  )

  it.live("sessions are isolated", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* HookStartContext.Service
        yield* svc.append(SessionID.make("ses_a"), "a")
        yield* svc.append(SessionID.make("ses_b"), "b")
        expect(yield* svc.consume(SessionID.make("ses_a"))).toEqual(["a"])
        expect(yield* svc.consume(SessionID.make("ses_b"))).toEqual(["b"])
      }),
    ),
  )
})
