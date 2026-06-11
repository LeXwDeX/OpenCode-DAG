/**
 * control-bar.tsx tests (TDD ②)
 *
 * Pure-function coverage for the status → enabled-actions gating that drives
 * ControlBar rendering. Mirrors the sidebar.test.ts / node-dialog.test.ts
 * pattern (export pure helpers, assert their outputs) since the TUI render
 * tree is not unit-rendered in this suite.
 *
 * Acceptance:
 * - running  → pause + cancel + replan enabled; resume disabled
 * - paused   → resume + cancel enabled; pause + replan disabled
 * - terminal (completed/failed/cancelled) + pending → every action disabled
 */
import { describe, it, expect } from "bun:test"
import { controlBarActions, parseReplanConcurrency } from "./control-bar"
import type { DAGWorkflowStatus } from "@/dag/session/types"

describe("ControlBar — controlBarActions gating", () => {
  it("running enables pause, cancel, replan (not resume, not step)", () => {
    expect(controlBarActions("running")).toEqual({
      start: false,
      pause: true,
      resume: false,
      cancel: true,
      replan: true,
      step: false,
    })
  })

  it("paused enables resume, cancel, step (not pause, not replan)", () => {
    expect(controlBarActions("paused")).toEqual({
      start: false,
      pause: false,
      resume: true,
      cancel: true,
      replan: false,
      step: true,
    })
  })

  it("terminal statuses disable every action (irreversible)", () => {
    const terminal: DAGWorkflowStatus[] = ["completed", "failed", "cancelled"]
    for (const s of terminal) {
      expect(controlBarActions(s)).toEqual({
        start: false,
        pause: false,
        resume: false,
        cancel: false,
        replan: false,
        step: false,
      })
    }
  })

  it("pending exposes start only", () => {
    expect(controlBarActions("pending")).toEqual({
      start: true,
      pause: false,
      resume: false,
      cancel: false,
      replan: false,
      step: false,
    })
  })
})

describe("ControlBar — parseReplanConcurrency (replan range guard)", () => {
  it("accepts a valid integer in 1..10", () => {
    expect(parseReplanConcurrency("5")).toEqual({ ok: true, value: 5 })
  })

  it("accepts the lower bound 1", () => {
    expect(parseReplanConcurrency("1")).toEqual({ ok: true, value: 1 })
  })

  it("accepts the upper bound 10", () => {
    expect(parseReplanConcurrency("10")).toEqual({ ok: true, value: 10 })
  })

  it("rejects 0 (below range)", () => {
    expect(parseReplanConcurrency("0")).toEqual({ ok: false })
  })

  it("rejects 11 (above range)", () => {
    expect(parseReplanConcurrency("11")).toEqual({ ok: false })
  })

  it("rejects a non-numeric string", () => {
    expect(parseReplanConcurrency("abc")).toEqual({ ok: false })
  })

  it("rejects a non-integer value", () => {
    expect(parseReplanConcurrency("5.5")).toEqual({ ok: false })
  })

  it("rejects an empty string (Number(\"\") === 0, below range)", () => {
    expect(parseReplanConcurrency("")).toEqual({ ok: false })
  })

  it("rejects a negative integer", () => {
    expect(parseReplanConcurrency("-3")).toEqual({ ok: false })
  })

  it("rejects whitespace-padded garbage", () => {
    expect(parseReplanConcurrency("  ")).toEqual({ ok: false })
  })
})

/**
 * WP4-A: actionLoading is a render-only concern — the pure status → actions
 * map is untouched by loading state. This test pins that invariant so a future
 * refactor cannot accidentally couple controlBarActions to loading.
 *
 * (Render-level coverage — dimmed fg, "..." suffix, onMouseUp gated — requires
 * an @opentui/solid test renderer and is deferred to the verify suite.)
 */
describe("WP4-A: ControlBar loading does not affect controlBarActions", () => {
  it("running status still yields pause+cancel+replan regardless of loading", () => {
    const actions = controlBarActions("running")
    expect(actions.pause).toBe(true)
    expect(actions.cancel).toBe(true)
    expect(actions.replan).toBe(true)
    expect(actions.start).toBe(false)
    expect(actions.resume).toBe(false)
    expect(actions.step).toBe(false)
  })

  it("paused status still yields resume+cancel+step regardless of loading", () => {
    const actions = controlBarActions("paused")
    expect(actions.resume).toBe(true)
    expect(actions.cancel).toBe(true)
    expect(actions.step).toBe(true)
    expect(actions.pause).toBe(false)
    expect(actions.replan).toBe(false)
    expect(actions.start).toBe(false)
  })

  it("pending status still yields start regardless of loading", () => {
    const actions = controlBarActions("pending")
    expect(actions.start).toBe(true)
    expect(actions.pause).toBe(false)
    expect(actions.resume).toBe(false)
    expect(actions.cancel).toBe(false)
    expect(actions.replan).toBe(false)
    expect(actions.step).toBe(false)
  })
})
