// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "bun:test"
import { randomUUID } from "crypto"
import { Effect } from "effect"
import { buildDiagnosisPrompt, runDiagnosisAgent } from "../failure-diagnosis"
import { validateFailureHandler } from "../limits"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "@/session/message-v2"
import type { PromptOps } from "@/session/prompt-ops"
import { SessionID } from "@/session/schema"
import type { FailureDiagnosisInput, FailureHandlerConfig } from "../types"

describe("WP-E1: validateFailureHandler", () => {
  it("undefined config is OK (default: no handler)", () => {
    expect(validateFailureHandler(undefined).ok).toBe(true)
  })
  it("null config is OK", () => {
    expect(validateFailureHandler(null).ok).toBe(true)
  })
  it("enabled=false skips further checks", () => {
    expect(validateFailureHandler({ enabled: false }).ok).toBe(true)
  })
  it("enabled=false with garbage fields still passes (skips further checks)", () => {
    expect(validateFailureHandler({ enabled: false, agent: "", max_recoveries: -1 }).ok).toBe(true)
  })
  it("enabled=true with valid config passes", () => {
    const cfg: FailureHandlerConfig = {
      enabled: true,
      agent: "general",
      diagnosis_timeout_ms: 60000,
      on_diagnosis_timeout: "cascade",
      max_recoveries: 3,
    }
    const r = validateFailureHandler(cfg)
    expect(r.ok).toBe(true)
  })
  it("enabled=true minimal config passes", () => {
    expect(validateFailureHandler({ enabled: true }).ok).toBe(true)
  })
  it("rejects non-object (string)", () => {
    const r = validateFailureHandler("string")
    expect(r.ok).toBe(false)
  })
  it("rejects non-object (number)", () => {
    const r = validateFailureHandler(42)
    expect(r.ok).toBe(false)
  })
  it("rejects array", () => {
    const r = validateFailureHandler([{ enabled: true }])
    expect(r.ok).toBe(false)
  })
  it("rejects enabled without boolean (string 'yes')", () => {
    const r = validateFailureHandler({ enabled: "yes" })
    expect(r.ok).toBe(false)
  })
  it("rejects enabled without boolean (undefined)", () => {
    const r = validateFailureHandler({})
    expect(r.ok).toBe(false)
  })
  it("rejects empty agent string", () => {
    const r = validateFailureHandler({ enabled: true, agent: "" })
    expect(r.ok).toBe(false)
  })
  it("rejects non-string agent", () => {
    const r = validateFailureHandler({ enabled: true, agent: 123 })
    expect(r.ok).toBe(false)
  })
  it("accepts valid agent string", () => {
    const r = validateFailureHandler({ enabled: true, agent: "plan" })
    expect(r.ok).toBe(true)
  })
  it("rejects diagnosis_timeout_ms < 5000", () => {
    const r = validateFailureHandler({ enabled: true, diagnosis_timeout_ms: 1000 })
    expect(r.ok).toBe(false)
  })
  it("rejects diagnosis_timeout_ms = 0", () => {
    const r = validateFailureHandler({ enabled: true, diagnosis_timeout_ms: 0 })
    expect(r.ok).toBe(false)
  })
  it("accepts diagnosis_timeout_ms = 5000", () => {
    const r = validateFailureHandler({ enabled: true, diagnosis_timeout_ms: 5000 })
    expect(r.ok).toBe(true)
  })
  it("rejects non-finite diagnosis_timeout_ms", () => {
    const r = validateFailureHandler({ enabled: true, diagnosis_timeout_ms: Infinity })
    expect(r.ok).toBe(false)
  })
  it("rejects string diagnosis_timeout_ms", () => {
    const r = validateFailureHandler({ enabled: true, diagnosis_timeout_ms: "120000" })
    expect(r.ok).toBe(false)
  })
  it("rejects max_recoveries > 10", () => {
    const r = validateFailureHandler({ enabled: true, max_recoveries: 99 })
    expect(r.ok).toBe(false)
  })
  it("rejects max_recoveries < 0", () => {
    const r = validateFailureHandler({ enabled: true, max_recoveries: -1 })
    expect(r.ok).toBe(false)
  })
  it("rejects non-integer max_recoveries", () => {
    const r = validateFailureHandler({ enabled: true, max_recoveries: 1.5 })
    expect(r.ok).toBe(false)
  })
  it("accepts max_recoveries = 0", () => {
    const r = validateFailureHandler({ enabled: true, max_recoveries: 0 })
    expect(r.ok).toBe(true)
  })
  it("accepts max_recoveries = 10", () => {
    const r = validateFailureHandler({ enabled: true, max_recoveries: 10 })
    expect(r.ok).toBe(true)
  })
  it("rejects invalid on_diagnosis_timeout", () => {
    const r = validateFailureHandler({ enabled: true, on_diagnosis_timeout: "retry" as any })
    expect(r.ok).toBe(false)
  })
  it("accepts on_diagnosis_timeout = cascade", () => {
    const r = validateFailureHandler({ enabled: true, on_diagnosis_timeout: "cascade" })
    expect(r.ok).toBe(true)
  })
  it("rejects on_diagnosis_timeout = skip", () => {
    const r = validateFailureHandler({ enabled: true, on_diagnosis_timeout: "skip" })
    expect(r.ok).toBe(false)
  })
})

