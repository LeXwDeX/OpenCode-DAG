// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * DagEventBridge Effect Layer
 *
 * Manages DagEventBridge lifecycle: subscribe on acquire, dispose on release.
 * Translates DAG IEventBus events into platform Bus events (read-only, §9.a).
 */

import { Bus } from "@/bus"
import type { BusEvent } from "@/bus/bus-event"
import { InstanceRef } from "@/effect/instance-ref"
import { Context, Effect, Layer, Option } from "effect"
import { DagEventBridge } from "./dag-bus-bridge"
import * as DagEvents from "./dag-events"
import { SharedEventBusTag } from "../layer"

// ── Service Tag ──

export class DagEventBridgeTag extends Context.Service<DagEventBridgeTag, DagEventBridge>()(
  "@opencode/DagEventBridge",
) {}

// ── Event type → BusEvent definition map ──

const eventDefMap: Record<string, BusEvent.Definition> = {
  "dag.workflow.updated": DagEvents.DagWorkflowUpdated,
  "dag.node.updated": DagEvents.DagNodeUpdated,
  "dag.node.progress": DagEvents.DagNodeProgress,
  "dag.node.ask_main": DagEvents.DagNodeAskMain,
}

// ── Layer: lifecycle managed via Effect.addFinalizer ──

export const defaultLayer = Layer.effect(
  DagEventBridgeTag,
  Effect.gen(function* () {
    const dagBus = yield* SharedEventBusTag
    const busSvc = yield* Bus.Service
    const instanceRef = Option.getOrUndefined(yield* Effect.serviceOption(InstanceRef))

    const bridge = new DagEventBridge(dagBus)

    // Wire: DAG IEventBus → platform Bus (fire-and-forget, read-only §9.a)
    bridge.subscribe((type, props) => {
      const def = eventDefMap[type]
      if (!def) return
      const publishEffect = busSvc.publish(def, props as Record<string, unknown>)
      const withContext = instanceRef
        ? publishEffect.pipe(Effect.provideService(InstanceRef, instanceRef))
        : publishEffect
      Effect.runFork(withContext.pipe(Effect.catchCause(() => Effect.void)))
    })

    yield* Effect.addFinalizer(() => Effect.sync(() => bridge.dispose()))
    return bridge
  }),
)
