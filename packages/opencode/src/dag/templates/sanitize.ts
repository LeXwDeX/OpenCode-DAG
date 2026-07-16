/**
 * Prompt-injection sanitizer for DAG template input.
 *
 * Strips/neutralizes common prompt-injection patterns from user-supplied
 * template input before it's interpolated into a node's prompt.
 *
 * This is a first-line defense — the node's child session also has its own
 * system-prompt boundary. This sanitizer prevents template input from
 * overriding the node's role/instructions.
 */

/**
 * Neutralize common injection patterns in a string value.
 * Returns the sanitized string.
 */
export function sanitize(value: string): string {
  return value
    // Strip "ignore previous instructions" variants
    .replace(/ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/gi, "[REDACTED]")
    // Strip "you are now" role-hijack attempts
    .replace(/you\s+are\s+now\s+a\s+/gi, "[REDACTED] ")
    // Strip "system:" prefix attempts
    .replace(/^system\s*:/gim, "[REDACTED]:")
    // Strip markdown code-fence escapes that could break out of the template
    .replace(/```/g, "``")
    // Strip HTML-like tags that could confuse prompt parsers
    .replace(/<\/?(system|prompt|instructions?|role)>/gi, "[REDACTED]")
}

/**
 * Recursively sanitize an object's string values.
 * Non-string values are returned as-is.
 */
export function sanitizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    result[key] = typeof value === "string" ? sanitize(value) : value
  }
  return result
}