describe("WP-E1: buildDiagnosisPrompt", () => {
  const makeInput = (overrides: Partial<FailureDiagnosisInput> = {}): FailureDiagnosisInput => ({
    workflowId: "wf-123",
    nodeId: "wf-123::node-1",
    error: "node timed out after 300000ms",
    isTimeout: true,
    nodeConfig: {
      id: "node-1",
      name: "Test Node",
      dependencies: [],
      required: true,
      worker_type: "implement",
      worker_config: { prompt: "do stuff" },
    },
    nodeLogs: [
      { log_message: "Prompt started", log_level: "info", created_at: 1700000000000 },
      { log_message: "Node failed: timeout", log_level: "error", created_at: 1700000300000 },
    ],
    workflowProgress: { completed: 3, failed: 1, total: 10 },
    recoveryAttemptsForNode: 0,
    totalRecoveriesAttempted: 0,
    ...overrides,
  })

  it("includes workflow and node IDs", () => {
    const prompt = buildDiagnosisPrompt(makeInput())
    expect(prompt).toContain("wf-123")
    expect(prompt).toContain("wf-123::node-1")
  })
  it("includes error message", () => {
    const prompt = buildDiagnosisPrompt(makeInput())
    expect(prompt).toContain("node timed out after 300000ms")
  })
  it("includes timeout indicator", () => {
    const prompt = buildDiagnosisPrompt(makeInput({ isTimeout: true }))
    expect(prompt).toContain("Is Timeout**: YES")
    const prompt2 = buildDiagnosisPrompt(makeInput({ isTimeout: false }))
    expect(prompt2).toContain("Is Timeout**: NO")
  })
  it("includes workflow progress", () => {
    const prompt = buildDiagnosisPrompt(makeInput())
    expect(prompt).toContain("Workflow Progress")
    expect(prompt).toContain("Completed: 3")
    expect(prompt).toContain("Failed: 1")
    expect(prompt).toContain("10")
  })
  it("includes node logs", () => {
    const prompt = buildDiagnosisPrompt(makeInput())
    expect(prompt).toContain("Prompt started")
    expect(prompt).toContain("Node failed: timeout")
    expect(prompt).toContain("info")
    expect(prompt).toContain("error")
  })
  it("includes decision guidance", () => {
    const prompt = buildDiagnosisPrompt(makeInput())
    expect(prompt).not.toContain("dag_diagnose")
    expect(prompt).toContain("JSON decision file")
    expect(prompt).toContain("retry")
    expect(prompt).toContain("replan")
    expect(prompt).toContain("skip")
    expect(prompt).toContain("cascade")
  })
  it("describes timeout as possibly too-short timeout or still-running work", () => {
    const prompt = buildDiagnosisPrompt(makeInput())
    expect(prompt).toContain("too-short timeout or still-running work")
    expect(prompt).toContain("timeout alone does not prove task failure")
  })
  it("includes worker_type and node name", () => {
    const prompt = buildDiagnosisPrompt(makeInput())
    expect(prompt).toContain("implement")
    expect(prompt).toContain("Test Node")
  })
  it("handles empty logs gracefully", () => {
    const prompt = buildDiagnosisPrompt(makeInput({ nodeLogs: [] }))
    expect(prompt).toContain("Recent Node Logs")
    expect(prompt).toContain("```")
  })
})

