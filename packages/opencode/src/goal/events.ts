export * as GoalEvent from "./events"

import { Schema } from "effect"
import { Event } from "@opencode-ai/schema/event"
import { SessionID } from "@opencode-ai/schema/session-id"

export const Set = Event.define({
  type: "goal.set",
  schema: {
    sessionID: SessionID,
    goal: Schema.String,
    maxTurns: Schema.Number,
  },
})

export const Updated = Event.define({
  type: "goal.updated",
  schema: {
    sessionID: SessionID,
    goal: Schema.String,
    status: Schema.String,
    turnsUsed: Schema.Number,
    maxTurns: Schema.Number,
  },
})

export const Continued = Event.define({
  type: "goal.continued",
  schema: {
    sessionID: SessionID,
    turnsUsed: Schema.Number,
    maxTurns: Schema.Number,
    reason: Schema.String,
  },
})

export const Achieved = Event.define({
  type: "goal.achieved",
  schema: {
    sessionID: SessionID,
    reason: Schema.String,
  },
})

export const Paused = Event.define({
  type: "goal.paused",
  schema: {
    sessionID: SessionID,
    reason: Schema.String,
  },
})

export const Cleared = Event.define({
  type: "goal.cleared",
  schema: {
    sessionID: SessionID,
  },
})

export const Inventory = Event.inventory(Set, Updated, Continued, Achieved, Paused, Cleared)
