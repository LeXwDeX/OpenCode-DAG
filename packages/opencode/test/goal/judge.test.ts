import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { GoalJudge } from "@/goal/judge"

describe("Goal.Judge.parseJudgeResponse", () => {
  test("DONE verdict from clean JSON", () => {
    const r = GoalJudge.parseJudgeResponse(`{"done": true, "reason": "all done"}`)
    expect(r.verdict).toBe("done")
    expect(r.reason).toBe("all done")
    expect(r.parseFailed).toBe(false)
  })

  test("CONTINUE verdict from clean JSON", () => {
    const r = GoalJudge.parseJudgeResponse(`{"done": false, "reason": "still going"}`)
    expect(r.verdict).toBe("continue")
    expect(r.parseFailed).toBe(false)
  })

  test("empty assistant snippet returns continue + parseFailed=true", () => {
    const r = GoalJudge.parseJudgeResponse("")
    expect(r.verdict).toBe("continue")
    expect(r.parseFailed).toBe(true)
  })

  test("non-JSON response returns continue + parseFailed=true", () => {
    const r = GoalJudge.parseJudgeResponse("the model said yes definitely")
    expect(r.verdict).toBe("continue")
    expect(r.parseFailed).toBe(true)
  })

  test("markdown-fenced JSON ```json ... ``` is unwrapped successfully", () => {
    const r = GoalJudge.parseJudgeResponse('```json\n{"done": true, "reason": "wrapped"}\n```')
    expect(r.verdict).toBe("done")
    expect(r.reason).toBe("wrapped")
    expect(r.parseFailed).toBe(false)
  })

  test("regex extracts first {...} when surrounded by chatter", () => {
    const r = GoalJudge.parseJudgeResponse(`Sure! {"done": false, "reason": "step 2 next"} hope that helps`)
    expect(r.verdict).toBe("continue")
    expect(r.reason).toBe("step 2 next")
    expect(r.parseFailed).toBe(false)
  })
})

describe("Goal.Judge.run fail-open transport", () => {
  test("API error treated as transport (continue, NOT counted as parse failure)", async () => {
    const failingCallLLM = (_opts: {
      system: string
      user: string
      temperature: number
      maxTokens: number
      timeout: number
    }) => Effect.fail(new Error("network down"))

    const result = await Effect.runPromise(GoalJudge.run("the goal", "the response", [], failingCallLLM))
    expect(result.verdict).toBe("continue")
    expect(result.parseFailed).toBe(false)
    expect(result.reason).toContain("transport")
  })

  test("successful LLM call → parsed verdict propagates", async () => {
    const okCallLLM = () => Effect.succeed(`{"done": true, "reason": "yes"}`)
    const result = await Effect.runPromise(GoalJudge.run("g", "r", ["sub"], okCallLLM))
    expect(result.verdict).toBe("done")
    expect(result.reason).toBe("yes")
    expect(result.parseFailed).toBe(false)
  })
})
