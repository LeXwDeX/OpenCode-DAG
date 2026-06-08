import { describe, expect, it } from "bun:test"
import { formatLogDetails, formatLogTime } from "./node-logs-panel"

describe("WP4 NodeLogsPanel — helpers", () => {
  it("formats empty timestamps as '-'", () => {
    expect(formatLogTime(null)).toBe("-")
    expect(formatLogTime(undefined)).toBe("-")
  })

  it("formats ISO timestamps deterministically", () => {
    expect(formatLogTime("2026-01-01T00:00:00.000Z")).toBe("2026-01-01T00:00:00.000Z")
  })

  it("combines message and structured data", () => {
    expect(formatLogDetails("started", { step: 1 })).toBe('started {"step":1}')
  })

  it("truncates long log details", () => {
    const result = formatLogDetails("x".repeat(2_100), null)
    expect(result.length).toBeLessThanOrEqual(2_001)
    expect(result.endsWith("…")).toBe(true)
  })
})
