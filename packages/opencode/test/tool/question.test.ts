import { describe, expect } from "bun:test"
import { Effect, Exit, Cause, Fiber, Layer, Schema } from "effect"
import z from "zod"
import { QuestionTool } from "../../src/tool/question"
import { Question } from "../../src/question"
import { SessionID, MessageID } from "../../src/session/schema"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Truncate } from "@/tool/truncate"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_test-session"),
  messageID: MessageID.make("test-message"),
  callID: "test-call",
  agent: "test-agent",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const it = testEffect(
  Layer.mergeAll(Question.defaultLayer, CrossSpawnSpawner.defaultLayer, Truncate.defaultLayer, Agent.defaultLayer),
)

const pending = Effect.fn("QuestionToolTest.pending")(function* (question: Question.Interface) {
  for (;;) {
    const items = yield* question.list()
    const item = items[0]
    if (item) return item
    yield* Effect.sleep("10 millis")
  }
})

describe("tool.question", () => {
  it.live("should successfully execute with valid question parameters", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const question = yield* Question.Service
        const toolInfo = yield* QuestionTool
        const tool = yield* toolInfo.init()
        const questions = [
          {
            question: "What is your favorite color?",
            header: "Color",
            options: [
              { label: "Red", description: "The color of passion" },
              { label: "Blue", description: "The color of sky" },
            ],
            multiple: false,
          },
        ]

        const fiber = yield* tool.execute({ questions }, ctx).pipe(Effect.forkScoped)
        const item = yield* pending(question)
        yield* question.reply({ requestID: item.id, answers: [["Red"]] })

        const result = yield* Fiber.join(fiber)
        expect(result.title).toBe("Asked 1 question")
      }),
    ),
  )

  it.live("should now pass with a header longer than 12 but less than 30 chars", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const question = yield* Question.Service
        const toolInfo = yield* QuestionTool
        const tool = yield* toolInfo.init()
        const questions = [
          {
            question: "What is your favorite animal?",
            header: "This Header is Over 12",
            options: [{ label: "Dog", description: "Man's best friend" }],
          },
        ]

        const fiber = yield* tool.execute({ questions }, ctx).pipe(Effect.forkScoped)
        const item = yield* pending(question)
        yield* question.reply({ requestID: item.id, answers: [["Dog"]] })

        const result = yield* Fiber.join(fiber)
        expect(result.output).toContain(`"What is your favorite animal?"="Dog"`)
      }),
    ),
  )

  // ── formatValidationError tests ───────────────────────────────────────────

  it.live("formatValidationError: should explain missing question field with hint and example", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* QuestionTool
        const tool = yield* toolInfo.init()

        // Parse real bad input: LLM puts text in "header" but omits "question"
        const parseResult = Schema.decodeUnknownExit(tool.parameters)({
          questions: [{ header: "Deploy target", options: [{ label: "Vercel", description: "Edge" }] }],
        })
        expect(Exit.isFailure(parseResult)).toBe(true)
        if (Exit.isSuccess(parseResult)) return

        expect(tool.formatValidationError).toBeDefined()
        const message = tool.formatValidationError!(Cause.squash(parseResult.cause))

        // Must surface the offending path
        expect(message).toContain("questions.0.question")
        // Must call out the required-field hint
        expect(message).toContain('"question" is REQUIRED')
        // Must include field spec with all required fields
        expect(message).toContain("header")
        expect(message).toContain("options")
        // Must include a runnable call example
        expect(message).toContain("Correct call example")
        expect(message).toContain('"question":')
        // Must end with re-issue instruction
        expect(message).toContain("Please re-issue the tool call")
      }),
    ),
  )

  it.live("execute with missing question field should die with formatValidationError output", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* QuestionTool
        const tool = yield* toolInfo.init()

        // Simulate LLM call that puts text only in "header" and omits "question"
        const badArgs = { questions: [{ header: "Deploy target", options: [{ label: "Vercel", description: "Edge" }] }] }

        // Effect.exit captures the Die defect as Exit.Failure(Cause.Die(error))
        const exit = yield* Effect.exit(tool.execute(badArgs as any, ctx))
        expect(Exit.isFailure(exit)).toBe(true)
        if (!Exit.isFailure(exit)) return

        const defect = Cause.squash(exit.cause)
        expect(defect).toBeInstanceOf(Error)
        const msg = (defect as Error).message
        // The formatted message must reach the caller through the full execute path
        expect(msg).toContain('"question" is REQUIRED')
        expect(msg).toContain("Correct call example")
        expect(msg).toContain("Please re-issue the tool call")
      }),
    ),
  )

  it.live("formatValidationError: missing options field should surface correct path", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* QuestionTool
        const tool = yield* toolInfo.init()

        // Parse bad input: "options" is also a required field
        const parseResult = Schema.decodeUnknownExit(tool.parameters)({
          questions: [{ question: "Which environment?", header: "Env" }],
        })
        expect(Exit.isFailure(parseResult)).toBe(true)
        if (Exit.isSuccess(parseResult)) return

        const message = tool.formatValidationError!(Cause.squash(parseResult.cause))
        expect(message).toContain("questions.0.options")
        expect(message).toContain('"options" is REQUIRED')
        expect(message).toContain("Correct call example")
      }),
    ),
  )

  // intentionally removed the zod validation due to tool call errors, hoping prompting is gonna be good enough
  //   test("should throw an Error for header exceeding 30 characters", async () => {
  //     const tool = await QuestionTool.init()
  //     const questions = [
  //       {
  //         question: "What is your favorite animal?",
  //         header: "This Header is Definitely More Than Thirty Characters Long",
  //         options: [{ label: "Dog", description: "Man's best friend" }],
  //       },
  //     ]
  //     try {
  //       await tool.execute({ questions }, ctx)
  //       // If it reaches here, the test should fail
  //       expect(true).toBe(false)
  //     } catch (e: any) {
  //       expect(e).toBeInstanceOf(Error)
  //       expect(e.cause).toBeInstanceOf(z.ZodError)
  //     }
  //   })

  //   test("should throw an Error for label exceeding 30 characters", async () => {
  //     const tool = await QuestionTool.init()
  //     const questions = [
  //       {
  //         question: "A question with a very long label",
  //         header: "Long Label",
  //         options: [
  //           { label: "This is a very, very, very long label that will exceed the limit", description: "A description" },
  //         ],
  //       },
  //     ]
  //     try {
  //       await tool.execute({ questions }, ctx)
  //       // If it reaches here, the test should fail
  //       expect(true).toBe(false)
  //     } catch (e: any) {
  //       expect(e).toBeInstanceOf(Error)
  //       expect(e.cause).toBeInstanceOf(z.ZodError)
  //     }
  //   })
})
