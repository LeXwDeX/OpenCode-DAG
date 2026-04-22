import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"

export const Parameters = Schema.Struct({
  questions: Schema.mutable(Schema.Array(Question.Prompt)).annotate({ description: "Questions to ask" }),
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

/**
 * Format validation errors from Effect Schema decode failures into a
 * human-readable message that guides the LLM to re-issue the tool call
 * correctly. Accepts `unknown` to match the tool.ts formatValidationError
 * signature; internally extracts structured issue info when available.
 */
function formatQuestionValidationError(error: unknown): string {
  const lines: string[] = []
  lines.push(`The "question" tool was called with invalid arguments.`)
  lines.push("")
  lines.push("Issues:")

  // Effect Schema ParseError exposes .issues or similar structured info;
  // fall back to string representation for any other error shape.
  const issues = extractIssues(error)
  for (const issue of issues) {
    lines.push(`  - path: ${issue.path} | code: ${issue.code}`)
    lines.push(`    ${issue.message}`)

    const last = issue.pathSegments[issue.pathSegments.length - 1]
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

interface ParsedIssue {
  path: string
  pathSegments: (string | number)[]
  code: string
  message: string
}

/** Best-effort extraction of structured issues from various error shapes. */
function extractIssues(error: unknown): ParsedIssue[] {
  // Effect Schema ParseError: toString gives readable output, but we try to
  // extract structured info from the error message for path-level hints.
  const errorStr = String(error)

  // Match lines like: `path: questions.0.question | ...` from Effect Schema
  // or fall back to splitting the full error string into pseudo-issues.
  const pathRegex = /(?:is missing|expected .+?, actual .+?).*?at path[:\s]+"?([^"\n]+)"?/gi
  const found: ParsedIssue[] = []

  // Try to parse Effect Schema error tree by splitting on known patterns
  const lines = errorStr.split("\n").filter((l) => l.trim())
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("└") || trimmed.startsWith("├")) {
      // Effect Schema tree format — extract path-like segments
      const pathMatch = trimmed.match(/\/"([^"]+)"/)
      const msgMatch = trimmed.match(/is missing|expected .+|did not satisfy/)
      if (pathMatch || msgMatch) {
        const segments = pathMatch ? pathMatch[1].split(".") : []
        found.push({
          path: segments.join(".") || "<root>",
          pathSegments: segments.map((s) => (/^\d+$/.test(s) ? parseInt(s) : s)),
          code: trimmed.includes("missing") ? "invalid_type" : "validation",
          message: trimmed.replace(/^[├└─│\s]+/, ""),
        })
      }
    }
  }

  if (found.length > 0) return found

  // Fallback: single issue from the whole error string
  return [
    {
      path: "<root>",
      pathSegments: [],
      code: "parse_error",
      message: errorStr.slice(0, 500),
    },
  ]
}

export const QuestionTool = Tool.define<typeof Parameters, Metadata, Question.Service>(
  "question",
  Effect.gen(function* () {
    const question = yield* Question.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      formatValidationError: formatQuestionValidationError,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
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
