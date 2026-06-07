// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

import { Context, Effect, Layer } from "effect"
import { DAGQuery } from "./query/dag-query"
import { DAGSessionService, setEventBus } from "./session/session-service"
import { EventBus } from "./state-machine/EventBus"

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

// DAGQuery backed by DAGSessionService. Depends on SharedEventBusTag.
const dagQueryLayer = Layer.effect(
  DAGQueryTag,
  Effect.gen(function* () {
    const bus = yield* SharedEventBusTag
    // Ensure event bus is mounted (idempotent: same bus if layer re-runs via memo)
    setEventBus(bus)
    const sessionService = yield* DAGSessionService.make
    return new DAGQuery(sessionService)
  }),
)

// Self-contained composite: provideMerge feeds the shared bus INTO dagQueryLayer
// and re-exposes it, so the result outputs BOTH tags with zero residual
// requirement. `Layer.mergeAll` does not cross-wire siblings, which previously
// left SharedEventBusTag unsatisfied at runtime ("Service not found").
export const defaultLayer = dagQueryLayer.pipe(Layer.provideMerge(sharedEventBusLayer))
