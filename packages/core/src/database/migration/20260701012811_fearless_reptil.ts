import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260701012811_fearless_reptil",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`goal_state\` (
          \`session_id\` text PRIMARY KEY,
          \`payload\` text NOT NULL,
          \`updated_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`goal_state_updated_at_idx\` ON \`goal_state\` (\`updated_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
