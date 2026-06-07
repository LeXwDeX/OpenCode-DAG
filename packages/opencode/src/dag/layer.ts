// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

import { Context, Effect, Layer } from "effect"
import { DAGQuery } from "./query/dag-query"
import { DAGSessionService, setEventBus } from "./session/session-service"
import { recoverOrphanedWorkflows } from "./session/recovery"
import { EventBus } from "./state-machine/EventBus"
import type { IWorktreeManager } from "./worktree-manager/IWorktreeManager"
import { WorktreeManager } from "./worktree-manager/WorktreeManager"

// ── Service Tags ──

export class DAGQueryTag extends Context.Service<DAGQueryTag, DAGQuery>()("@opencode/DAGQuery") {}

export class SharedEventBusTag extends Context.Service<SharedEventBusTag, EventBus>()("@opencode/SharedDAGEventBus") {}

export class WorktreeManagerTag extends Context.Service<WorktreeManagerTag, IWorktreeManager>()("@opencode/DAGWorktreeManager") {}

// ── Layer: idempotent via Effect Layer memo map ──

// Shared EventBus singleton. Exposed as its own layer so bridge-layer can
// subscribe to the *same* instance (Iron Law #3). When this layer object is
// referenced in multiple places of the same build, Effect memoizes it by
// reference -> the EventBus is constructed exactly once.
export const sharedEventBusLayer = Layer.effect(
  SharedEventBusTag,
  Effect.sync(() => {
    const bus = new EventBus()
    // Mount to session-service module-level variable (Iron Law #3)
    setEventBus(bus)
    return bus
  }),
)

// WorktreeManager for optional per-node git worktree isolation.
// No persister provided (in-memory Map suffices for DAG node lifetime — §0.3).
export const worktreeManagerLayer = Layer.effect(
  WorktreeManagerTag,
  Effect.gen(function* () {
    const bus = yield* SharedEventBusTag
    return new WorktreeManager(bus)
  }),
)

// DAGQuery backed by DAGSessionService. Depends on SharedEventBusTag.
const dagQueryLayer = Layer.effect(
  DAGQueryTag,
  Effect.gen(function* () {
    const bus = yield* SharedEventBusTag
    // Ensure event bus is mounted (idempotent: same bus if layer re-runs via memo)
    setEventBus(bus)
    const sessionService = yield* DAGSessionService.make
    // B3 crash recovery: scan for orphaned running workflows (no in-memory engine)
    // and mark them failed with audit violations before the query layer becomes available.
    yield* recoverOrphanedWorkflows(sessionService).pipe(
      Effect.tapError(err => Effect.logWarning(`[DAG recovery] top-level failure (non-fatal): ${err}`)),
      Effect.ignore,
    )
    return new DAGQuery(sessionService)
  }),
)

/**
 * `defaultLayer` composes 3 sub-layers via `Layer.provideMerge`:
 *
 * 1. `sharedEventBusLayer` — creates the singleton EventBus (Iron Law #3)
 *    shared across all DAG modules.
 * 2. `worktreeManagerLayer` — creates a single WorktreeManager instance (uses
 *    the shared EventBus). Consumed by `spawnReadyNode` when
 *    `worker_config.use_worktree: true` (B4-WP1). No persister is provided:
 *    an in-memory Map is adequate for DAG node lifetime (per §0.3 architecture
 *    rule — node lifetime is bounded by workflow lifetime).
 * 3. `dagQueryLayer` — creates DAGQuery and runs the crash recovery scan (B3)
 *    on initialization. Recovery runs here (not in app-runtime.ts CoreLayer)
 *    because DAG is HTTP-server-scoped while CoreLayer is process-wide.
 *    See B3 commit message for rationale.
 *
 * The HTTP server provides this `defaultLayer` in
 * `server/routes/instance/httpapi/server.ts:245`. CLI modes that do not start
 * the HTTP server (e.g., `opencode run`) obtain `DAGSessionService` directly
 * but lose recovery, bridge, and WorktreeManager availability.
 */
// Self-contained composite: provideMerge feeds the shared bus INTO dagQueryLayer
// and re-exposes it, so the result outputs BOTH tags with zero residual
// requirement. `Layer.mergeAll` does not cross-wire siblings, which previously
// left SharedEventBusTag unsatisfied at runtime ("Service not found").
export const defaultLayer = dagQueryLayer.pipe(
  Layer.provideMerge(sharedEventBusLayer),
  Layer.provideMerge(worktreeManagerLayer),
)
