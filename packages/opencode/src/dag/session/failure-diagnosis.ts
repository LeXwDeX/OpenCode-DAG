// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * WP-E1: Failure Diagnosis & Auto-Recovery Module
 *
 * Provides the diagnosis agent invocation logic. Pure-ish module:
 * delegates DB reads to the session service, spawns a child session to
 * run the diagnosis agent, and returns the structured decision.
 *
 * Called by `handleNodeFailure` in workflow-engine.ts when
 * `config.failure_handler?.enabled === true`.
 *
 * The diagnosis agent receives a prompt containing the failure context
 * and must return its decision by writing JSON to a known temp file.
 * If the file is not written within `diagnosis_timeout_ms`, falls back
 * to cascade.
 */

import { Effect, Result } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import type { PromptOps } from "@/session/prompt-ops"
import { MessageID, type SessionID } from "@/session/schema"
import type { Agent } from "@/agent/agent"
import type {
  FailureHandlerConfig,
  FailureDiagnosisInput,
  DiagnosisDecision,
} from "./types"

const log = Log.create({ service: "dag.failure-diagnosis" })

const DEFAULT_DIAGNOSIS_TIMEOUT_MS = 120_000

/**
 * Build the diagnosis prompt from the failure context.
 *
 * Pure function — no side effects.
 */
export function buildDiagnosisPrompt(input: FailureDiagnosisInput): string {
  return [
    `# DAG Node Failure Diagnosis`,
    ``,
    `You are the DAG failure diagnosis agent. A node in a workflow has failed.`,
    `Your job is to analyze what happened and decide how to proceed.`,
    ``,
    `## Failure Context`,
    ``,
    `- **Workflow ID**: \`${input.workflowId}\``,
    `- **Node ID**: \`${input.nodeId}\``,
    `- **Error**: ${input.error}`,
    `- **Is Timeout**: ${input.isTimeout ? "YES" : "NO"}`,
    `- **Node Type**: \`${input.nodeConfig.worker_type}\``,
    `- **Node Name**: ${input.nodeConfig.name}`,
    `- **Attempt**: ${input.recoveryAttemptsForNode + 1} (of max_recoveries=${input.totalRecoveriesAttempted})`,
    ``,
    `## Workflow Progress`,
    `- Completed: ${input.workflowProgress.completed} / ${input.workflowProgress.total}`,
    `- Failed: ${input.workflowProgress.failed}`,
    ``,
    `## Recent Node Logs (newest first)`,
    "```",
    ...input.nodeLogs.map((l) => `[${new Date(l.created_at).toISOString()}] [${l.log_level}] ${l.log_message}`),
    "```",
    ``,
    `## Your Task`,
    ``,
    `1. Analyze the error message and logs.`,
    `2. Determine the root cause:`,
    `   - **Timeout too short or work still running**: Agent may need more time; timeout alone does not prove task failure.`,
    `   - **Task too large for timeout**: Agent needed more time, prompt was reasonable.`,
    `   - **Plan issue**: Task was mis-scoped (e.g., asked to translate 5000 lines in 15min).`,
    `   - **Transient error**: Network blip, API rate limit — retry likely works.`,
    `   - **Hard failure**: Task is genuinely impossible with current config (e.g., missing dependency).`,
    `3. Write exactly one JSON decision file at the path provided in the Decision Output section. Do not call a diagnosis tool.`,
    ``,
    `### Decision Options`,
    `- \`"retry"\` — Reset node to pending and re-execute. Set \`new_timeout_ms\` if timeout was the issue.`,
    `- \`"replan"\` — Apply a patch to restructure the workflow tail (add/remove/update nodes).`,
    `- \`"skip"\` — Abandon recovery and let the engine use normal failed+cascade behavior; it will not mark the failed/running node skipped.`,
    `- \`"cascade"\` — Accept failure, let normal cascade logic run.`,
    ``,
    `### Guidance`,
    `- If this is the 1st or 2nd attempt AND the error is a timeout, treat it as possibly too-short timeout or still-running work and **prefer "retry" with higher timeout**.`,
    `- If attempt count is high (≥ 3) for same node, prefer "replan" or "cascade".`,
    `- If task is clearly oversized, prefer "replan" to split it into smaller subtasks.`,
    `- If dependency is missing or task is impossible, prefer "cascade".`,
    ``,
  ].join("\n")
}

/**
 * Run the diagnosis agent and collect its decision.
 *
 * Pure-ish: caller resolves Agent and Session services beforehand and passes
 * the agent info + diagnosis session ID as parameters. This keeps the Effect
 * requirements at `never` (compatible with WorkflowEngine.handleNodeFailure's signature).
 *
 * Returns the decision or a fallback "cascade" on any error.
 */
