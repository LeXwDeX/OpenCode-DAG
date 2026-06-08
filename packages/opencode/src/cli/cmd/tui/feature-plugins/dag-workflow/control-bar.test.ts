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
  it("running enables pause, cancel, replan (not resume)", () => {
    expect(controlBarActions("running")).toEqual({
      pause: true,
      resume: false,
      cancel: true,
      replan: true,
    })
  })

  it("paused enables resume, cancel (not pause, not replan)", () => {
    expect(controlBarActions("paused")).toEqual({
      pause: false,
      resume: true,
      cancel: true,
      replan: false,
    })
  })

  it("terminal statuses disable every action (irreversible)", () => {
    const terminal: DAGWorkflowStatus[] = ["completed", "failed", "cancelled"]
    for (const s of terminal) {
      expect(controlBarActions(s)).toEqual({
        pause: false,
        resume: false,
        cancel: false,
        replan: false,
      })
    }
  })

  it("pending disables every action (not yet started)", () => {
    expect(controlBarActions("pending")).toEqual({
      pause: false,
      resume: false,
      cancel: false,
      replan: false,
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
