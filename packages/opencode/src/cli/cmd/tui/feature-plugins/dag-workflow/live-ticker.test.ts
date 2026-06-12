/**
 * WP4 live-ticker.tsx tests
 *
 * Tests:
 * - summarizePart: correct text extraction for text/tool/reasoning/etc part types
 */
import { describe, it, expect } from "bun:test"
import { summarizePart } from "./live-ticker"

describe("WP4 live-ticker — summarizePart", () => {
  it("returns null for step-start (not displayable)", () => {
    expect(summarizePart({ type: "step-start" })).toBeNull()
  })

  it("returns null for unknown type", () => {
    expect(summarizePart({ type: "unknown" })).toBeNull()
  })

  it("returns truncated text for text part", () => {
    const result = summarizePart({ type: "text", text: "Hello world from the assistant" })
    expect(result).toBeString()
    expect(result!.length).toBeLessThanOrEqual(60) // truncated with ...
    expect(result).toContain("Hello")
  })

  it("returns tool name for tool part", () => {
    const result = summarizePart({ type: "tool", tool: "Read", state: "completed" })
    expect(result).toBeString()
    expect(result).toContain("Read")
  })

  it("returns reasoning indicator for reasoning part", () => {
    const result = summarizePart({ type: "reasoning", text: "thinking hard" })
    expect(result).toBeString()
    expect(result!.length).toBeGreaterThan(0)
  })

  it("handles text part with long text (truncation)", () => {
    const longText = "x".repeat(200)
    const result = summarizePart({ type: "text", text: longText })
    expect(result).toBeString()
    expect(result!.length).toBeLessThan(200)
    // WP-1 BUG-3: ASCII truncation marker (was EA-Ambiguous …)
    expect(result!.endsWith("...")).toBe(true)
    expect(result).not.toContain("\u2026")
  })

  it("handles tool part with in-progress state", () => {
    const result = summarizePart({ type: "tool", tool: "Bash", state: "pending" })
    expect(result).toBeString()
    expect(result).toContain("Bash")
  })
})
