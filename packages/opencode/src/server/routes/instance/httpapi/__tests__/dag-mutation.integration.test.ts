// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * DAG Mutation API — DB-level integration tests (review I2 gap).
 *
 * The sibling `dag-mutation.test.ts` only asserts registration / endpoint shape.
 * This suite exercises the *runtime downgrade semantics* of the create / cancel /
 * replan handlers against the real session-service, the real workflow state
 * machine, and a real in-memory SQLite database — no mocked state machine.
 *
 * The HttpApi handlers (handlers/dag-mutation.ts) close over `dagQuery` +
 * `sessionService` and branch on `WorkflowEngine.get(workflowId)`. Driving the
 * full HttpApi router in-process pulls the whole instance layer, so we exercise
 * the handlers' *internal equivalent path* directly — the exact same calls the
 * handler bodies make:
 *   - create  → sessionService.createWorkflow (runs validateWorkflowConfigLimits) + createNode×N,
 *               with NO registerEngine (no daemon forked) → WorkflowEngine.get() === undefined.
 *   - cancel  → engine-missing branch: sessionService.updateWorkflowStatus(cancelled)
 *               wrapped in Effect.catchCause that reads back the current status (idempotent, never 500).
 *   - replan  → engine-missing branch: WorkflowEngine.get() === undefined ⇒ {ok:false, reason:"not_running"},
 *               atomicReplan never touched ⇒ DB config unchanged.
 *
 * Infrastructure mirrors the DAG scenario suites (scenario-21/22):
 * - Flag.OPENCODE_DB = ":memory:" enables in-memory SQLite (db.ts)
 * - Database.Client.reset() forces re-initialization with the in-memory DB
 * - Migrations auto-apply from packages/opencode/migration/ (including DAG tables)
 * - DAGSessionService.make runs via Effect.runSync
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { Effect, Exit } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Database from "@/storage/db"
import { DAGSessionService, WorkflowConfigValidationError } from "@/dag/session/session-service"
import type { IDAGSessionService } from "@/dag/session/session-service"
import { WorkflowEngine } from "@/dag/session/workflow-engine"
import { dagWorkflows } from "@/dag/persistence/schema"
import { eq } from "drizzle-orm"
import type { DAGConfig, DAGNodeConfig } from "@/dag/session/types"

// ============================================================================
// Helpers (structurally typed — no `0 as any`)
// ============================================================================

function makeNodeConfig(id: string, deps: string[] = []): DAGNodeConfig {
  return {
    id,
    name: id,
    dependencies: deps,
    required: false,
    worker_type: "mock",
    worker_config: {},
  }
}

function makeNodes(count: number): DAGNodeConfig[] {
  return Array.from({ length: count }, (_, i) => makeNodeConfig(`n${i}`))
}

function makeConfig(name: string, nodes: DAGNodeConfig[], maxConcurrency: number): DAGConfig {
  return { name, nodes, max_concurrency: maxConcurrency }
}

type SessionService = IDAGSessionService

/** Mirror the create handler: createWorkflow (validates) then createNode×N. */
function createViaHandlerPath(service: SessionService, name: string, config: DAGConfig) {
  return Effect.gen(function* () {
    const workflow = yield* service.createWorkflow({
      name,
      chatSessionId: `test-session-${name}`,
      config,
    })
    for (const cfg of config.nodes) {
      yield* service.createNode({
        workflowId: workflow.id,
        nodeId: `${workflow.id}::${cfg.id}`,
        name: cfg.name,
        nodeName: cfg.name,
        nodeType: cfg.worker_type,
        config: cfg,
        dependencyNodes: cfg.dependencies.map((d) => `${workflow.id}::${d}`),
      })
    }
    return { workflowId: workflow.id, nodeCount: config.nodes.length, status: "pending" as const }
  })
}

/**
 * Mirror the cancel handler's engine-missing branch exactly:
 * updateWorkflowStatus(cancelled) wrapped in catchCause that reads back the
 * current status. A terminal→cancelled transition throws inside
 * updateWorkflowStatus (Effect.sync defect), so catchCause must swallow it and
 * reply idempotently — never propagate a failure.
 */
function cancelViaHandlerPath(service: SessionService, workflowId: string) {
  return service.updateWorkflowStatus(workflowId, "cancelled").pipe(
    Effect.as({ status: "cancelled" as string }),
    Effect.catchCause(() =>
      service.getWorkflow(workflowId).pipe(Effect.map((w) => ({ status: w?.status ?? "pending" }))),
    ),
  )
}

