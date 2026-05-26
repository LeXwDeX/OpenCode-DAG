/**
 * Shared hallucination tag detection.
 *
 * When a model outputs XML-like tags as plain text (instead of calling the
 * corresponding tool), it is "hallucinating" the tag format. This module is
 * the single source of truth for which tags to detect.
 *
 * To add a new tag: append its name to HALLUCINATION_TAGS. The regex and
 * extraction logic update automatically.
 */

/** Tag names that indicate hallucination when found as plain text in model output. */
export const HALLUCINATION_TAGS = [
  // Compression / summary tags (model learned from training data)
  "analysis",
  "summary",
  "thought",
  // Tool-call format tags (model mimics Anthropic tool-call XML)
  "invoke",
  "tool_use",
  // DCP plugin tags (model mimics injected metadata)
  "dcp-message-id",
  "dcp-system-reminder",
] as const

/**
 * Regex that matches any hallucination tag (open, close, or paired).
 * Built once from HALLUCINATION_TAGS so adding a tag is a one-line change.
 */
const tagAlternation = HALLUCINATION_TAGS.join("|")
const pairedPattern = HALLUCINATION_TAGS.map((t) => `<${t}>[\\s\\S]*?<\\/${t}>`).join("|")
export const hallucinationRegex = new RegExp(`${pairedPattern}|<\\/(${tagAlternation})>`, "i")

/**
 * Extract all hallucination tag occurrences from text for display.
 * Returns the raw tag strings like `["<analysis>", "</analysis>"]`.
 */
const extractRegex = new RegExp(`<(\\/?(?:${tagAlternation}))[^>]*>`, "gi")

export function detectHallucination(text: string): { detected: boolean; matchedTags: string[] } {
  const match = text.match(hallucinationRegex)
  if (!match) return { detected: false, matchedTags: [] }
  const matchedTags = [...text.matchAll(extractRegex)].map((m) => m[0])
  return { detected: true, matchedTags }
}
