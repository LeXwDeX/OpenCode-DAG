import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { GoalState } from "@/goal/state"

const baseValid = {
  goal: "ship feature X",
  status: "active",
  turns_used: 3,
  max_turns: 20,
  created_at: 1_700_000_000_000,
  last_turn_at: 1_700_000_000_500,
  consecutive_parse_failures: 0,
  subgoals: ["a", "b"],
}

describe("GoalState.Info schema", () => {
  test("encode/decode round-trip preserves all fields", () => {
    const decoded = Schema.decodeUnknownSync(GoalState.Info)(baseValid)
    expect(decoded.goal).toBe("ship feature X")
    expect(decoded.status).toBe("active")
    expect(decoded.turns_used).toBe(3)
    expect(decoded.subgoals).toEqual(["a", "b"])

    const encoded = Schema.encodeSync(GoalState.Info)(decoded)
    const reDecoded = Schema.decodeUnknownSync(GoalState.Info)(JSON.parse(JSON.stringify(encoded)))
    expect(reDecoded.goal).toBe(decoded.goal)
    expect(reDecoded.subgoals).toEqual(["a", "b"])
    expect(reDecoded.turns_used).toBe(decoded.turns_used)
  })

  test("legacy payload missing 'subgoals' decodes with default []", () => {
    const { subgoals: _omit, ...legacy } = baseValid
    const decoded = Schema.decodeUnknownSync(GoalState.Info)(legacy)
    expect(decoded.subgoals).toEqual([])
  })

  test("payload missing 'consecutive_parse_failures' fails decode (intentional - field required since v1)", () => {
    const { consecutive_parse_failures: _omit, ...broken } = baseValid
    expect(() => Schema.decodeUnknownSync(GoalState.Info)(broken)).toThrow()
  })

  test("turns_used negative is rejected by NonNegativeInt", () => {
    expect(() => Schema.decodeUnknownSync(GoalState.Info)({ ...baseValid, turns_used: -1 })).toThrow()
  })

  test("status accepts only active/paused/done/cleared", () => {
    for (const s of ["active", "paused", "done", "cleared"] as const) {
      const d = Schema.decodeUnknownSync(GoalState.Info)({ ...baseValid, status: s })
      expect(d.status).toBe(s)
    }
    expect(() => Schema.decodeUnknownSync(GoalState.Info)({ ...baseValid, status: "running" })).toThrow()
  })

  test("optional verdict / reason fields decode when present", () => {
    const decoded = Schema.decodeUnknownSync(GoalState.Info)({
      ...baseValid,
      last_verdict: "done",
      last_reason: "ok",
      paused_reason: undefined,
    })
    expect(decoded.last_verdict).toBe("done")
    expect(decoded.last_reason).toBe("ok")
  })
})
