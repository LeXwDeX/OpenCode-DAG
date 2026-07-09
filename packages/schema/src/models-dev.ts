export * as ModelsDev from "./models-dev"

import { Schema } from "effect"
import { define, inventory } from "./event"

const Refreshed = define({
  type: "models-dev.refreshed",
  schema: {},
})

const FetchFailed = define({
  type: "models-dev.fetch_failed",
  schema: {
    source: Schema.String,
  },
})

export const Event = { Refreshed, FetchFailed, Definitions: inventory(Refreshed, FetchFailed) }