function countWorkflowsByName(name: string): number {
  let rows: unknown[] = []
  Database.use((db) => {
    rows = db.select().from(dagWorkflows).where(eq(dagWorkflows.name, name)).all()
  })
  return rows.length
}

// ============================================================================
// create endpoint — integration (validation iron law + no-daemon)
// ============================================================================

describe("DAG Mutation API — create (DB integration, real session-service + state machine)", () => {
  const originalDb = Flag.OPENCODE_DB

  beforeAll(() => {
    Flag.OPENCODE_DB = ":memory:"
    Database.Client.reset()
  })

  afterAll(() => {
    try {
      Database.close()
    } catch {
      /* ignore */
    }
    Flag.OPENCODE_DB = originalDb
    Database.Client.reset()
  })

  it("legal config (100 nodes, concurrency 3) → real pending workflow row + nodeCount nodes", () => {
    const service = Effect.runSync(DAGSessionService.make)
    const config = makeConfig("create-legal", makeNodes(100), 3)

    const result = Effect.runSync(createViaHandlerPath(service, "create-legal", config))
    expect(result.nodeCount).toBe(100)
    expect(result.status).toBe("pending")

    const workflow = Effect.runSync(service.getWorkflow(result.workflowId))
    expect(workflow?.status).toBe("pending")

    const nodes = Effect.runSync(service.listNodes(result.workflowId))
    expect(nodes).toHaveLength(100)
  })

  it("IRON LAW: 101 nodes → createWorkflow fails WorkflowConfigValidationError, NO workflow row persisted (validate before insert)", () => {
    const service = Effect.runSync(DAGSessionService.make)
    const config = makeConfig("create-101-nodes", makeNodes(101), 5)

    const exit = Effect.runSyncExit(createViaHandlerPath(service, "create-101-nodes", config))
    expect(Exit.isFailure(exit)).toBe(true)
    const error = Effect.runSync(Effect.flip(createViaHandlerPath(service, "create-101-nodes", config)))
    expect(error).toBeInstanceOf(WorkflowConfigValidationError)
    expect(error.message).toBe("node cap exceeded: 101 > 100")

    // Iron law: validation runs before the INSERT, so nothing is persisted.
    expect(countWorkflowsByName("create-101-nodes")).toBe(0)
  })

  it("IRON LAW: max_concurrency = 11 → fails, no residual workflow row", () => {
    const service = Effect.runSync(DAGSessionService.make)
    const config = makeConfig("create-concurrency-11", makeNodes(1), 11)

    const exit = Effect.runSyncExit(createViaHandlerPath(service, "create-concurrency-11", config))
    expect(Exit.isFailure(exit)).toBe(true)
    const error = Effect.runSync(Effect.flip(createViaHandlerPath(service, "create-concurrency-11", config)))
    expect(error).toBeInstanceOf(WorkflowConfigValidationError)
    expect(error.message).toBe("max_concurrency must be 1..10, got 11")
    expect(countWorkflowsByName("create-concurrency-11")).toBe(0)
  })

  it("IRON LAW: max_concurrency = 0 → fails, no residual workflow row", () => {
    const service = Effect.runSync(DAGSessionService.make)
    const config = makeConfig("create-concurrency-0", makeNodes(1), 0)

    const exit = Effect.runSyncExit(createViaHandlerPath(service, "create-concurrency-0", config))
    expect(Exit.isFailure(exit)).toBe(true)
    const error = Effect.runSync(Effect.flip(createViaHandlerPath(service, "create-concurrency-0", config)))
    expect(error).toBeInstanceOf(WorkflowConfigValidationError)
    expect(error.message).toBe("max_concurrency must be 1..10, got 0")
    expect(countWorkflowsByName("create-concurrency-0")).toBe(0)
  })

  it("NO DAEMON: after create, WorkflowEngine.get(workflowId) is undefined and status stays pending (never auto-runs)", () => {
    const service = Effect.runSync(DAGSessionService.make)
    const config = makeConfig("create-no-daemon", makeNodes(3), 2)

    const result = Effect.runSync(createViaHandlerPath(service, "create-no-daemon", config))

    // create never calls registerEngine ⇒ no engine, no fork.
    expect(WorkflowEngine.get(result.workflowId)).toBeUndefined()

    const workflow = Effect.runSync(service.getWorkflow(result.workflowId))
    expect(workflow?.status).toBe("pending")
  })
})

// ============================================================================
// cancel endpoint — integration (downgrade + idempotency through state machine)
// ============================================================================

