// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * WP-D3: Sub-DAG Lifecycle Bridge — Parent↔Child event subscription.
 *
 * When `spawnReadyNode` dispatches a `worker_type="dag"` node, the child
 * workflow runs independently. The parent node stays in "running" until the
 * child converges to a terminal state. This bridge subscribes to EventBus
 * events (`workflow.completed` / `workflow.failed` / `workflow.cancelled`) and
 * translates them to `handleNodeCompletion` / `handleNodeFailure` on the
 * parent engine — reusing the existing completion path (no new state-mutation
 * channel, iron laws #3/#4).
 *
 * Each entry is keyed by `parentNodeId` (globally unique namespaced ID). The
 * value carries the unsubscribes, the setTimeout ID, and the child workflow ID
 * (for the cancel cascade discovery). A single `cleanupSubscriptions` call
 * removes everything for that node — covering the 4 terminal paths:
 * completed / failed / cancelled / timeout.
 *
 * Extracted from workflow-engine.ts (Step 4) to isolate the sub-DAG
 * lifecycle concern from the main engine scheduling logic.
 */

import { Effect } from "effect"
import type { CreateViolationInput } from "./session-service"
import type { IEventBus } from "../state-machine/IStateMachine"

export interface SubdagSubscriptionState {
  unsubscribes: Array<() => void>
  timeoutId: ReturnType<typeof setTimeout> | undefined
  parentWorkflowId: string
  childWorkflowId: string
}

const subdagSubscriptions = new Map<string, SubdagSubscriptionState>()

/** @internal test-only — exposes module-private subdagSubscriptions map. */
export const __internal_subdagSubscriptions = (): Map<string, SubdagSubscriptionState> =>
  subdagSubscriptions

/**
 * Cancel all event subscriptions and the timeout timer for a parent node.
 * Idempotent — safe to call multiple times (second call is a no-op).
 *
 * Called from 4 paths (WP-D3 §7, INFO-4):
 *   1. `workflow.completed` handler (parent node completed)
 *   2. `workflow.failed` handler (parent node failed)
 *   3. `workflow.cancelled` handler (parent node failed-after-cancel)
 *   4. setTimeout fire (timeout fallback)
 */
export function cleanupSubscriptions(parentNodeId: string): void {
  const state = subdagSubscriptions.get(parentNodeId)
  if (!state) return
  if (state.timeoutId !== undefined) clearTimeout(state.timeoutId)
  for (const unsub of state.unsubscribes) unsub()
  subdagSubscriptions.delete(parentNodeId)
}

/**
 * Install the event-bridge for a sub-DAG lifecycle (WP-D3, §3.3 + §7 WP-D3).
 *
 * After `spawnReadyNode` dispatches a "dag" node and `bootstrapWorkflowFromConfig`
 * returns, this function subscribes to the child workflow's terminal events
 * and starts a timeout fallback timer. When either the event arrives or the
 * timer fires, the appropriate parent-node completion path is driven
 * (`handleNodeCompletion` / `handleNodeFailure`).
 *
 * Dependencies are passed as callbacks rather than captured from closure so
 * the bridge can be tested in isolation without going through `spawnReadyNode`.
 *
 * @param args.parentWorkflowId The parent workflow ID (consumer of the bridge).
 * @param args.parentNodeId The parent "dag" node ID (namespaced, subscription key).
 * @param args.childWorkflowId The child workflow ID (event-filter target).
 * @param args.timeoutMs Timeout in ms before the bridge fires "subdag_timeout".
 * @param args.eventBus The shared IEventBus instance (process-level singleton).
 * @param args.sessionService The session service (for creating timeout violations).
 * @param args.onChildCompleted Callback driven when the child reaches "completed".
 * @param args.onChildFailed Callback driven when the child reaches "failed" / "cancelled".
 * @param args.onCancelChild Callback driven on timeout to cancel the child workflow.
 * @param args.onCreateViolation Callback to create a DAGViolation row.
 */
export function installSubdagLifecycleBridge(args: {
  parentWorkflowId: string
  parentNodeId: string
  childWorkflowId: string
  timeoutMs: number
  eventBus: IEventBus
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessionService: any
  onChildCompleted: (workflowId: string, nodeId: string, output: unknown) => Effect.Effect<unknown>
  onChildFailed: (workflowId: string, nodeId: string, error: Error) => Effect.Effect<unknown>
  onCancelChild: (childWorkflowId: string) => Effect.Effect<unknown>
  onCreateViolation: (input: CreateViolationInput) => Effect.Effect<unknown>
}): void {
  const {
    parentWorkflowId,
    parentNodeId,
    childWorkflowId,
    timeoutMs,
    eventBus,
    onChildCompleted,
    onChildFailed,
    onCancelChild,
    onCreateViolation,
  } = args
  const unsubscribes: Array<() => void> = []

  // Idempotency guard: only act once per parent-node (prevents duplicate
  // state-machine transitions if a child event races with the timeout).
  let settled = false
  const settle = () => {
    if (settled) return false
    settled = true
    cleanupSubscriptions(parentNodeId)
    return true
  }

  // Subscribe to "workflow.completed" — child converged successfully
  unsubscribes.push(
    eventBus.subscribe("workflow.completed", (event) => {
      if ((event as { workflow_id: string }).workflow_id !== childWorkflowId) return
      if (!settle()) return
      Effect.runPromise(onChildCompleted(parentWorkflowId, parentNodeId, childWorkflowId).pipe(Effect.ignore))
    }),
  )

  // Subscribe to "workflow.failed"
  unsubscribes.push(
    eventBus.subscribe("workflow.failed", (event) => {
      if ((event as { workflow_id: string }).workflow_id !== childWorkflowId) return
      if (!settle()) return
      Effect.runPromise(
        onChildFailed(parentWorkflowId, parentNodeId, new Error("sub-workflow failed")).pipe(Effect.ignore),
      )
    }),
  )

  // Subscribe to "workflow.cancelled" — treated as a failure from the parent's
  // perspective (parent node marked failed, cascade skip downstream follows)
  unsubscribes.push(
    eventBus.subscribe("workflow.cancelled", (event) => {
      if ((event as { workflow_id: string }).workflow_id !== childWorkflowId) return
      if (!settle()) return
      Effect.runPromise(
        onChildFailed(parentWorkflowId, parentNodeId, new Error("sub-workflow cancelled")).pipe(Effect.ignore),
      )
    }),
  )

  // Timeout fallback: if no terminal event arrives within timeoutMs, fire the
  // violation + cancel child + fail parent node.
  const timeoutId = setTimeout(() => {
    if (!settle()) return
    Effect.runPromise(
      Effect.gen(function* () {
        yield* onCreateViolation({
          workflowId: parentWorkflowId,
          nodeId: parentNodeId,
          type: "subdag_timeout",
          severity: "error",
          message: `sub-DAG did not converge within ${timeoutMs}ms`,
          details: { timeoutMs, childWorkflowId },
        }).pipe(Effect.catchCause(() => Effect.void))
        yield* onCancelChild(childWorkflowId).pipe(Effect.catchCause(() => Effect.void))
        yield* onChildFailed(
          parentWorkflowId,
          parentNodeId,
          new Error(`sub-DAG timed out after ${timeoutMs}ms`),
        ).pipe(Effect.catchCause(() => Effect.void))
      }).pipe(Effect.ignore),
    )
  }, timeoutMs)

  subdagSubscriptions.set(parentNodeId, {
    unsubscribes,
    timeoutId,
    parentWorkflowId,
    childWorkflowId,
  })
}
