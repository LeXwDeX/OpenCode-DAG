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
    ]
    for (const s of allStatuses) {
      expect(WORKFLOW_STATUSES).toContain(s)
    }
  })

  it("has exactly 5 statuses", () => {
    expect(WORKFLOW_STATUSES).toHaveLength(5)
  })
})

describe("WP4 sidebar — workflowStatusIcon", () => {
  it("returns ● for running", () => {
    expect(workflowStatusIcon("running")).toBe("\u25cf")
  })

  it("returns ✓ for completed", () => {
    expect(workflowStatusIcon("completed")).toBe("\u2713")
  })

  it("returns ✗ for failed", () => {
    expect(workflowStatusIcon("failed")).toBe("\u2717")
  })

  it("returns ⊘ for cancelled", () => {
    expect(workflowStatusIcon("cancelled")).toBe("\u2298")
  })

  it("returns ○ for pending", () => {
    expect(workflowStatusIcon("pending")).toBe("\u25cb")
  })

  it("covers all workflow statuses", () => {
    const allStatuses: DAGWorkflowStatus[] = [
      "pending",
      "running",
      "completed",
      "failed",
      "cancelled",
    ]
    for (const s of allStatuses) {
      const icon = workflowStatusIcon(s)
      expect(typeof icon).toBe("string")
      expect(icon.length).toBeGreaterThan(0)
    }
  })
})
