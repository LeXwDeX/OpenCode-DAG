import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"

const parameters = z.object({
  questions: z.array(Question.Prompt.zod).describe("Questions to ask"),
})

type Metadata = {
  answers: ReadonlyArray<Question.Answer>
}

// Required field set per question item, mirrors Question.Prompt schema
// (src/question/index.ts -> base). Keep in sync if schema changes.
const REQUIRED_FIELDS = ["question", "header", "options"] as const

const EXAMPLE_CALL = `{
  "questions": [
    {
      "question": "Which deployment target should we use?",
      "header": "Deploy target",
      "options": [
        { "label": "Vercel (Recommended)", "description": "Edge runtime, zero-config" },
        { "label": "Cloudflare Pages", "description": "Workers + KV integration" }
      ],
      "multiple": false
    }
  ]
}`

const FIELD_SPEC = `Required fields per question item:
  - question (string)  Complete question text the user will read. NEVER omit.
  - header   (string)  Very short label, max 30 chars. NOT a substitute for "question".
  - options  (array)   Each option needs { label: string, description: string }.
Optional:
  - multiple (boolean) Allow selecting multiple choices. Default false.
  - custom   (boolean) Allow typing a custom answer. Default true (auto adds "Type your own answer").

Common mistake: putting the question text into "header" and leaving "question" undefined.
"header" is a tab/badge label only; "question" is the full sentence.`

function formatQuestionValidationError(error: z.ZodError): string {
  const lines: string[] = []
  lines.push(`The "question" tool was called with invalid arguments.`)
  lines.push("")
  lines.push("Issues:")
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "<root>"
    const anyIssue = issue as { expected?: unknown; received?: unknown }
    const expected = anyIssue.expected !== undefined ? ` expected=${String(anyIssue.expected)}` : ""
    const received = anyIssue.received !== undefined ? ` received=${String(anyIssue.received)}` : ""
    lines.push(`  - path: ${path} | code: ${issue.code}${expected}${received}`)
    lines.push(`    ${issue.message}`)

    // Hint when an issue touches a required top-level field
    const last = issue.path[issue.path.length - 1]
    if (typeof last === "string" && (REQUIRED_FIELDS as readonly string[]).includes(last)) {
      lines.push(`    Hint: "${last}" is REQUIRED. Do not omit it; do not merge it into another field.`)
    }
  }
  lines.push("")
  lines.push(FIELD_SPEC)
  lines.push("")
  lines.push("Correct call example:")
  lines.push(EXAMPLE_CALL)
  lines.push("")
  lines.push("Please re-issue the tool call with all required fields populated.")
  return lines.join("\n")
}

export const QuestionTool = Tool.define<typeof parameters, Metadata, Question.Service>(
  "question",
  Effect.gen(function* () {
    const question = yield* Question.Service

    return {
      description: DESCRIPTION,
      parameters,
      formatValidationError: formatQuestionValidationError,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: params.questions,
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          const formatted = params.questions
            .map((q, i) => `"${q.question}"="${answers[i]?.length ? answers[i].join(", ") : "Unanswered"}"`)
            .join(", ")

          return {
            title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
            output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
            metadata: {
              answers,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
