/**
 * glyphs — single source for ALL decorative glyphs in the DAG Workflow TUI plugin.
 *
 * Why ASCII-only: the render engine measures cell width with Bun.stringWidth,
 * which counts East-Asian-Ambiguous characters (· ■ □ ✓ … — etc.) as 1 column,
 * but CJK terminals render them as 2 columns — the framebuffer misaligns and
 * glyphs garble (`·` becomes `□·□`). ⏸ is EA=Wide and misaligns in ALL
 * terminals. Every char exported here MUST stay below U+0080; glyphs.test.ts
 * guards this invariant by scanning the imported values.
 *
 * Architecture constraints:
 * - Pure constants, no hooks, no theme access (mirrors status.ts).
 */
export const GLYPH = {
  /** list separator, rendered padded as ` | ` (was · U+00B7) */
  separator: "|",
  /** progress bar filled cell (was ■ U+25A0) */
  barFill: "#",
  /** progress bar empty cell (was □ U+25A1) */
  barEmpty: ".",
  /** status icon: completed (was ✓ U+2713) */
  iconCompleted: "+",
  /** status icon: failed (was ✗ U+2717) */
  iconFailed: "x",
  /** status icon: running (was ● U+25CF) */
  iconRunning: "*",
  /** status icon: queued (was ◎ U+25CE) */
  iconQueued: "@",
  /** status icon: pending (was ○ U+25CB) */
  iconPending: "o",
  /** status icon: skipped / cancelled (was ⊘ U+2298) */
  iconSkipped: "-",
  /** status icon: paused (was ⏸ U+23F8, EA=Wide) */
  iconPaused: "=",
  /** warning marker (was ⚠ U+26A0) */
  warning: "!",
  /** arrowhead for DAG edge connectors (was ▶ U+25B6) */
  triangle: ">",
  /** inline arrow (was → U+2192) */
  arrow: "->",
  /** truncation marker (was … U+2026) */
  ellipsis: "...",
  /** empty-value placeholder (was — U+2014) */
  emDash: "-",
  /** vertical divider (was │ U+2502) */
  vbar: "|",
  /** horizontal rule segment (was ─ U+2500) */
  hbar: "-",
  /** tree connector: last child (was └─) */
  treeLast: "`-",
  /** tree connector: middle child (was ├─) */
  treeBranch: "|-",
  /** status icon: recoverable (~ = ASCII-safe, distinct from GLYPH.warning "!") */
  iconRecoverable: "~",
} as const
