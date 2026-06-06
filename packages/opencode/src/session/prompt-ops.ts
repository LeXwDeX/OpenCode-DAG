import { Effect } from "effect"
import type { SessionPrompt } from "@/session/prompt"
import type { SessionID } from "@/session/schema"
import type { MessageV2 } from "@/session/message-v2"

export interface PromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
  loop(input: SessionPrompt.LoopInput): Effect.Effect<MessageV2.WithParts>
}
