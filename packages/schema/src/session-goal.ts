export * as SessionGoal from "./session-goal"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { SessionID } from "./session-id"

export const GoalStatus = Schema.Literals(["active", "paused", "done"])

export const Info = Schema.Struct({
  goal: Schema.String.annotate({ description: "The autonomous goal text" }),
  status: GoalStatus.annotate({ description: "Current status: active, paused, achieved" }),
  turnsUsed: Schema.Number.annotate({ description: "Turns used so far" }),
  maxTurns: Schema.Number.annotate({ description: "Maximum turns allowed" }),
}).annotate({ identifier: "Goal" })
export type Info = typeof Info.Type
export const SessionGoalInfo = Info

const Updated = define({
  type: "goal.updated",
  schema: {
    sessionID: SessionID,
    goal: Info,
  },
})

const Cleared = define({
  type: "goal.cleared",
  schema: {
    sessionID: SessionID,
  },
})

export const Event = { Updated, Cleared, Definitions: inventory(Updated, Cleared) }
