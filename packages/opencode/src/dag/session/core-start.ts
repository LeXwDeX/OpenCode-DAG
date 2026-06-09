// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * Headless workflow bootstrap — Tool.Context-free core startup function (WP-D1).
 *
 * Single source for the 7-step workflow bootstrap sequence:
 *   1. RequiredNodesValidator validation (+ warnings via console.warn, INFO-5)
 *   2. validateWorkerTypes (agent registry resolution)
 *   3. DB createWorkflow row
 *   4. DB createNode rows (with namespaced IDs: `${workflowId}::${nodeId}`)
 *   5. WorkflowEngine.make + setPromptOps
 *   6. registerEngine + WorkflowEngine.startWorkflow (status→running + scheduleReadyNodes)
 *   7. forkDetach executor daemon (BEFORE abort listener) + abortSignal.addEventListener
 *
 * Called by:
 * - dagworker.ts (tool path) — thin adapter that destructures Tool.Context
 * - future sub-DAG spawn path (WP-D2) — headless invocation
 *
 * The abort listener MUST be registered AFTER forkDetach (architecture constraint 3).
 * The RequiredNodesValidator call migrates here (single source, INFO-3).
 *
 * Design decisions:
 * - `validateWorkerTypes` is defined here (single source) and re-exported from
 *   dagworker.ts for backward compatibility with existing tests. Both the tool path
 *   and the recursive sub-DAG spawn path (WP-D2) call this.
 * - Core function named `bootstrapWorkflowFromConfig` to avoid confusion with
 *   `WorkflowEngine.startWorkflow` (INFO-4), which only flips status + schedules;
 *   this function is the full create+start bootstrap.
 * - Object literal parameter shape matches existing codebase conventions.
 */

import { Effect } from "effect"
import type { Agent } from "@/agent/agent"
import type { PromptOps } from "@/session/prompt-ops"
import type { IDAGSessionService } from "./session-service"
import { WorkflowEngine, registerEngine } from "./workflow-engine"
import type { WorkflowExecutor } from "./workflow-executor"
import { createWorkflowExecutor } from "./workflow-executor"
import type { DAGConfig, DAGNodeConfig } from "./types"
import { RequiredNodesValidator } from "./required-nodes-validator"

/**
 * Registry interface used to validate worker_type values against the active
 * agent configuration. Matches the shape required by both the tool path
 * (dagworker.ts, where Agent.Service is yielded) and future sub-DAG spawn
 * paths (WP-D2).
 */
export type WorkerTypeAgentRegistry = {
  readonly get: (agent: string) => Effect.Effect<Agent.Info | undefined, unknown>
  readonly list: () => Effect.Effect<Agent.Info[], unknown>
}

/**
 * Fail-fast worker_type validation.
 *
 * Resolves every unique worker_type against `agentService`. If any is missing,
 * fails with an actionable error listing registered agents + the config location
 * for custom agents (`opencode.json agent.*`).
 *
 * Defined here (single source) so that both the tool path (dagworker.ts) and
 * the recursive sub-DAG spawn path (WP-D2) share the same validation entry
 * point. Re-exported from dagworker.ts for backward compat with existing tests.
 */
export const validateWorkerTypes = (
  agentService: WorkerTypeAgentRegistry,
  nodes: DAGNodeConfig[],
) =>
  Effect.gen(function* () {
    const unique = [...new Set(nodes.map((n) => n.worker_type))]
    const missing: string[] = []
    for (const workerType of unique) {
      const found = yield* agentService.get(workerType).pipe(
        Effect.catchCause(() => Effect.succeed(undefined)),
      )
      if (!found) missing.push(workerType)
    }
    if (missing.length === 0) return
    const registered = yield* agentService.list().pipe(
      Effect.catchCause(() => Effect.succeed([] as Agent.Info[])),
    )
    const names = registered.map((a) => a.name).sort()
    return yield* Effect.fail(
      new Error(
        `Unknown DAG worker_type: ${missing.join(", ")}. Currently registered agents: ${names.length ? names.join(", ") : "<none>"}. Configure custom agents in opencode.json agent.* or change worker_type before starting DAG.`,
      ),
    )
  })

/**
 * Result returned by `bootstrapWorkflowFromConfig`.
 */
export type BootstrapWorkflowResult = {
  workflowId: string
  nodeCount: number
}

