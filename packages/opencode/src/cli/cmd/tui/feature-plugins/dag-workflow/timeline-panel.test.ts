/**
 * TimelinePanel — unit tests for formatTime / formatEventDuration
 *
 * Added post-WP-1 to close the review INFO gap (timeline-panel.tsx formerly
 * returned — U+2014 EA=Ambiguous for invalid timestamps).
 */
import { describe, expect, it } from "bun:test"
import { formatTime, formatEventDuration } from "./timeline-panel"

describe("formatTime", () => {
  it("returns GLYPH.emDash (-) for null", () => {
    expect(formatTime(null)).toBe("-")
  })
  it("returns GLYPH.emDash (-) for undefined", () => {
    expect(formatTime(undefined)).toBe("-")
  })
  it("returns GLYPH.emDash (-) for NaN / Infinity", () => {
    expect(formatTime(Number.NaN)).toBe("-")
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe("-")
  })
  it("returns GLYPH.emDash (-) when Date constructor yields Invalid Date (> ±8.64e15)", () => {
    // ECMAScript only accepts timestamps within ±8.64e15 ms; beyond that, new
    // Date returns Invalid Date and formatTime falls through to emDash.
    expect(formatTime(9e15)).toBe("-")
    expect(formatTime(-9e15)).toBe("-")
  })
  it("formats epoch ms to HH:MM:SS UTC", () => {
    // 2024-01-02T03:04:05Z = 1704164645000
    expect(formatTime(1704164645000)).toBe("03:04:05")
  })
  it("pads single-digit HH:MM:SS", () => {
    // 1970-01-01T00:00:09Z
    expect(formatTime(9000)).toBe("00:00:09")
  })

  // WP-1 glyph guard: formatTime output must contain no EA-Ambiguous chars.
  it("formatTime output is pure ASCII (no \\u2014 or other EA-Ambiguous)", () => {
    const outputs = [
      formatTime(null),
      formatTime(undefined),
      formatTime(Number.NaN),
      formatTime(0),
      formatTime(1704164645000),
    ]
    for (const out of outputs) {
      for (const ch of out) {
        const cp = ch.codePointAt(0)!
        const isAmbiguousOrDecorative =
          cp >= 0x80 &&
          (cp === 0x2014 ||
            cp === 0x2013 ||
            cp === 0x2026 ||
            cp === 0x2502 ||
            cp === 0x2500 ||
            cp === 0x2514 ||
            cp === 0x251c)
        expect(isAmbiguousOrDecorative).toBe(false)
      }
    }
  })
})

describe("formatEventDuration", () => {
  it("< 1s → Xms", () => {
    expect(formatEventDuration(0)).toBe("0ms")
    expect(formatEventDuration(450)).toBe("450ms")
    expect(formatEventDuration(999)).toBe("999ms")
  })
  it("1s..60s → X.Xs", () => {
    expect(formatEventDuration(1000)).toBe("1.0s")
    expect(formatEventDuration(1500)).toBe("1.5s")
    expect(formatEventDuration(59999)).toBe("60.0s")
  })
  it(">= 60s → Xm Xs", () => {
    expect(formatEventDuration(60000)).toBe("1m 0s")
    expect(formatEventDuration(125000)).toBe("2m 5s")
  })
  it("formatEventDuration output is pure ASCII", () => {
    for (const v of [0, 450, 1000, 60000, 125000]) {
      for (const ch of formatEventDuration(v)) {
        expect(ch.codePointAt(0)! < 0x80).toBe(true)
      }
    }
  })
})