export function runDiagnosisAgent(args: {
  workflowId: string
  chatSessionId: string
  input: FailureDiagnosisInput
  handler: FailureHandlerConfig
  promptOps: PromptOps
  agent: Agent.Info
  diagnosisSessionId: SessionID
  workflowProgress: { completed: number; failed: number; total: number }
}): Effect.Effect<DiagnosisDecision, never, never> {
  const decisionFile = `/tmp/dag-diagnosis-${args.workflowId}-${Date.now()}.json`

  return Effect.gen(function* () {
    const { input, handler, promptOps, agent, diagnosisSessionId } = args
    const timeoutMs = handler.diagnosis_timeout_ms ?? DEFAULT_DIAGNOSIS_TIMEOUT_MS

    // 1. Build prompt
    const prompt = buildDiagnosisPrompt(input)
    const fullPrompt =
      prompt +
      `\n\n## Decision Output\nWrite your decision as JSON to: ${decisionFile}\n` +
      `Format: { "action": "retry"|"replan"|"skip"|"cascade", "reason": "...", ... }\n` +
      `If diagnosis times out or no valid file is produced, the engine cascades the original failure.`

    // 2. Call promptOps with timeout
    const parts = yield* promptOps.resolvePromptParts(fullPrompt)
    const result = yield* promptOps
      .prompt({
        sessionID: diagnosisSessionId,
        messageID: MessageID.ascending(),
        agent: agent.name,
        parts,
      })
      .pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.fail(new Error(`diagnosis timeout after ${timeoutMs}ms`)),
        }),
        Effect.result,
      )

    if (Result.isFailure(result)) {
      const failure = Result.getFailure(result)
      const reason = failure._tag === "Some" ? String(failure.value) : "unknown error"
      return { action: "cascade", reason: `diagnosis failed: ${reason}` } as DiagnosisDecision
    }

    // 3. Read decision from file
    const fsMod = yield* Effect.promise(() => import("fs/promises"))
    try {
      const content = yield* Effect.promise(() => fsMod.readFile(decisionFile, "utf-8"))
      let parsed: unknown
      try {
        parsed = JSON.parse(content)
      } catch {
        log.warn(`Invalid JSON in diagnosis file ${decisionFile}`)
        return { action: "cascade", reason: "diagnosis agent returned invalid JSON" } as DiagnosisDecision
      }
      if (isValidDecision(parsed, args.workflowId)) {
        return parsed
      }
      log.warn(`Invalid decision shape from ${decisionFile}: ${JSON.stringify(parsed).slice(0, 200)}`)
      return { action: "cascade", reason: "diagnosis agent returned invalid decision shape" } as DiagnosisDecision
    } catch (e) {
      log.warn(`Could not read diagnosis file ${decisionFile}: ${String(e)}`)
      return { action: "cascade", reason: "diagnosis agent ran but did not produce decision file" } as DiagnosisDecision
    }
  }).pipe(
    // Best-effort cleanup of the decision file.
    Effect.ensuring(cleanupDecisionFile(decisionFile)),
    // Catch any uncaught Effect failure — return safe cascade.
    Effect.catchCause((cause) =>
      Effect.succeed({ action: "cascade", reason: `diagnosis crashed: ${String(cause)}` } as DiagnosisDecision),
    ),
  )
}

function cleanupDecisionFile(decisionFile: string): Effect.Effect<void, never, never> {
  return Effect.promise(() => import("fs/promises").then((fs) => fs.unlink(decisionFile).catch(() => {}))).pipe(
    Effect.catchCause(() => Effect.void),
    Effect.ignore,
  )
}

function isValidDecision(d: unknown, workflowId: string): d is DiagnosisDecision {
  if (typeof d !== "object" || d === null) return false
  const obj = d as Record<string, unknown>
  if (typeof obj.action !== "string") return false
  if (!["retry", "replan", "skip", "cascade"].includes(obj.action)) return false
  if (typeof obj.reason !== "string") return false
  if (obj.action === "retry") return isValidRetryDecision(obj)
  if (obj.action === "replan") return isValidReplanDecision(obj, workflowId)
  return true
}

function isValidRetryDecision(obj: Record<string, unknown>): boolean {
  if (obj.new_timeout_ms === undefined) return true
  return typeof obj.new_timeout_ms === "number" && Number.isFinite(obj.new_timeout_ms) && obj.new_timeout_ms > 0
}

function isValidReplanDecision(obj: Record<string, unknown>, workflowId: string): boolean {
  if (!isRecord(obj.patch)) return false
  if (typeof obj.patch.workflow_id !== "string") return false
  if (obj.patch.workflow_id !== workflowId) return false
  if (obj.patch.add_nodes !== undefined && !Array.isArray(obj.patch.add_nodes)) return false
  if (obj.patch.remove_nodes !== undefined && !isStringArray(obj.patch.remove_nodes)) return false
  if (obj.patch.update_nodes !== undefined && !Array.isArray(obj.patch.update_nodes)) return false
  if (obj.patch.new_max_concurrency !== undefined) {
    if (typeof obj.patch.new_max_concurrency !== "number") return false
    if (!Number.isFinite(obj.patch.new_max_concurrency) || obj.patch.new_max_concurrency <= 0) return false
  }
  if (obj.patch.changed_by !== undefined && typeof obj.patch.changed_by !== "string") return false
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}