/**
 * Tool.Context-free workflow bootstrap (WP-D1 core).
 *
 * Single source for the full 7-step workflow startup sequence (validate →
 * DB rows → engine assembly → daemon → abort listener). The tool path
 * (dagworker.ts) and future sub-DAG spawn (WP-D2) both call into this.
 *
 * @param dagConfig          The DAG workflow configuration (name, nodes, max_concurrency, ...).
 * @param chatSessionId      The chat session under which the workflow is scoped (was ctx.sessionID).
 * @param promptOps          Prompt operations reference (was ctx.extra.promptOps).
 * @param abortSignal        AbortSignal for cooperative cancellation (was ctx.abort).
 *                           Listener is registered AFTER forkDetach daemon (constraint 3).
 * @param dagSessionService  DB session service (state persistence — iron law #4).
 * @param agentService       Agent registry for worker_type validation.
 */
export const bootstrapWorkflowFromConfig = (args: {
  dagConfig: DAGConfig
  chatSessionId: string
  promptOps: PromptOps
  abortSignal: AbortSignal
  dagSessionService: IDAGSessionService
  agentService: WorkerTypeAgentRegistry
}) =>
  Effect.gen(function* () {
    const { dagConfig, chatSessionId, promptOps, abortSignal, dagSessionService, agentService } = args

    // Step 1: RequiredNodesValidator (+ console.warn for warnings, INFO-5 compliant).
    // INFO-3: this validator call migrates with the core function (single source).
    const validator = new RequiredNodesValidator()
    const validationResult = validator.validate(dagConfig)

    if (!validationResult.valid) {
      const errorsText = validationResult.errors.map((e, i) => `${i + 1}. ${e}`).join("\n")
      return yield* Effect.fail(new Error(`Invalid workflow configuration:\n${errorsText}`))
    }

    if (validationResult.warnings.length > 0) {
      const warningsText = validationResult.warnings.map((w, i) => `⚠️ ${w}`).join("\n")
      console.warn(`Workflow configuration warnings:\n${warningsText}`)
    }

    // Step 2: fail-fast worker_type validation (in core — single source).
    yield* validateWorkerTypes(agentService, dagConfig.nodes)

    // Step 3: DB createWorkflow row (iron law #4: persist first).
    const workflow = yield* dagSessionService.createWorkflow({
      chatSessionId,
      name: dagConfig.name,
      config: dagConfig,
    })

    // Step 4: DB createNode rows with namespaced IDs `${workflowId}::${cfg.id}`.
    for (const cfg of dagConfig.nodes) {
      yield* dagSessionService.createNode({
        workflowId: workflow.id,
        nodeId: `${workflow.id}::${cfg.id}`,
        name: cfg.name,
        nodeName: cfg.name,
        nodeType: cfg.worker_type,
        config: cfg,
        dependencyNodes: (cfg.dependencies ?? []).map((d: string) => `${workflow.id}::${d}`),
        timeoutMs: cfg.timeout_ms,
        retryCount: 0,
        maxRetries: cfg.retry?.max_attempts ?? 0,
      })
    }

    // Step 5: Build engine + inject promptOps.
    const workflowEngine = yield* WorkflowEngine.make
    workflowEngine.setPromptOps(promptOps)
    const executor: WorkflowExecutor = createWorkflowExecutor(workflowEngine, dagConfig)

    // Step 6: Register engine in module-level registry + startWorkflow (status→running + scheduleReadyNodes).
    // All state changes go through the engine's state-machine API (architecture constraint 5).
    registerEngine(workflow.id, workflowEngine)
    yield* workflowEngine.startWorkflow(workflow.id, dagConfig)

    // Step 7a: Fork the executor daemon (BEFORE abort listener — constraint 3).
    // Daemon is guaranteed reachable when cancelWorkflow is dispatched below.
    yield* executor.start(workflow.id).pipe(Effect.forkDetach)

    // Step 7b: Abort listener (AFTER forkDetach — constraint 3).
    // Triggers engine.cancelWorkflow via fire-and-forget Effect.runPromise.
    const onAbort = () => {
      Effect.runPromise(workflowEngine.cancelWorkflow(workflow.id).pipe(Effect.ignore))
    }
    abortSignal.addEventListener("abort", onAbort, { once: true })

    return { workflowId: workflow.id, nodeCount: dagConfig.nodes.length }
  })
