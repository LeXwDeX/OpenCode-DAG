// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * @file TDZ Import Smoke Test
 * @description Preventive hardening — verify that importing high-risk modules
 *              (those with cross-layer eager imports) does not trigger a
 *              Temporal Dead Zone (TDZ) ReferenceError at module evaluation time.
 *              Regression guard: fires if a future refactor re-introduces a TDZ
 *              cycle between layer assemblies.
 */

import { describe, expect, test } from "bun:test"

describe("TDZ import smoke", () => {
  test("share/session defaultLayer import does not trigger TDZ", async () => {
    const mod = await import("@/share/session")
    expect(mod.defaultLayer).toBeDefined()
  })

  test("worktree appLayer import does not trigger TDZ", async () => {
    const mod = await import("@/worktree")
    expect(mod.appLayer).toBeDefined()
  })

  // CoreLayer is a private const in app-runtime.ts — not exported.
  // We use the public AppRuntime export to verify the module evaluates without TDZ.
  test("effect/app-runtime import does not trigger TDZ", async () => {
    const mod = await import("@/effect/app-runtime")
    expect(mod.AppRuntime).toBeDefined()
  })

  test("dag/layer defaultLayer import does not trigger TDZ", async () => {
    const mod = await import("@/dag/layer")
    expect(mod.defaultLayer).toBeDefined()
  })
})
