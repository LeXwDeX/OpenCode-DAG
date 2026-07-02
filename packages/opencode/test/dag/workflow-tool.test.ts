import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { Parameters } from "@/tool/workflow"

describe("workflow tool schema (negative tests)", () => {
  it("action field accepts start/extend/control", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() => decode({ action: "start", config: { name: "test", nodes: [], max_concurrency: 3 } })).not.toThrow()
    expect(() => decode({ action: "extend", workflow_id: "wf-1", nodes: [] })).not.toThrow()
    expect(() => decode({ action: "control", workflow_id: "wf-1", operation: "pause" })).not.toThrow()
  })

  it("action field rejects unknown actions", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() => decode({ action: "delete" })).toThrow()
    expect(() => decode({ action: "status" })).toThrow()
  })

  it("no node_complete action exists", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() => decode({ action: "node_complete" })).toThrow()
  })

  it("no read-only actions exist (status/list/history/logs)", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() => decode({ action: "status" })).toThrow()
    expect(() => decode({ action: "list" })).toThrow()
    expect(() => decode({ action: "history" })).toThrow()
    expect(() => decode({ action: "logs" })).toThrow()
  })

  it("control operation accepts pause/resume/cancel/replan/step/complete", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    for (const op of ["pause", "resume", "cancel", "replan", "step", "complete"]) {
      expect(() => decode({ action: "control", workflow_id: "wf-1", operation: op })).not.toThrow()
    }
  })

  it("control operation rejects unknown operations", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() => decode({ action: "control", workflow_id: "wf-1", operation: "delete" })).toThrow()
    expect(() => decode({ action: "control", workflow_id: "wf-1", operation: "start" })).toThrow()
  })
})
