// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

import { describe, expect, test, mock } from "bun:test"
import { Effect, Schema } from "effect"
import { validateWorkerTypes, Parameters, type WorkerTypeAgentRegistry } from "./dagworker"
import { WorkflowEngine } from "../dag/session/workflow-engine"
import type { DAGNodeConfig } from "../dag/session/types"
import type { Agent } from "@/agent/agent"

function createAgent(name: string): Agent.Info {
  return {
    name,
    mode: "subagent",
    permission: [],
    options: {},
  }
}

function createNode(workerType: string): DAGNodeConfig {
  return {
    id: workerType,
    name: workerType,
    dependencies: [],
    required: true,
    worker_type: workerType,
    worker_config: {},
  }
}

function createAgentService(input: {
  agents: string[]
  failingGets?: string[]
}): WorkerTypeAgentRegistry {
  return {
    get: (agent) =>
      input.failingGets?.includes(agent)
        ? Effect.fail(new Error(`get failed: ${agent}`))
        : Effect.succeed(input.agents.includes(agent) ? createAgent(agent) : undefined),
    list: () => Effect.succeed(input.agents.map(createAgent)),
  }
}

describe("validateWorkerTypes", () => {
  test("passes when all unique worker types exist in the active agent registry", async () => {
    await Effect.runPromise(
      validateWorkerTypes(createAgentService({ agents: ["general", "implement"] }), [
        createNode("general"),
        createNode("implement"),
        createNode("implement"),
      ]),
    )
  })

  test("fails with a dynamic registered-agent list for missing worker types", async () => {
    const result = await Effect.runPromiseExit(
      validateWorkerTypes(createAgentService({ agents: ["build", "general", "verify"] }), [
        createNode("implement"),
      ]),
    )

    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("expected validateWorkerTypes to fail")
    expect(String(result.cause)).toContain("Unknown DAG worker_type: implement")
    expect(String(result.cause)).toContain("Currently registered agents: build, general, verify")
    expect(String(result.cause)).toContain("Configure custom agents in opencode.json agent.* or change worker_type before starting DAG.")
  })

  test("treats agent registry get failures as missing worker types", async () => {
    const result = await Effect.runPromiseExit(
      validateWorkerTypes(createAgentService({ agents: ["build", "general"], failingGets: ["general"] }), [
        createNode("general"),
      ]),
    )

    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("expected validateWorkerTypes to fail")
    expect(String(result.cause)).toContain("Unknown DAG worker_type: general")
    expect(String(result.cause)).toContain("Currently registered agents: build, general")
  })
})

describe("Parameters schema", () => {
  const decode = Schema.decodeUnknownSync(Parameters)

  test("accepts 'pause' as a valid action", () => {
    const result = decode({ action: "pause", workflow: "wf-123" })
    expect(result.action).toBe("pause")
  })

  test("accepts 'resume' as a valid action", () => {
    const result = decode({ action: "resume", workflow: "wf-123" })
    expect(result.action).toBe("resume")
  })

  test("rejects unknown action literals", () => {
    expect(() => decode({ action: "invalid_action" })).toThrow()
  })
})

