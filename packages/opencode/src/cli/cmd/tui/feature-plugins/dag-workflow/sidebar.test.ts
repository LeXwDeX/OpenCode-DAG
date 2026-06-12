/**
 * WP4 sidebar.tsx tests
 *
 * Tests:
 * - WORKFLOW_STATUSES: exported constant covers all valid statuses
 * - workflowStatusIcon: returns correct icons for each status
 */
import { describe, it, expect } from "bun:test"
import { WORKFLOW_STATUSES, workflowStatusIcon } from "./sidebar"
import type { DAGWorkflowStatus } from "@/dag/session/types"

describe("WP4 sidebar — WORKFLOW_STATUSES", () => {
  it("is an array with all valid workflow statuses", () => {
    expect(Array.isArray(WORKFLOW_STATUSES)).toBe(true)
    const allStatuses: DAGWorkflowStatus[] = [
      "pending",
      "running",
      "completed",
      "failed",
      "cancelled",
      "paused",
    ]
    for (const s of allStatuses) {
      expect(WORKFLOW_STATUSES).toContain(s)
    }
  })

  it("has exactly 6 statuses", () => {
    expect(WORKFLOW_STATUSES).toHaveLength(6)
  })
})

describe("WP4 sidebar — workflowStatusIcon", () => {
  it("returns * for running", () => {
    expect(workflowStatusIcon("running")).toBe("*")
  })

  it("returns + for completed", () => {
    expect(workflowStatusIcon("completed")).toBe("+")
  })

  it("returns x for failed", () => {
    expect(workflowStatusIcon("failed")).toBe("x")
  })

  it("returns - for cancelled", () => {
    expect(workflowStatusIcon("cancelled")).toBe("-")
  })

  it("returns o for pending", () => {
    expect(workflowStatusIcon("pending")).toBe("o")
  })

  it("covers all workflow statuses with pure-ASCII icons", () => {
    const allStatuses: DAGWorkflowStatus[] = [
      "pending",
      "running",
      "completed",
      "failed",
      "cancelled",
      "paused",
    ]
    for (const s of allStatuses) {
      const icon = workflowStatusIcon(s)
      expect(typeof icon).toBe("string")
      expect(icon.length).toBeGreaterThan(0)
      // WP-1 BUG-3: EA-Ambiguous glyphs garble in CJK terminals; icons must stay ASCII
      for (const ch of icon) {
        expect(ch.codePointAt(0)!).toBeLessThan(0x80)
      }
    }
  })

  it("returns = for paused", () => {
    expect(workflowStatusIcon("paused")).toBe("=")
  })
})