describe("WP-E1: runDiagnosisAgent timeout boundary", () => {
  const makeInput = (): FailureDiagnosisInput => ({
    workflowId: "wf-timeout",
    nodeId: "wf-timeout::A",
    error: "node timed out after 5000ms",
    isTimeout: true,
    nodeConfig: {
      id: "A",
      name: "Node A",
      dependencies: [],
      required: true,
      worker_type: "implement",
      worker_config: { prompt: "do work" },
    },
    nodeLogs: [],
    workflowProgress: { completed: 0, failed: 1, total: 1 },
    recoveryAttemptsForNode: 0,
    totalRecoveriesAttempted: 0,
  })

  it("cascades immediately after diagnosis prompt timeout without accepting late decision output", async () => {
    const promptResult = { info: { role: "assistant" }, parts: [] } as unknown as MessageV2.WithParts
    const promptOps: PromptOps = {
      cancel: () => Effect.void,
      resolvePromptParts: (template) => Effect.succeed([{ type: "text", text: template }]),
      prompt: (input) =>
        Effect.gen(function* () {
          const text = input.parts.find((part) => part.type === "text")?.text ?? ""
          const decisionFile = text.match(/Write your decision as JSON to: (\/tmp\/dag-diagnosis-[^\n]+\.json)/)?.[1]
          if (decisionFile) {
            const fs = yield* Effect.promise(() => import("fs/promises"))
            yield* Effect.promise(() => fs.writeFile(decisionFile, JSON.stringify({ action: "retry", reason: "late" })))
          }
          return yield* Effect.promise(() => new Promise<MessageV2.WithParts>((resolve) => setTimeout(() => resolve(promptResult), 40)))
        }),
      loop: () => Effect.succeed(promptResult),
    }

    const decision = await Effect.runPromise(
      runDiagnosisAgent({
        workflowId: "wf-timeout",
        chatSessionId: "chat-1",
        input: makeInput(),
        handler: { enabled: true, diagnosis_timeout_ms: 1 },
        promptOps,
        agent: { name: "general" } as Agent.Info,
        diagnosisSessionId: SessionID.make("ses_diag_1"),
        workflowProgress: { completed: 0, failed: 1, total: 1 },
      }),
    )

    expect(decision.action).toBe("cascade")
    expect(decision.reason).toContain("diagnosis failed")
  })

  it("cleans up only its own diagnosis decision file", async () => {
    const fs = await import("fs/promises")
    const unrelatedFile = `/tmp/dag-diagnosis-unrelated-${randomUUID()}.json`
    const promptResult = { info: { role: "assistant" }, parts: [] } as unknown as MessageV2.WithParts

    await fs.writeFile(unrelatedFile, JSON.stringify({ action: "retry", reason: "other run" }))

    const promptOps: PromptOps = {
      cancel: () => Effect.void,
      resolvePromptParts: (template) => Effect.succeed([{ type: "text", text: template }]),
      prompt: (input) =>
        Effect.gen(function* () {
          const text = input.parts.find((part) => part.type === "text")?.text ?? ""
          const decisionFile = text.match(/Write your decision as JSON to: (\/tmp\/dag-diagnosis-[^\n]+\.json)/)?.[1]
          if (decisionFile) {
            const fs = yield* Effect.promise(() => import("fs/promises"))
            yield* Effect.promise(() => fs.writeFile(decisionFile, JSON.stringify({ action: "cascade", reason: "done" })))
          }
          return promptResult
        }),
      loop: () => Effect.succeed(promptResult),
    }

    const decision = await Effect.runPromise(
      runDiagnosisAgent({
        workflowId: "wf-cleanup",
        chatSessionId: "chat-1",
        input: makeInput(),
        handler: { enabled: true, diagnosis_timeout_ms: 5000 },
        promptOps,
        agent: { name: "general" } as Agent.Info,
        diagnosisSessionId: SessionID.make("ses_diag_cleanup"),
        workflowProgress: { completed: 0, failed: 1, total: 1 },
      }),
    )

    expect(decision.action).toBe("cascade")
    expect(await fs.readFile(unrelatedFile, "utf-8")).toContain("other run")
    await fs.unlink(unrelatedFile).catch(() => {})
  })

  it("cascades invalid retry action payload instead of accepting malformed timeout", async () => {
    const decision = await Effect.runPromise(
      runDiagnosisAgent({
        workflowId: "wf-invalid-retry",
        chatSessionId: "chat-1",
        input: makeInput(),
        handler: { enabled: true, diagnosis_timeout_ms: 5000 },
        promptOps: makeDecisionPromptOps({ action: "retry", reason: "bad timeout", new_timeout_ms: "120000" }),
        agent: { name: "general" } as Agent.Info,
        diagnosisSessionId: SessionID.make("ses_diag_invalid_retry"),
        workflowProgress: { completed: 0, failed: 1, total: 1 },
      }),
    )

    expect(decision.action).toBe("cascade")
    expect(decision.reason).toContain("invalid decision shape")
  })

  it("cascades invalid replan action payload instead of accepting missing patch", async () => {
    const decision = await Effect.runPromise(
      runDiagnosisAgent({
        workflowId: "wf-invalid-replan",
        chatSessionId: "chat-1",
        input: makeInput(),
        handler: { enabled: true, diagnosis_timeout_ms: 5000 },
        promptOps: makeDecisionPromptOps({ action: "replan", reason: "missing patch" }),
        agent: { name: "general" } as Agent.Info,
        diagnosisSessionId: SessionID.make("ses_diag_invalid_replan"),
        workflowProgress: { completed: 0, failed: 1, total: 1 },
      }),
    )

    expect(decision.action).toBe("cascade")
    expect(decision.reason).toContain("invalid decision shape")
  })

  it("cascades replan decisions targeting a different workflow", async () => {
    const decision = await Effect.runPromise(
      runDiagnosisAgent({
        workflowId: "wf-current",
        chatSessionId: "chat-1",
        input: makeInput(),
        handler: { enabled: true, diagnosis_timeout_ms: 5000 },
        promptOps: makeDecisionPromptOps({
          action: "replan",
          reason: "wrong workflow",
          patch: { workflow_id: "wf-other", remove_nodes: [] },
        }),
        agent: { name: "general" } as Agent.Info,
        diagnosisSessionId: SessionID.make("ses_diag_replan_mismatch"),
        workflowProgress: { completed: 0, failed: 1, total: 1 },
      }),
    )

    expect(decision.action).toBe("cascade")
    expect(decision.reason).toContain("invalid decision shape")
  })

  it("accepts replan decisions targeting the current workflow", async () => {
    const decision = await Effect.runPromise(
      runDiagnosisAgent({
        workflowId: "wf-current",
        chatSessionId: "chat-1",
        input: makeInput(),
        handler: { enabled: true, diagnosis_timeout_ms: 5000 },
        promptOps: makeDecisionPromptOps({
          action: "replan",
          reason: "current workflow",
          patch: { workflow_id: "wf-current", remove_nodes: [] },
        }),
        agent: { name: "general" } as Agent.Info,
        diagnosisSessionId: SessionID.make("ses_diag_replan_match"),
        workflowProgress: { completed: 0, failed: 1, total: 1 },
      }),
    )

    expect(decision.action).toBe("replan")
    if (decision.action === "replan") {
      expect(decision.patch.workflow_id).toBe("wf-current")
    }
  })
})

function makeDecisionPromptOps(decision: Record<string, unknown>): PromptOps {
  const promptResult = { info: { role: "assistant" }, parts: [] } as unknown as MessageV2.WithParts
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text", text: template }]),
    prompt: (input) =>
      Effect.gen(function* () {
        const decisionFile = (input.parts.find((part) => part.type === "text")?.text ?? "").match(
          /Write your decision as JSON to: (\/tmp\/dag-diagnosis-[^\n]+\.json)/,
        )?.[1]
        if (decisionFile) {
          const fs = yield* Effect.promise(() => import("fs/promises"))
          yield* Effect.promise(() => fs.writeFile(decisionFile, JSON.stringify(decision)))
        }
        return promptResult
      }),
    loop: () => Effect.succeed(promptResult),
  }
}