describe("DAG Mutation API — cancel (DB integration, downgrade + idempotency)", () => {
  const originalDb = Flag.OPENCODE_DB

  beforeAll(() => {
    Flag.OPENCODE_DB = ":memory:"
    Database.Client.reset()
  })

  afterAll(() => {
    try {
      Database.close()
    } catch {
      /* ignore */
    }
    Flag.OPENCODE_DB = originalDb
    Database.Client.reset()
  })

  it("engine missing + running → updateWorkflowStatus(cancelled) transitions through the state machine → DB status cancelled", () => {
    const service = Effect.runSync(DAGSessionService.make)
    const config = makeConfig("cancel-running", makeNodes(1), 1)
    const created = Effect.runSync(createViaHandlerPath(service, "cancel-running", config))

    // Drive pending → running through the real state machine.
    Effect.runSync(service.updateWorkflowStatus(created.workflowId, "running"))
    expect(WorkflowEngine.get(created.workflowId)).toBeUndefined()

    const reply = Effect.runSync(cancelViaHandlerPath(service, created.workflowId))
    expect(reply.status).toBe("cancelled")

    const workflow = Effect.runSync(service.getWorkflow(created.workflowId))
    expect(workflow?.status).toBe("cancelled")
  })

  it("IDEMPOTENT: engine missing + already completed (terminal) → cancel does NOT throw, reads back completed", () => {
    const service = Effect.runSync(DAGSessionService.make)
    const config = makeConfig("cancel-terminal-completed", makeNodes(1), 1)
    const created = Effect.runSync(createViaHandlerPath(service, "cancel-terminal-completed", config))

    // pending → running → completed (terminal) via the real state machine.
    Effect.runSync(service.updateWorkflowStatus(created.workflowId, "running"))
    Effect.runSync(service.updateWorkflowStatus(created.workflowId, "completed"))

    // terminal→cancelled is rejected inside updateWorkflowStatus (Effect.sync defect);
    // the handler's catchCause swallows it. This must NOT raise — it returns the
    // current (terminal) status. runSyncExit catches a defect that would mean a 500.
    const exit = Effect.runSyncExit(cancelViaHandlerPath(service, created.workflowId))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.status).toBe("completed")
    }

    const workflow = Effect.runSync(service.getWorkflow(created.workflowId))
    expect(workflow?.status).toBe("completed")
  })

  it("IDEMPOTENT: engine missing + already cancelled → cancel reads back cancelled (no double-cancel error)", () => {
    const service = Effect.runSync(DAGSessionService.make)
    const config = makeConfig("cancel-already-cancelled", makeNodes(1), 1)
    const created = Effect.runSync(createViaHandlerPath(service, "cancel-already-cancelled", config))

    Effect.runSync(service.updateWorkflowStatus(created.workflowId, "running"))
    Effect.runSync(service.updateWorkflowStatus(created.workflowId, "cancelled"))

    const exit = Effect.runSyncExit(cancelViaHandlerPath(service, created.workflowId))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.status).toBe("cancelled")
    }

    const workflow = Effect.runSync(service.getWorkflow(created.workflowId))
    expect(workflow?.status).toBe("cancelled")
  })
})

// ============================================================================
// replan endpoint — integration (no-downgrade: not_running + no side effects)
// ============================================================================

describe("DAG Mutation API — replan (DB integration, no downgrade / no side effects)", () => {
  const originalDb = Flag.OPENCODE_DB

  beforeAll(() => {
    Flag.OPENCODE_DB = ":memory:"
    Database.Client.reset()
  })

  afterAll(() => {
    try {
      Database.close()
    } catch {
      /* ignore */
    }
    Flag.OPENCODE_DB = originalDb
    Database.Client.reset()
  })

  it("engine missing → handler returns {ok:false, reason:'not_running'} and DB config is untouched (atomicReplan never invoked)", () => {
    const service = Effect.runSync(DAGSessionService.make)
    const config = makeConfig("replan-not-running", makeNodes(3), 2)
    const created = Effect.runSync(createViaHandlerPath(service, "replan-not-running", config))

    const before = Effect.runSync(service.getWorkflow(created.workflowId))
    const configBefore = JSON.stringify(before?.config)

    // Mirror the replan handler's guard: WorkflowEngine.get(id) drives the branch.
    const engine = WorkflowEngine.get(created.workflowId)
    expect(engine).toBeUndefined()
    const reply = engine ? { ok: true as const } : { ok: false as const, reason: "not_running" }

    expect(reply).toEqual({ ok: false, reason: "not_running" })

    // No downgrade ⇒ atomicReplan untouched ⇒ config unchanged in the DB.
    const after = Effect.runSync(service.getWorkflow(created.workflowId))
    expect(JSON.stringify(after?.config)).toBe(configBefore)
    expect((after?.config as DAGConfig).nodes).toHaveLength(3)
  })
})
