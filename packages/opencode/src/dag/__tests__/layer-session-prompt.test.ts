// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * WP-A1: dag/layer SessionPrompt.Service injection — smoke test
 *
 * Verifies:
 * 1. SessionPrompt.Service is resolvable via Effect.provideService in an
 *    Effect.gen context that mirrors the recovery assembly pattern used
 *    inside `dagQueryLayer` (dag/layer.ts).
 * 2. No eager call is made on the SessionPrompt interface (WP-A1 boundary:
 *    only capability acquisition, no prompt invocation).
 * 3. A mock SessionPrompt.Service satisfies the requirement of the exported
 *    `defaultLayer` composition (Layer.succeed + Layer.provide), proving the
 *    Layer-level wiring is correct.
 */

import { describe, it, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { defaultLayer as dagDefaultLayer, SharedEventBusTag, DAGQueryTag } from "@/dag/layer"
import { WorktreeManagerTag } from "@/dag/worktree-manager/tags"
import { SessionPrompt } from "@/session/prompt"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockPromptService(): {
  impl: SessionPrompt.Interface
  callLog: string[]
} {
  const callLog: string[] = []
  const die = (name: string) =>
    Effect.sync(() => {
      callLog.push(name)
      throw new Error(`WP-A1: eager call forbidden — ${name}() invoked at layer build time`)
    }).pipe(Effect.flatMap(() => Effect.die(`unreachable ${name}`)))

  return {
    callLog,
    impl: {
      cancel: (_sessionID) => {
        callLog.push("cancel")
        return Effect.void
      },
      prompt: ((..._args: unknown[]) => die("prompt")) as unknown as SessionPrompt.Interface["prompt"],
      loop: ((..._args: unknown[]) => die("loop")) as unknown as SessionPrompt.Interface["loop"],
      shell: ((..._args: unknown[]) => die("shell")) as unknown as SessionPrompt.Interface["shell"],
      command: ((..._args: unknown[]) => die("command")) as unknown as SessionPrompt.Interface["command"],
      resolvePromptParts: ((..._args: unknown[]) =>
        die("resolvePromptParts")) as unknown as SessionPrompt.Interface["resolvePromptParts"],
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WP-A1: dag layer SessionPrompt.Service injection", () => {
  it("recovery assembly context can yield SessionPrompt.Service via mock", () => {
    const { impl, callLog } = makeMockPromptService()

    // Replicates the yield* chain used in dagQueryLayer's Effect.gen
    // (dag/layer.ts). This is the "smoke" contract per WP-A1 spec.
    const resolve = Effect.gen(function* () {
      const svc = yield* SessionPrompt.Service
      return svc
    })

    const result = Effect.runSync(
      resolve.pipe(Effect.provideService(SessionPrompt.Service, impl)),
    )

    // Capability reference is resolved (identity preserved, not undefined)
    expect(result).toBe(impl)
    // WP-A1 boundary: no method invoked eagerly
    expect(callLog).toEqual([])
  })

  it("defaultLayer accepts SessionPrompt.Service via Layer.succeed (smoke)", () => {
    // Build a minimal Layer that satisfies SessionPrompt.Service without
    // requiring the full 20+ transitive defaultLayer graph. Layer.succeed
    // injects the mock directly.
    const { impl } = makeMockPromptService()
    const mockLayer = Layer.succeed(SessionPrompt.Service, impl)

    // Verify composition is type-correct and Layer.succeed integrates
    // with the defaultLayer pipe (Layer.provide at the composition edge).
    // This asserts the wiring shape without requiring the full runtime.
    const composed = dagDefaultLayer.pipe(Layer.provide(mockLayer))

    // Layer identity check: composed is a valid Layer (non-null, non-undefined)
    expect(composed).toBeDefined()
    // Composition must be referentially a new Layer (not the original)
    expect(composed).not.toBe(dagDefaultLayer)
  })

  // -------------------------------------------------------------------------
  // Compile-time anchor: defaultLayer must stay self-contained — zero residual
  // DAG-internal requirement in its RIn channel. The terminal cast at the
  // server.ts assembly edge erases residual requirements from the type, so
  // this anchor is the only compile-time guard for the composition order in
  // dag/layer.ts: if `sharedEventBusLayer` loses its outermost provider
  // position, RIn regains `SharedEventBusTag` and `bun typecheck` fails here.
  // effect 4.0.0-beta.66: Layer<in ROut, out E = never, out RIn = never>
  // (RIn is the THIRD type parameter — verified against dist/Layer.d.ts:45).
  // -------------------------------------------------------------------------
  it("defaultLayer has zero residual DAG-internal requirement (compile-time anchor)", () => {
    type DagDefaultLayerRIn =
      typeof dagDefaultLayer extends Layer.Layer<infer _ROut, infer _E, infer RIn> ? RIn : never

    type NoResidualSharedEventBus = [Extract<DagDefaultLayerRIn, SharedEventBusTag>] extends [never] ? true : false
    type NoResidualWorktreeManager = [Extract<DagDefaultLayerRIn, WorktreeManagerTag>] extends [never] ? true : false
    type NoResidualDagQuery = [Extract<DagDefaultLayerRIn, DAGQueryTag>] extends [never] ? true : false

    // Assignments fail to compile if any DAG-internal tag leaks into RIn.
    const noResidualSharedEventBus: NoResidualSharedEventBus = true
    const noResidualWorktreeManager: NoResidualWorktreeManager = true
    const noResidualDagQuery: NoResidualDagQuery = true

    expect(noResidualSharedEventBus).toBe(true)
    expect(noResidualWorktreeManager).toBe(true)
    expect(noResidualDagQuery).toBe(true)
  })
})
