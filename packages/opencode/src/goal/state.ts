export * as GoalState from "./state"

import { Effect, Schema } from "effect"
import { NonNegativeInt } from "@opencode-ai/schema/schema"

export const Status = Schema.Literals(["active", "paused", "done", "cleared"])
export type Status = Schema.Schema.Type<typeof Status>

export const Verdict = Schema.Literals(["done", "continue", "skipped"])
export type Verdict = Schema.Schema.Type<typeof Verdict>

export class Info extends Schema.Class<Info>("GoalState")({
  goal: Schema.String,
  status: Status,
  turns_used: NonNegativeInt,
  max_turns: NonNegativeInt,
  created_at: Schema.Number,
  last_turn_at: Schema.Number,
  last_verdict: Schema.optional(Verdict),
  last_reason: Schema.optional(Schema.String),
  paused_reason: Schema.optional(Schema.String),
  consecutive_parse_failures: NonNegativeInt,
  subgoals: Schema.Array(Schema.String).pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed([] as ReadonlyArray<string>))),
}) {}
