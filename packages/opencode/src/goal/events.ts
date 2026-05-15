export * as GoalEvent from "./events"

import { Schema } from "effect"
import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"

export const Event = {
  Set: BusEvent.define(
    "goal.set",
    Schema.Struct({
      sessionID: SessionID,
      goal: Schema.String,
      maxTurns: Schema.Number,
    }),
  ),
  Updated: BusEvent.define(
    "goal.updated",
    Schema.Struct({
      sessionID: SessionID,
      goal: Schema.String,
      status: Schema.String,
      turnsUsed: Schema.Number,
      maxTurns: Schema.Number,
    }),
  ),
  Continued: BusEvent.define(
    "goal.continued",
    Schema.Struct({
      sessionID: SessionID,
      turnsUsed: Schema.Number,
      maxTurns: Schema.Number,
      reason: Schema.String,
    }),
  ),
  Achieved: BusEvent.define(
    "goal.achieved",
    Schema.Struct({
      sessionID: SessionID,
      reason: Schema.String,
    }),
  ),
  Paused: BusEvent.define(
    "goal.paused",
    Schema.Struct({
      sessionID: SessionID,
      reason: Schema.String,
    }),
  ),
  Cleared: BusEvent.define(
    "goal.cleared",
    Schema.Struct({
      sessionID: SessionID,
    }),
  ),
}
