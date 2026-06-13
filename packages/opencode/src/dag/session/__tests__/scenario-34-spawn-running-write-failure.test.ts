// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * Regression: spawnReadyNode pending→running DB write failure swallowed by Effect.ignore
 *
 * Symptom (before fix):
 *   updateNodeStatus({status:'running'}) at spawnReadyNode L~741 returned an Effect
 *   whose failure was silently swallowed by Effect.ignore. If the DB write failed
 *   (state machine rejection, I/O error, etc.) the node stayed `pending` in DB while
 *   a child agent prompt was dispatched. When the child agent later called
 *   node_complete, the state machine rejected `pending → completed` as an illegal
 *   transition, leaving the node permanently stuck and convergence broken.
 *   Same pattern existed for sub-DAG node dispatch (L~492).
 *
 * Fix:
 *   Introduced `handleSpawnFailure` (module-internal helper) that drives the only
 *   legal pending-terminal transition: pending → skipped (A-layer execution-core
 *   L382-383 getValidNextSessionNodeStatuses). Runs cascade / finalize / stepMode
 *   Deferred release best-effort on every inner write.
 *
 *   Both running-write paths (regular node + sub-DAG) are converted from
 *   Effect.ignore to Effect.result + handleSpawnFailure on Result.isFailure.
 *
 * Test approach:
 *   spawnReadyNode requires real Agent.Service + Session.Service + promptOps plus
 *   a real DAGSessionService. These are not available in unit-test context
 *   (see step-workflow.test.ts "fallback" pattern). To drive spawnReadyNode all
 *   the way to L~741 in this test, we:
 *   1. Monkey-patch `DAGSessionService.make` to wrap updateNodeStatus with a
 *      fault-injection layer that fails running-writes for a specific node_id.
 *      (All other calls pass through — test harness state setup uses the real
 *      service, so test code never hits the injected fault.)
 *   2. Construct the engine from the patched make; restore the original.
 *   3. Provide fake Agent.Service + Session.Service via Effect.provideService
 *      at the spawnReadyNode invocation site so the Effect context at runtime
 *      contains the required services.
 *   4. Set promptOps before invoking spawnReadyNode.
 *
 * Coverage:
 *   (a) Regular node: pending→running write fails → node skipped, B cascade-skipped,
 *       no child session prompted, spawnedNodes cleaned.
 *   (b) Baseline: pending→running write succeeds → normal "running" log, continues
 *       dispatch (outer catchCause still fires at missing real agent — irrelevant
 *       for what we're verifying: the running write succeeded and the success
 *       branch did NOT take the failure short-circuit).
 *   (c) stepMode: pending→running write fails → Deferred resolved with
 *       { ok:false, reason:'node_failed' }, stepWorkflow does not hang.
 *   (d) Concurrency budget re-schedule: 5 independent ready nodes, max_concurrency 2,
 *       first spawned node's running-write fails → handleSpawnFailure calls
 *       scheduleReadyNodes → 2 sibling nodes dispatched (spawnedNodes gains entries).
 *       Without the scheduleReadyNodes call, all 4 siblings would remain pending
 *       forever (workflow stuck running).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Effect } from 'effect'
import type {
  DAGConfig,
  DAGNodeConfig,
  DAGNodeSession,
  DAGWorkflowSession,
  StepResult,
} from '../types'
import type { IDAGSessionService } from '../session-service'
import { Agent } from '@/agent/agent'
import { Session } from '@/session/session'
import type { PromptOps } from '@/session/prompt-ops'
import type { MessageV2 } from '@/session/message-v2'
import type { SessionPrompt } from '@/session/prompt'

// ============================================================================
// Helpers
// ============================================================================

function makeNodeConfig(
  id: string,
  deps: string[] = [],
  required: boolean = true,
): DAGNodeConfig {
  return {
    id,
    name: `Node ${id}`,
    required,
    dependencies: deps,
    worker_type: 'general',
    worker_config: { prompt: `do ${id}` },
  }
}

function setupWorkflow(
  service: IDAGSessionService,
  name: string,
  nodes: { id: string; deps: string[]; required: boolean }[],
): { workflowId: string; workflow: DAGWorkflowSession } {
  const nodeConfigs = nodes.map((n) => makeNodeConfig(n.id, n.deps, n.required))
  const config: DAGConfig = { name, nodes: nodeConfigs, max_concurrency: 10 }
  const workflow = Effect.runSync(
    service.createWorkflow({
      name,
      chatSessionId: `test-spawn-fail-${name}-${Date.now()}`,
      config,
    }),
  )
  for (const cfg of nodeConfigs) {
    Effect.runSync(
      service.createNode({
        workflowId: workflow.id,
        nodeId: `${workflow.id}::${cfg.id}`,
        name: cfg.name,
        nodeName: cfg.name,
        nodeType: cfg.worker_type,
        config: cfg,
        dependencyNodes: cfg.dependencies.map((d) => `${workflow.id}::${d}`),
        timeoutMs: cfg.timeout_ms,
        maxRetries: cfg.retry?.max_attempts ?? 0,
      }),
    )
  }
  return { workflowId: workflow.id, workflow }
}

