// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { validateWorkerTypes, type WorkerTypeAgentRegistry } from "./dagworker"
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
