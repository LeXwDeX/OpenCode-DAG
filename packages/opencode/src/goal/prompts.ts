export * as GoalPrompts from "./prompts"

export const DEFAULT_MAX_TURNS = 20
export const DEFAULT_JUDGE_TIMEOUT = 30_000
export const MAX_CONSECUTIVE_PARSE_FAILURES = 3
export const JUDGE_RESPONSE_SNIPPET_CHARS = 4000

export const CONTINUATION_PROMPT_TEMPLATE = `[Continuing toward your standing goal]
Goal: {goal}

You are in autonomous mode — interactive questions are disabled and will not receive answers. Do not ask the user for clarification or confirmation. Make all decisions independently based on your best judgment.

Continue working toward this goal. Take the next concrete step.
If you believe the goal is complete, state so explicitly and stop.
If you are completely blocked and cannot make any progress, state the blocker explicitly and stop.`

export const CONTINUATION_PROMPT_WITH_SUBGOALS_TEMPLATE = `[Continuing toward your standing goal]
Goal: {goal}

Additional criteria the user added mid-loop:
{subgoals}

You are in autonomous mode — interactive questions are disabled and will not receive answers. Do not ask the user for clarification or confirmation. Make all decisions independently based on your best judgment.

Continue working toward this goal. Take the next concrete step.
If you believe the goal is complete, state so explicitly and stop.
If you are completely blocked and cannot make any progress, state the blocker explicitly and stop.`

export const JUDGE_SYSTEM_PROMPT = `You are an autonomous-goal completion judge.
You will receive:
1. The user's original goal.
2. The agent's most recent response.

Return ONLY a JSON object (no markdown, no explanation):
{"done": true/false, "reason": "one sentence explanation"}

"done" = true means ONE of:
  - The agent explicitly confirmed the goal is complete with evidence.
  - The goal produced a clear, verifiable deliverable (file created, test passed, etc.).
  - The goal is unachievable or blocked and the agent said so.

"done" = false means the agent is still making progress or has more steps.

Be conservative: if in doubt, return "done": false.`

export const JUDGE_USER_PROMPT_TEMPLATE = `Goal: {goal}

Agent's most recent response (last {snippetChars} chars):
---
{response}
---

Is the goal done?`

export const JUDGE_USER_PROMPT_WITH_SUBGOALS_TEMPLATE = `Goal: {goal}

Additional criteria:
{subgoals}

Agent's most recent response (last {snippetChars} chars):
---
{response}
---

Is the goal done? For each sub-goal, provide concrete evidence it was met. Do not accept vague claims like "all requirements met".`

export function renderContinuation(goal: string, subgoals: ReadonlyArray<string>): string {
  if (subgoals.length === 0)
    return CONTINUATION_PROMPT_TEMPLATE.replace("{goal}", goal)
  return CONTINUATION_PROMPT_WITH_SUBGOALS_TEMPLATE
    .replace("{goal}", goal)
    .replace("{subgoals}", subgoals.map((s, i) => `${i + 1}. ${s}`).join("\n"))
}

export function renderJudgeUserPrompt(
  goal: string,
  response: string,
  subgoals: ReadonlyArray<string>,
): string {
  const snippet = response.slice(-JUDGE_RESPONSE_SNIPPET_CHARS)
  if (subgoals.length === 0)
    return JUDGE_USER_PROMPT_TEMPLATE
      .replace("{goal}", goal)
      .replace("{snippetChars}", String(JUDGE_RESPONSE_SNIPPET_CHARS))
      .replace("{response}", snippet)
  return JUDGE_USER_PROMPT_WITH_SUBGOALS_TEMPLATE
    .replace("{goal}", goal)
    .replace("{subgoals}", subgoals.map((s, i) => `${i + 1}. ${s}`).join("\n"))
    .replace("{snippetChars}", String(JUDGE_RESPONSE_SNIPPET_CHARS))
    .replace("{response}", snippet)
}