function mockPromptOps(): PromptOps {
  const stubParts = [] as SessionPrompt.PromptInput['parts']
  const stubWithParts = { messages: [], parts: [] } as unknown as MessageV2.WithParts
  return {
    cancel: () => Effect.void,
    resolvePromptParts: () => Effect.succeed(stubParts),
    prompt: () => Effect.succeed(stubWithParts),
    loop: () => Effect.succeed(stubWithParts),
  }
}

// ============================================================================
// Test suite
// ============================================================================

describe('spawnReadyNode: pending→running DB write failure → handleSpawnFailure', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originalDb = (globalThis as any).__OPENCODE_DB_FLAG__
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Flag: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Database: any
  let realService: IDAGSessionService
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let engine: any

  // Fault-injected node ids: updateNodeStatus({status:'running', sessionId in this set})
  // will return an Effect.fail instead of persisting.
  let failRunningForNodeIds: Set<string>

  beforeAll(async () => {
    Flag = (await import('@opencode-ai/core/flag/flag')).Flag
    Database = await import('@/storage/db')
    const { DAGSessionService } = await import('../session-service')
    const { WorkflowEngine } = await import('../workflow-engine')

    Flag.OPENCODE_DB = ':memory:'
    Database.Client.reset()

    // Create the REAL service first — we'll use it directly from test code
    // to set up workflow/node state (no fault injection on these calls).
    realService = Effect.runSync(DAGSessionService.make)

    failRunningForNodeIds = new Set<string>()

    // --- Fault-injection wrapper ---
    // Wrap updateNodeStatus so that running-writes for nodeIds in
    // `failRunningForNodeIds` return Effect.fail, simulating a state machine
    // rejection or DB I/O error on the specific pending→running call that
    // spawnReadyNode makes at its #5 mark.
    const originalMake = DAGSessionService.make
    const wrappedMake = Effect.gen(function* () {
      // Create another fresh real service (separate DB connection) for engine use
      const inner = yield* originalMake
      return {
        ...inner,
        updateNodeStatus: (input: { sessionId: string; status: string }) => {
          if (input.status === 'running' && failRunningForNodeIds.has(input.sessionId)) {
            return Effect.fail(
              new Error(
                `INJECTED: updateNodeStatus('${input.sessionId}', 'running') write failure`,
              ),
            )
          }
          return inner.updateNodeStatus(
            input as Parameters<typeof inner.updateNodeStatus>[0],
          )
        },
      }
    })

    // Patch the module export for engine creation
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(DAGSessionService as any).make = wrappedMake

    // Build engine — it now holds the wrapped service in its closure.
    engine = Effect.runSync(WorkflowEngine.make)

    // Restore the original make immediately so subsequent module-level usage
    // (if any) sees the real one.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(DAGSessionService as any).make = originalMake
  })

  afterAll(async () => {
    try {
      Database.close()
    } catch {
      /* ignore */
    }
    Flag.OPENCODE_DB = originalDb ?? undefined
    Database.Client.reset()
    failRunningForNodeIds.clear()
  })

  // --------------------------------------------------------------------------
  // (a) Regular node: running-write fails → node skipped, downstream cascade
  // --------------------------------------------------------------------------
  it('(a) pending→running write fails → node skipped, downstream cascade, spawnedNodes cleaned', async () => {
    const { Agent } = await import('@/agent/agent')
    const { Session } = await import('@/session/session')
    const { __internal_spawnedNodes } = await import('../workflow-engine')

    // Setup: A → B chain, no deps on A so A is ready.
    const { workflowId } = setupWorkflow(realService, 'sf-case-a', [
      { id: 'A', deps: [], required: true },
      { id: 'B', deps: ['A'], required: true },
    ])
    Effect.runSync(realService.updateWorkflowStatus(workflowId, 'running'))

    const nodeAId = `${workflowId}::A`
    const nodeBId = `${workflowId}::B`

    // Register the fault: spawnReadyNode will try updateNodeStatus(running) on A
    failRunningForNodeIds.add(nodeAId)

    // Seed spawnedNodes so the engine thinks A is "in-flight" (matching what
    // scheduleReadyNodes does before forkDetach). Without this the engine body
    // won't see A as spawned and cascade cleanup will be a no-op.
    __internal_spawnedNodes().add(nodeAId)

    // Set promptOps so spawnReadyNode passes the early-return guard at L~417.
    engine.setPromptOps(mockPromptOps())

    const fakeAgentService = {
      get: () => Effect.succeed({ name: 'general' } as Agent.Info),
    } as Pick<Agent.Interface, 'get'>
    const fakeSessionService = {
      create: ({ title }: { title: string }) =>
        Effect.succeed({
          id: `fake-session-${title}`,
          title,
          parentID: 'fake-parent',
        }),
    } as unknown as Pick<Session.Interface, 'create'>

    // Drive spawnReadyNode with Agent + Session services injected at runtime.
    // Node A's DAGNodeSession shape is fetched from the real service by the
    // scheduleReadyNodes path in production; we re-read it here and pass directly.
    const nodeA: DAGNodeSession = Effect.runSync(realService.getNode(nodeAId))!
    await Effect.runPromise(
      engine
        .spawnReadyNode(workflowId, nodeA, new Map())
        .pipe(
          Effect.provideService(Agent.Service, fakeAgentService as Agent.Interface),
          Effect.provideService(Session.Service, fakeSessionService as Session.Interface),
        ),
    )

    // Clear the fault for subsequent tests
    failRunningForNodeIds.delete(nodeAId)

    // Node A ends up SKIPPED (not failed — the fix uses the only legal pending-terminal)
    const finalA = Effect.runSync(realService.getNode(nodeAId)) as DAGNodeSession
    expect(finalA?.status).toBe('skipped')

    // Downstream B is cascade-skipped (upstream_failure trigger)
    const finalB = Effect.runSync(realService.getNode(nodeBId)) as DAGNodeSession
    expect(finalB?.status).toBe('skipped')

    // Audit: node_logs contain execution_phase 'running_status_write_failed'
    const logs = Effect.runSync(realService.listNodeLogs(nodeAId))
    const spawnFailLog = logs.find(
      (l) => l.execution_phase === 'running_status_write_failed',
    )
    expect(spawnFailLog).toBeDefined()
    expect(spawnFailLog?.log_level).toBe('error')
    expect(spawnFailLog?.log_message).toContain('Node spawn failure')

    // Success-path "running" log was NOT written (since we short-circuited
    // before that safeAppendLog call).
    const runningLog = logs.find((l) => l.execution_phase === 'running')
    expect(runningLog).toBeUndefined()

    // spawnedNodes cleanup — the engine must have deleted A from the set.
    expect(__internal_spawnedNodes().has(nodeAId)).toBe(false)

    // Violation: execution_failed audit record created
    const violations = Effect.runSync(realService.listViolations(workflowId))
    const spawnViolation = violations.find(
      (v) => v.nodeId === nodeAId && v.type === 'execution_failed',
    )
    expect(spawnViolation).toBeDefined()
    expect(spawnViolation?.message).toContain('Spawn failure')
  })

  // --------------------------------------------------------------------------
  // (b) Baseline: running-write succeeds → normal path (no short-circuit)
  // --------------------------------------------------------------------------
  it('(b) pending→running write succeeds → node transitions to running, "running" log written', async () => {
    const { Agent } = await import('@/agent/agent')
    const { Session } = await import('@/session/session')

    // Setup: A alone — we only care about the running-write succeeding.
    const { workflowId } = setupWorkflow(realService, 'sf-case-b', [
      { id: 'A', deps: [], required: true },
    ])
    Effect.runSync(realService.updateWorkflowStatus(workflowId, 'running'))

    const nodeAId = `${workflowId}::A`

    // NO fault injection — the running write must succeed normally.
    engine.setPromptOps(mockPromptOps())

    const fakeAgentService = {
      get: () => Effect.succeed({ name: 'general' } as Agent.Info),
    } as Pick<Agent.Interface, 'get'>
    const fakeSessionService = {
      create: ({ title }: { title: string }) =>
        Effect.succeed({
          id: `fake-session-${title}`,
          title,
          parentID: 'fake-parent',
        }),
    } as unknown as Pick<Session.Interface, 'create'>

    const nodeA: DAGNodeSession = Effect.runSync(realService.getNode(nodeAId))!
    await Effect.runPromise(
      engine
        .spawnReadyNode(workflowId, nodeA, new Map())
        .pipe(
          Effect.provideService(Agent.Service, fakeAgentService as Agent.Interface),
          Effect.provideService(Session.Service, fakeSessionService as Session.Interface),
        ),
    )

    // Node A reached running (or beyond). Critical: it is NOT stuck at pending,
    // and the success branch was taken (i.e. the running write was not mis-routed
    // to handleSpawnFailure).
    const finalA = Effect.runSync(realService.getNode(nodeAId)) as DAGNodeSession
    // After running write, the next step is prompt dispatch — our fake agent
    // + promptOps may leave A in running/failed/completed depending on how
    // prompt ops completes. The invariant: A left pending, and no spawn-failure
    // skip was applied.
    expect(finalA?.status).not.toBe('pending')

    const logs = Effect.runSync(realService.listNodeLogs(nodeAId))
    const runningLog = logs.find((l) => l.execution_phase === 'running')
    expect(runningLog).toBeDefined()
    expect(runningLog?.log_level).toBe('info')

    // And no spawn-failure log should exist
    const spawnFailLog = logs.find(
      (l) => l.execution_phase === 'running_status_write_failed',
    )
    expect(spawnFailLog).toBeUndefined()
  })

  // --------------------------------------------------------------------------
  // (c) stepMode: running-write fails → Deferred released, stepWorkflow unblocks
  // --------------------------------------------------------------------------
  it('(c) stepMode + pending→running write fails → Deferred resolved ok:false:node_failed, stepWorkflow unblocks', async () => {
    const { Agent } = await import('@/agent/agent')
    const { Session } = await import('@/session/session')
    const { __internal_stepMode, __internal_spawnedNodes } = await import(
      '../workflow-engine'
    )

    // Setup: A alone, no deps
    const { workflowId } = setupWorkflow(realService, 'sf-case-c-stepmode', [
      { id: 'A', deps: [], required: true },
    ])
    // Workflow must be paused for stepWorkflow to accept (status gate), but
    // spawnReadyNode's paused guard will bail unless stepMode is active for the
    // same workflow — stepWorkflow itself adds stepMode before forking. We'll
    // mimic that: pause the workflow AND add stepMode + stepResolve before
    // calling spawnReadyNode directly.
    Effect.runSync(realService.updateWorkflowStatus(workflowId, 'running'))
    Effect.runSync(realService.updateWorkflowStatus(workflowId, 'paused'))

    const nodeAId = `${workflowId}::A`
    failRunningForNodeIds.add(nodeAId)
    __internal_spawnedNodes().add(nodeAId)

    engine.setPromptOps(mockPromptOps())

    const fakeAgentService = {
      get: () => Effect.succeed({ name: 'general' } as Agent.Info),
    } as Pick<Agent.Interface, 'get'>
    const fakeSessionService = {
      create: ({ title }: { title: string }) =>
        Effect.succeed({
          id: `fake-session-${title}`,
          title,
          parentID: 'fake-parent',
        }),
    } as unknown as Pick<Session.Interface, 'create'>

    // Drive step end-to-end via engine.stepWorkflow — this internally adds
    // stepMode, registers Deferred, forks spawnReadyNode with the injected
    // Agent+Session context provided at runtime. stepWorkflow's paused guard
    // lets spawnReadyNode run (stepMode is active for the target workflow).

    const result: StepResult = await Effect.runPromise(
      engine.stepWorkflow(workflowId).pipe(
        Effect.provideService(Agent.Service, fakeAgentService as Agent.Interface),
        Effect.provideService(Session.Service, fakeSessionService as Session.Interface),
      ),
    )

    // Clear fault for subsequent tests
    failRunningForNodeIds.delete(nodeAId)

    // stepWorkflow returns the Deferred's resolution: ok:false:node_failed
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('node_failed')
      if (result.reason === 'node_failed') {
        expect(result.node_id).toBe(nodeAId)
        expect(result.error).toMatch(/spawn failure/i)
      }
    }

    // Node A ended up skipped (not failed, not stuck pending)
    const finalA = Effect.runSync(realService.getNode(nodeAId)) as DAGNodeSession
    expect(finalA?.status).toBe('skipped')

    // Workflow remains paused (stepMode invariant — finalize skipped under step)
    const wf = Effect.runSync(realService.getWorkflow(workflowId)) as DAGWorkflowSession
    expect(wf.status).toBe('paused')

    // stepMode cleaned up by stepWorkflow's Effect.ensuring
    expect(__internal_stepMode().has(workflowId)).toBe(false)

    // spawnedNodes cleaned up by handleSpawnFailure
    expect(__internal_spawnedNodes().has(nodeAId)).toBe(false)
  })

  // --------------------------------------------------------------------------
  // (d) Concurrency budget re-schedule: spawn-failure frees a slot → siblings dispatched
  // --------------------------------------------------------------------------
  it('(d) concurrency budget: spawn-failure on one of max_concurrency=2 slots → scheduleReadyNodes dispatches 2 siblings', async () => {
    const { Agent } = await import('@/agent/agent')
    const { Session } = await import('@/session/session')
    const { __internal_spawnedNodes, __internal_concurrencyRegistry } = await import(
      '../workflow-engine'
    )

    // Setup: 5 independent ready nodes (A, B, C, D, E), max_concurrency: 2.
    // A's running-write will fail; the other 4 should be unaffected (no cascade).
    const { workflowId } = setupWorkflow(realService, 'sf-case-d-reschedule', [
      { id: 'A', deps: [], required: true },
      { id: 'B', deps: [], required: true },
      { id: 'C', deps: [], required: true },
      { id: 'D', deps: [], required: true },
      { id: 'E', deps: [], required: true },
    ])
    Effect.runSync(realService.updateWorkflowStatus(workflowId, 'running'))

    const nodeAId = `${workflowId}::A`
    const siblingIds = ['B', 'C', 'D', 'E'].map((x) => `${workflowId}::${x}`)

    // Set concurrency cap so the budget is meaningful.
    __internal_concurrencyRegistry().set(workflowId, 2)

    // Inject fault only on A — siblings must succeed their running-write.
    failRunningForNodeIds.add(nodeAId)

    // Simulate A being in-flight (as scheduleReadyNodes would have done before forkDetach).
    __internal_spawnedNodes().add(nodeAId)

    engine.setPromptOps(mockPromptOps())

    const fakeAgentService = {
      get: () => Effect.succeed({ name: 'general' } as Agent.Info),
    } as Pick<Agent.Interface, 'get'>
    const fakeSessionService = {
      create: ({ title }: { title: string }) =>
        Effect.succeed({
          id: `fake-session-${title}`,
          title,
          parentID: 'fake-parent',
        }),
    } as unknown as Pick<Session.Interface, 'create'>

    const nodeA: DAGNodeSession = Effect.runSync(realService.getNode(nodeAId))!
    await Effect.runPromise(
      engine
        .spawnReadyNode(workflowId, nodeA, new Map())
        .pipe(
          Effect.provideService(Agent.Service, fakeAgentService as Agent.Interface),
          Effect.provideService(Session.Service, fakeSessionService as Session.Interface),
        ),
    )

    // Clear fault and concurrency override for subsequent tests.
    failRunningForNodeIds.delete(nodeAId)
    __internal_concurrencyRegistry().delete(workflowId)

    // ── Assertions ─────────────────────────────────────────────────────────
    // (1) A ended up skipped (handleSpawnFailure path, same as case a).
    const finalA = Effect.runSync(realService.getNode(nodeAId)) as DAGNodeSession
    expect(finalA?.status).toBe('skipped')

    // (2) spawnedNodes no longer holds A.
    expect(__internal_spawnedNodes().has(nodeAId)).toBe(false)

    // (3) CRITICAL: scheduleReadyNodes was called and dispatched new siblings.
    //     spawnedNodes.add is synchronous within scheduleReadyNodes (before forkDetach),
    //     so we can observe the new entries reliably. Budget = 2 - 0 inFlight(A deleted) = 2.
    //     Expect exactly 2 new sibling entries in spawnedNodes for this workflow.
    const siblingSpawned = siblingIds.filter((id) => __internal_spawnedNodes().has(id))
    expect(siblingSpawned.length).toBe(2)

    // (4) Sibling nodes are NOT cascade-skipped (they have no dependency on A).
    //     Each remaining sibling is either still pending or moved to running by the
    //     forked spawnReadyNode fibers — but none should be skipped.
    const siblingStatuses = siblingIds.map((id) => {
      const n = Effect.runSync(realService.getNode(id)) as DAGNodeSession
      return { id, status: n?.status }
    })
    const skippedSiblings = siblingStatuses.filter((s) => s.status === 'skipped')
    expect(skippedSiblings).toEqual([]) // no cascade

    // (5) Workflow stays running (not finalized — 4 nodes still non-terminal).
    const wf = Effect.runSync(
      realService.getWorkflow(workflowId),
    ) as DAGWorkflowSession
    expect(wf.status).toBe('running')

    // Cleanup: remove spawnedNodes entries from siblings (they were added synchronously
    // by scheduleReadyNodes but the forked fibers may still be running — prevent leaking
    // state into subsequent tests).
    for (const id of siblingIds) __internal_spawnedNodes().delete(id)
  })
})
