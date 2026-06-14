/**
 * WP-1 glyph robustness guard
 *
 * BUG-3 regression guard: EA-Ambiguous glyphs garble in CJK terminals
 * (engine measures Bun.stringWidth = 1 col, CJK terminals render 2 cols →
 * framebuffer misalignment, `·` becomes `□·□`). ⏸ is EA=Wide and misaligns
 * in ALL terminals.
 *
 * Contract:
 * - GLYPH exports + status icon maps + en dict + en labels: pure ASCII
 *   (every char < U+0080)
 * - zh dict + zh labels: zero EA-Ambiguous chars from the curated blacklist;
 *   CJK Wide/Fullwidth content (（），：。 etc.) is EXEMPT and must stay.
 *
 * Scans IMPORTED literals only — never raw file text (file headers are CJK
 * comments and would false-positive).
 */
import { describe, expect, it } from "bun:test"
import { GLYPH } from "./glyphs"
import {
  DICT,
  nodeStatusLabel,
  workflowStatusLabel,
  violationTypeLabel,
  violationSeverityLabel,
  type NodeStatus,
  type WorkflowStatus,
  type ViolationSeverity,
} from "./i18n"
import { NODE_STATUS_ICON, WORKFLOW_STATUS_ICON } from "./status"
import { DAG_VIOLATION_TYPES } from "@/dag/session/types"

/**
 * Curated EA=Ambiguous blacklist (plus the EA=Wide ⏸): every decorative glyph
 * formerly used by this plugin, plus common EA=A punctuation that sneaks into
 * translated copy.
 */
const EA_AMBIGUOUS_BLACKLIST = new Set([
  "\u2026", // … horizontal ellipsis
  "\u00b7", // · middle dot
  "\u2013", // – en dash
  "\u2014", // — em dash
  "\u2018", // ' left single quote
  "\u2019", // ' right single quote
  "\u201c", // " left double quote
  "\u201d", // " right double quote
  "\u2190", // ← leftwards arrow
  "\u2192", // → rightwards arrow
  "\u2194", // ↔ left right arrow
  "\u2713", // ✓ check mark
  "\u2717", // ✗ ballot x
  "\u25cf", // ● black circle
  "\u25ce", // ◎ bullseye
  "\u25cb", // ○ white circle
  "\u2298", // ⊘ circled division slash
  "\u23f8", // ⏸ pause (EA=Wide)
  "\u26a0", // ⚠ warning sign
  "\u25b6", // ▶ black right-pointing triangle
  "\u25a0", // ■ black square
  "\u25a1", // □ white square
  "\u2502", // │ box drawings vertical
  "\u2514", // └ box drawings up and right
  "\u251c", // ├ box drawings vertical and right
  "\u2500", // ─ box drawings horizontal
])

const NODE_STATUSES: NodeStatus[] = ["pending", "queued", "running", "completed", "failed", "skipped", "recoverable"]
const WORKFLOW_STATUSES: WorkflowStatus[] = ["pending", "running", "completed", "failed", "cancelled", "paused"]
const VIOLATION_SEVERITIES: ViolationSeverity[] = ["info", "warning", "error", "critical"]

function nonAsciiOffenders(entries: [string, string][]): string[] {
  return entries.flatMap(([key, value]) =>
    [...value]
      .filter((ch) => ch.codePointAt(0)! >= 0x80)
      .map((ch) => `${key}: U+${ch.codePointAt(0)!.toString(16).toUpperCase()} (${ch})`),
  )
}

function blacklistOffenders(entries: [string, string][]): string[] {
  return entries.flatMap(([key, value]) =>
    [...value]
      .filter((ch) => EA_AMBIGUOUS_BLACKLIST.has(ch))
      .map((ch) => `${key}: U+${ch.codePointAt(0)!.toString(16).toUpperCase()} (${ch})`),
  )
}

function zhLabelEntries(): [string, string][] {
  return [
    ...NODE_STATUSES.map((s): [string, string] => [`nodeStatus.${s}`, nodeStatusLabel("zh", s)]),
    ...WORKFLOW_STATUSES.map((s): [string, string] => [`workflowStatus.${s}`, workflowStatusLabel("zh", s)]),
    ...DAG_VIOLATION_TYPES.map((v): [string, string] => [`violationType.${v}`, violationTypeLabel("zh", v)]),
    ...VIOLATION_SEVERITIES.map((s): [string, string] => [`violationSeverity.${s}`, violationSeverityLabel("zh", s)]),
  ]
}

describe("WP-1 glyph guard — ASCII-only decorative glyphs", () => {
  it("every GLYPH export is pure ASCII", () => {
    expect(nonAsciiOffenders(Object.entries(GLYPH))).toEqual([])
  })

  it("node and workflow status icon maps are pure ASCII", () => {
    expect(nonAsciiOffenders(Object.entries(NODE_STATUS_ICON))).toEqual([])
    expect(nonAsciiOffenders(Object.entries(WORKFLOW_STATUS_ICON))).toEqual([])
  })

  it("en dict values are pure ASCII", () => {
    expect(nonAsciiOffenders(Object.entries(DICT.en))).toEqual([])
  })

  it("en status/violation labels are pure ASCII", () => {
    const entries: [string, string][] = [
      ...NODE_STATUSES.map((s): [string, string] => [`nodeStatus.${s}`, nodeStatusLabel("en", s)]),
      ...WORKFLOW_STATUSES.map((s): [string, string] => [`workflowStatus.${s}`, workflowStatusLabel("en", s)]),
      ...DAG_VIOLATION_TYPES.map((v): [string, string] => [`violationType.${v}`, violationTypeLabel("en", v)]),
      ...VIOLATION_SEVERITIES.map((s): [string, string] => [`violationSeverity.${s}`, violationSeverityLabel("en", s)]),
    ]
    expect(nonAsciiOffenders(entries)).toEqual([])
  })
})

describe("WP-1 glyph guard — zh keeps CJK but bans EA-Ambiguous", () => {
  it("zh dict values contain no EA-Ambiguous characters", () => {
    expect(blacklistOffenders(Object.entries(DICT.zh))).toEqual([])
  })

  it("zh status/violation labels contain no EA-Ambiguous characters", () => {
    expect(blacklistOffenders(zhLabelEntries())).toEqual([])
  })

  it("zh CJK Wide content is preserved (bilingual contract stays intact)", () => {
    // The ban must not flatten zh copy to ASCII: CJK Wide chars must remain.
    expect(DICT.zh.tab_dialogue).toBe("对话")
    expect(workflowStatusLabel("zh", "running")).toBe("运行中")
    const hasCjk = [...DICT.zh.label_loading].some((ch) => ch.codePointAt(0)! >= 0x4e00)
    expect(hasCjk).toBe(true)
  })
})
