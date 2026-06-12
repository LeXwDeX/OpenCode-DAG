// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

import { Context, Effect, Layer } from "effect"
import { DAGQuery } from "./query/dag-query"
import { DAGSessionService, setEventBus } from "./session/session-service"
import { recoverOrphanedWorkflows } from "./session/recovery"
import { EventBus } from "./state-machine/EventBus"
import { WorktreeManager } from "./worktree-manager/WorktreeManager"
import { WorktreeManagerTag } from "./worktree-manager/tags"
import { SessionPrompt } from "@/session/prompt"
import type { PromptOps } from "@/session/prompt-ops"

// ── Service Tags ──

export class DAGQueryTag extends Context.Service<DAGQueryTag, DAGQuery>()("@opencode/DAGQuery") {}

export class SharedEventBusTag extends Context.Service<SharedEventBusTag, EventBus>()("@opencode/SharedDAGEventBus") {}

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
//
// WP-A1 (009-dag-capability-expansion.md §7): also yields SessionPrompt.Service
// so the recovery assembly context can hand headless `promptOps` to resumed
// orphan-workflow engines (WP-A2). The capability reference is obtained here
// but never invoked eagerly — only passed downstream by WP-A2.
const dagQueryLayer = Layer.effect(
  DAGQueryTag,
  Effect.gen(function* () {
    const bus = yield* SharedEventBusTag
    // Ensure event bus is mounted (idempotent: same bus if layer re-runs via memo)
    setEventBus(bus)
    const sessionService = yield* DAGSessionService.make
    // WP-A1: acquire headless promptOps capability for recovery continuation.
    // The reference is held but NOT invoked (WP-A1 boundary: no eager prompt).
    // WP-A2: adapt SessionPrompt.Interface → PromptOps by picking the 4 required
    // methods. The `prompt` method's error channel (Image.Error) is widened via
    // structural cast — the consumer (spawnReadyNode) catches all errors via
    // Effect.catchCause anyway, so the narrower error type is safe.
    const _promptSvc = yield* SessionPrompt.Service
    const recoveryPromptOps: PromptOps = {
      cancel: _promptSvc.cancel,
      resolvePromptParts: _promptSvc.resolvePromptParts,
      prompt: _promptSvc.prompt as PromptOps["prompt"],
      loop: _promptSvc.loop,
    }
    // B3 / WP-A2 crash recovery: scan for orphaned running workflows (no in-memory engine).
    // With promptOps (WP-A2): attempts engine rebuild + daemon restart for each orphan.
    // Without promptOps (legacy): marks orphans failed with audit violations.
    yield* recoverOrphanedWorkflows(sessionService, recoveryPromptOps).pipe(
      Effect.tapError(err => Effect.logWarning(`[DAG recovery] top-level failure (non-fatal): ${err}`)),
      Effect.ignore,
    )
    return new DAGQuery(sessionService)
  }),
)

/**
 * `defaultLayer` composes 3 sub-layers via `Layer.provideMerge` (inner → outer):
 *
 * 1. `dagQueryLayer` — creates DAGQuery and runs the crash recovery scan (B3)
 *    on initialization. Recovery runs here (not in app-runtime.ts CoreLayer)
 *    because DAG is HTTP-server-scoped while CoreLayer is process-wide.
 *    See B3 commit message for rationale.
 * 2. `worktreeManagerLayer` — creates a single WorktreeManager instance (uses
 *    the shared EventBus). Consumed by `spawnReadyNode` when
 *    `worker_config.use_worktree: true` (B4-WP1). No persister is provided:
 *    an in-memory Map is adequate for DAG node lifetime (per §0.3 architecture
 *    rule — node lifetime is bounded by workflow lifetime).
 * 3. `sharedEventBusLayer` — the OUTERMOST provider: creates the singleton
 *    EventBus (Iron Law #3) and feeds it to BOTH layers above as a whole.
 *
 * WP-A1 requirement (009-dag-capability-expansion.md §7): `dagQueryLayer`
 * additionally yields `SessionPrompt.Service` so recovery can hand headless
 * `promptOps` to resumed orphan-workflow engines (WP-A2). This adds a heavy
 * transitive requirement graph (~20 services via `SessionPrompt.defaultLayer`);
 * memoization within the top-level Layer build guarantees the same instances
 * shared with other consumers (server.ts flat-array provides the same
 * `SessionPrompt.defaultLayer` by reference).
 *
 * The HTTP server provides this `defaultLayer` in
 * `server/routes/instance/httpapi/server.ts:245`. CLI modes that do not start
 * the HTTP server (e.g., `opencode run`) obtain `DAGSessionService` directly
 * but lose recovery, bridge, and WorktreeManager availability.
 */
// Self-contained composite: `sharedEventBusLayer` sits at the OUTERMOST
// provider position, so the singleton bus feeds dagQueryLayer AND
// worktreeManagerLayer as a whole — the result outputs all tags with zero
// residual requirement. Lesson (CI fix): a layer in provider position is
// never back-fed by the outputs of the composite it provides to (the previous
// order left worktreeManagerLayer's bus requirement dangling), and the
// terminal cast in server.ts erases residual exposure from the type — the
// compile-time anchor in layer-session-prompt.test.ts guards this order.
// `Layer.mergeAll` does not cross-wire siblings either, which previously
// left SharedEventBusTag unsatisfied at runtime ("Service not found").
//
// WP-A1 (INFO 2 resolution): SessionPrompt.Service is satisfied explicitly via
// `Layer.provide(SessionPrompt.defaultLayer)` below — NOT via the flat array
// in server.ts, which does not cross-wire siblings. Effect memoization ensures
// the same `SessionPrompt.defaultLayer` instance is shared across the build.
// D-TDZ-DEFENSE (design-only): SessionPrompt.defaultLayer has participated in
// historical DAG import cycles. If smoke tests regress, first try Layer.suspend
// around the smallest DAG layer boundary; use leaf tag extraction only when an
// eagerly accessed Context.Service/tag causes the cycle.
export const defaultLayer = dagQueryLayer.pipe(
  Layer.provideMerge(worktreeManagerLayer),
  Layer.provideMerge(sharedEventBusLayer),
  // WP-A1: explicitly satisfy SessionPrompt.Service requirement. Must be
  // `Layer.provide` (consumes the requirement) so defaultLayer remains
  // self-contained with zero residual requirement.
  Layer.provide(SessionPrompt.defaultLayer),
)