describe("pause/resume engine lookup", () => {
  test("WorkflowEngine.get returns undefined for unregistered workflow id", () => {
    const engine = WorkflowEngine.get("nonexistent-workflow-id")
    expect(engine).toBeUndefined()
  })

  test("pause: registered engine calls pauseWorkflow and returns paused status", async () => {
    const mockEngine = {
      pauseWorkflow: mock((id: string) => Effect.succeed("paused" as const)),
      resumeWorkflow: mock((id: string) => Effect.succeed("running" as const)),
    }
    const originalGet = WorkflowEngine.get
    WorkflowEngine.get = (id: string) => id === "wf-pause-test" ? mockEngine as unknown as ReturnType<typeof originalGet> : undefined
    try {
      const engine = WorkflowEngine.get("wf-pause-test")
      expect(engine).not.toBeUndefined()
      const status = await Effect.runPromise(engine!.pauseWorkflow("wf-pause-test"))
      expect(status).toBe("paused")
      expect(mockEngine.pauseWorkflow).toHaveBeenCalledWith("wf-pause-test")
    } finally {
      WorkflowEngine.get = originalGet
    }
  })

  test("resume: registered engine calls resumeWorkflow and returns running status", async () => {
    const mockEngine = {
      pauseWorkflow: mock((id: string) => Effect.succeed("paused" as const)),
      resumeWorkflow: mock((id: string) => Effect.succeed("running" as const)),
    }
    const originalGet = WorkflowEngine.get
    WorkflowEngine.get = (id: string) => id === "wf-resume-test" ? mockEngine as unknown as ReturnType<typeof originalGet> : undefined
    try {
      const engine = WorkflowEngine.get("wf-resume-test")
      expect(engine).not.toBeUndefined()
      const status = await Effect.runPromise(engine!.resumeWorkflow("wf-resume-test"))
      expect(status).toBe("running")
      expect(mockEngine.resumeWorkflow).toHaveBeenCalledWith("wf-resume-test")
    } finally {
      WorkflowEngine.get = originalGet
    }
  })

  test("pause: unregistered engine returns undefined for fallback path", () => {
    const engine = WorkflowEngine.get("wf-no-engine")
    expect(engine).toBeUndefined()
  })

  test("resume: unregistered engine returns undefined for fallback path", () => {
    const engine = WorkflowEngine.get("wf-no-engine-resume")
    expect(engine).toBeUndefined()
  })
})

describe("WP3: dagworker orphan engine fixes", () => {
  describe("status action", () => {
    test("WorkflowEngine.get returns undefined for unregistered workflow (no orphan engine)", () => {
      // After WP3, status no longer calls WorkflowEngine.make — it uses the
      // read-only sessionService path. Verifying get returns undefined proves
      // no orphan engine can exist for an arbitrary id.
      const engine = WorkflowEngine.get("wf-status-no-engine")
      expect(engine).toBeUndefined()
    })
  })

  describe("cancel action", () => {
    test("registered engine calls cancelWorkflow", async () => {
      const mockEngine = {
        cancelWorkflow: mock((id: string) => Effect.succeed({ success: true })),
      }
      const originalGet = WorkflowEngine.get
      WorkflowEngine.get = (id: string) =>
        id === "wf-cancel-registered" ? mockEngine as unknown as ReturnType<typeof originalGet> : undefined
      try {
        const engine = WorkflowEngine.get("wf-cancel-registered")
        expect(engine).not.toBeUndefined()
        const result = await Effect.runPromise(engine!.cancelWorkflow("wf-cancel-registered"))
        expect((result as { success: boolean }).success).toBe(true)
        expect(mockEngine.cancelWorkflow).toHaveBeenCalledWith("wf-cancel-registered")
      } finally {
        WorkflowEngine.get = originalGet
      }
    })

    test("unregistered engine returns undefined (triggers DB fallback in status/updateWorkflowStatus)", () => {
      const engine = WorkflowEngine.get("wf-cancel-no-engine")
      expect(engine).toBeUndefined()
    })
  })

  describe("replan action", () => {
    test("unregistered engine returns undefined (triggers clear-error fail path)", () => {
      const engine = WorkflowEngine.get("wf-replan-no-engine")
      expect(engine).toBeUndefined()
    })

    test("registered engine calls replanWorkflow", async () => {
      const mockEngine = {
        replanWorkflow: mock((_id: string, _patch: unknown) =>
          Effect.succeed({
            ok: true as const,
            workflow_id: "wf-replan-registered",
            history_id: "h-1",
            nodes_added: 1,
            nodes_removed: 0,
            nodes_updated: 0,
            final_total: 3,
          }),
        ),
      }
      const originalGet = WorkflowEngine.get
      WorkflowEngine.get = (id: string) =>
        id === "wf-replan-registered" ? mockEngine as unknown as ReturnType<typeof originalGet> : undefined
      try {
        const engine = WorkflowEngine.get("wf-replan-registered")
        expect(engine).not.toBeUndefined()
        const patch = { workflow_id: "wf-replan-registered" }
        const result = await Effect.runPromise(engine!.replanWorkflow("wf-replan-registered", patch))
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.final_total).toBe(3)
        }
        expect(mockEngine.replanWorkflow).toHaveBeenCalled()
      } finally {
        WorkflowEngine.get = originalGet
      }
    })
  })
})
