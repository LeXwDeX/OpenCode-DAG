import { describe, expect, it } from "bun:test"
import { formatHistoryDetails, formatHistoryTime } from "./history-panel"

describe("WP4 WorkflowHistoryPanel — helpers", () => {
  it("formats empty timestamps as '-'", () => {
    expect(formatHistoryTime(null)).toBe("-")
    expect(formatHistoryTime(undefined)).toBe("-")
  })

  it("formats ISO timestamps deterministically", () => {
    expect(formatHistoryTime("2026-01-01T00:00:00.000Z")).toBe("2026-01-01T00:00:00.000Z")
  })

  it("formats object details as JSON", () => {
    expect(formatHistoryDetails({ added: ["n2"] })).toBe('{"added":["n2"]}')
  })

  it("truncates long details", () => {
    const result = formatHistoryDetails("x".repeat(2_100))
    expect(result.length).toBeLessThanOrEqual(2_001)
    expect(result.endsWith("…")).toBe(true)
  })
})
