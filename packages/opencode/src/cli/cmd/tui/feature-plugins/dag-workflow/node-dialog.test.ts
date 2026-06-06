/**
 * WP4 node-dialog.tsx tests
 *
 * Tests:
 * - nodeStatusLabel: maps status to human-readable label
 */
import { describe, it, expect } from "bun:test"
import { nodeStatusLabel } from "./node-dialog"
import type { DAGNodeStatus } from "@/dag/session/types"

describe("WP4 node-dialog — nodeStatusLabel", () => {
  it("returns 'Completed' for completed", () => {
    expect(nodeStatusLabel("completed")).toBe("Completed")
  })

  it("returns 'Running' for running", () => {
    expect(nodeStatusLabel("running")).toBe("Running")
  })

  it("returns 'Pending' for pending", () => {
    expect(nodeStatusLabel("pending")).toBe("Pending")
  })

  it("returns 'Queued' for queued", () => {
    expect(nodeStatusLabel("queued")).toBe("Queued")
  })

  it("returns 'Failed' for failed", () => {
    expect(nodeStatusLabel("failed")).toBe("Failed")
  })

  it("returns 'Skipped' for skipped", () => {
    expect(nodeStatusLabel("skipped")).toBe("Skipped")
  })

  it("covers all DAGNodeStatus values", () => {
    const allStatuses: DAGNodeStatus[] = [
      "pending",
      "queued",
      "running",
      "completed",
      "failed",
      "skipped",
    ]
    for (const s of allStatuses) {
      const label = nodeStatusLabel(s)
      expect(label).toBeString()
      expect(label.length).toBeGreaterThan(0)
    }
  })
})
