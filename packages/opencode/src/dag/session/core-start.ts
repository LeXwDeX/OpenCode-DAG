// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * Headless workflow bootstrap — Tool.Context-free core startup function (WP-D1 core, WP-D2 sub-DAG).
 *
 * Single source for the workflow bootstrap sequence:
 *   0. Recursion depth check (WP-D2: depth > MAX_SUB_DAG_DEPTH → fail, INFO-3)
 *   1. RequiredNodesValidator validation (+ warnings via console.warn, INFO-5)
 *   2. validateWorkerTypes (agent registry resolution; "dag" skipped for WP-D2)
 *   3. DB createWorkflow row
 *   4. DB createNode rows (with namespaced IDs: `${workflowId}::${nodeId}`)
 *   5. WorkflowEngine.make + setPromptOps
 *   6. registerEngine + WorkflowEngine.startWorkflow (status→running + scheduleReadyNodes)
 *   7. forkDetach executor daemon (BEFORE abort listener) + abortSignal.addEventListener
 *
 * Called by:
 * - dagworker.ts (tool path) — thin adapter that destructures Tool.Context
 * - WP-D2 sub-DAG spawn — spawnReadyNode dispatches "dag" nodes via this
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
 * - WP-D2 adds parentWorkflowId/parentNodeId/depth optional params (additive,
 *   backward-compatible with dagworker.ts which does not pass them).
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
import { MAX_SUB_DAG_DEPTH } from "./limits"

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
 * WP-D2 sub-DAG dispatch:
 * - `worker_type === "dag"` is a **reserved word** — agent registry resolution
 *   is skipped (no Agent.Info lookup). Instead, each "dag" node must carry
 *   `worker_config.subDagConfig` (a valid DAGConfig). Missing → reject.
 * - **Reserved-word conflict**: if the agent registry contains an agent named
 *   "dag", validation fails. "dag" MUST NOT be a registered agent name.
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

    // WP-D2: reserved-word conflict — "dag" MUST NOT be registered as agent name.
    if (unique.includes("dag")) {
      const registered = yield* agentService.list().pipe(
        Effect.catchCause(() => Effect.succeed([] as Agent.Info[])),
      )
      if (registered.some((a) => a.name === "dag")) {
        return yield* Effect.fail(
          new Error(
            "Reserved worker_type conflict: 'dag' is reserved for sub-DAG dispatch and must not be registered as an agent name in opencode.json agent.*.",
          ),
        )
      }
    }

    const missing: string[] = []
    for (const workerType of unique) {
      // WP-D2: "dag" is a reserved word — skip agent registry resolution.
      // Validate subDagConfig presence instead (schema-level check).
      if (workerType === "dag") {
        const dagNodes = nodes.filter((n) => n.worker_type === "dag")
        for (const dn of dagNodes) {
          const subDag = (dn.worker_config as Record<string, unknown> | undefined)?.subDagConfig
          if (!subDag || typeof subDag !== "object") {
            return yield* Effect.fail(
              new Error(
                `worker_type="dag" requires worker_config.subDagConfig (DAGConfig) on node '${dn.id}'. Got: ${subDag === undefined ? "undefined" : typeof subDag}.`,
              ),
            )
          }
        }
        continue
      }

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
 * Tool.Context-free workflow bootstrap (WP-D1 core, WP-D2 sub-DAG entry).
 *
 * Single source for the full workflow startup sequence:
 *   Step 0 — recursion depth check (WP-D2, §3.3: depth > MAX_SUB_DAG_DEPTH = 3 → fail)
 *   Step 1 — RequiredNodesValidator
 *   Step 2 — validateWorkerTypes (WP-D2: "dag" skipped, subDagConfig validated)
 *   Step 3 — DB createWorkflow row
 *   Step 4 — DB createNode rows
 *   Step 5 — WorkflowEngine.make + setPromptOps
 *   Step 6 — registerEngine + startWorkflow
 *   Step 7a — forkDetach daemon; 7b — abortSignal listener (AFTER forkDetach, constraint 3)
 *
 * @param dagConfig         The DAG workflow configuration.
 * @param chatSessionId     The chat session under which the workflow is scoped.
 *                          For sub-DAG (WP-D2, INFO-5): the child session ID
 *                          created by spawnReadyNode via sessions.create().
 * @param promptOps         Prompt operations reference.
 * @param abortSignal       AbortSignal for cooperative cancellation.
 * @param dagSessionService DB session service (state persistence — iron law #4).
 * @param agentService      Agent registry for worker_type validation.
 * @param parentWorkflowId  Optional (WP-D2): parent workflow ID for sub-DAG context.
 * @param parentNodeId      Optional (WP-D2): parent node ID for sub-DAG context.
 * @param depth             Optional (WP-D2, INFO-3): current nesting depth (default 0).
 *                          Root workflow = 0. Sub-DAG at level 1 = 1. Limit = MAX_SUB_DAG_DEPTH (3).
 */
export const bootstrapWorkflowFromConfig = (args: {
  dagConfig: DAGConfig
  chatSessionId: string
  promptOps: PromptOps
  abortSignal: AbortSignal
  dagSessionService: IDAGSessionService
  agentService: WorkerTypeAgentRegistry
  parentWorkflowId?: string
  parentNodeId?: string
  depth?: number
}) =>
  Effect.gen(function* () {
    const {
      dagConfig,
      chatSessionId,
      promptOps,
      abortSignal,
      dagSessionService,
      agentService,
      parentWorkflowId,
      parentNodeId,
      depth = 0,
    } = args

    // Step 0: WP-D2 recursion depth check (§3.3: depth > MAX_SUB_DAG_DEPTH → fail).
    // Single source of truth for the depth cap (MAX_SUB_DAG_DEPTH from limits.ts).
    if (depth > MAX_SUB_DAG_DEPTH) {
      return yield* Effect.fail(
        new Error(
          `Sub-DAG recursion depth ${depth} exceeds maximum ${MAX_SUB_DAG_DEPTH} (§3.3). Refactor workflow to use fewer nesting levels.`,
        ),
      )
    }

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
      metadata: depth !== undefined ? { depth } : undefined, // WP-D2: sub-DAG depth propagation (§3.3)
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
