/**
 * [FORK:hook-ext] Hook if-condition evaluator — not in upstream
 *
 * Evaluates the `if` field on HookCommand entries to provide fine-grained
 * matching compatible with Claude Code's condition syntax.
 *
 * Supported patterns:
 * - `Bash(npm install *)`  → tool_name="bash" AND command matches glob
 * - `Edit(*.ts)`           → tool_name="edit" AND filePath matches glob
 * - `Write(src/**)`        → tool_name="write" AND filePath matches glob
 * - `Read(*.py)`           → tool_name="read" AND filePath matches glob
 * - `*`                    → Always matches (wildcard)
 * - (empty/undefined)      → Always matches (no condition)
 *
 * For non-tool events (UserPromptSubmit, Stop, etc.), `if` is ignored
 * (always matches) — CC behavior.
 */

import type { HookCommand, HookEvent } from "../settings"

/**
 * Evaluate a hook entry's `if` condition against the runtime envelope.
 *
 * @returns true if the entry should execute, false to skip
 */
export function evaluate(
  entry: HookCommand,
  envelope: Record<string, unknown>,
  event: HookEvent,
): boolean {
  const condition = entry.if
  if (!condition || condition.trim() === "" || condition.trim() === "*") return true

  // Only tool events support condition filtering
  if (event !== "PreToolUse" && event !== "PostToolUse" && event !== "PostToolUseFailure") {
    return true
  }

  const toolName = (envelope.tool_name as string) ?? ""
  const toolInput = (envelope.tool_input as Record<string, unknown>) ?? {}

  // Parse: ToolName(arg_glob)
  const match = condition.match(/^(\w+)\((.+)\)$/)
  if (!match) {
    // Malformed condition — fail open (CC behavior: unknown conditions are truthy)
    return true
  }

  const [, condTool, condGlob] = match

  // Tool name match (case-insensitive)
  if (condTool.toLowerCase() !== toolName.toLowerCase()) return false

  // Arg glob match — depends on tool type
  const argValue = extractArgValue(toolName, toolInput)
  if (!argValue) return true // No extractable arg — fail open

  return globMatch(condGlob, argValue)
}

/**
 * Extract the primary argument value for glob matching.
 * - Bash/shell: the `command` field
 * - Edit/Write/Read: the `filePath` or `file_path` field
 * - Other tools: JSON.stringify of the entire input (best-effort)
 */
function extractArgValue(toolName: string, toolInput: Record<string, unknown>): string | undefined {
  const lower = toolName.toLowerCase()
  if (lower === "bash" || lower === "shell") {
    return (toolInput.command as string) ?? undefined
  }
  if (lower === "edit" || lower === "write" || lower === "read" || lower === "multiedit") {
    return (toolInput.filePath as string) ?? (toolInput.file_path as string) ?? undefined
  }
  // Fallback: stringify for glob matching
  return JSON.stringify(toolInput)
}

/**
 * Simple glob matching. Supports:
 * - `*` matches any sequence of non-separator characters
 * - `**` matches any sequence including separators
 * - `?` matches a single character
 *
 * This is a simplified implementation — CC uses a more sophisticated
 * glob engine, but this covers the 95% case.
 */
function globMatch(pattern: string, value: string): boolean {
  // Convert glob to regex
  let regex = "^"
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        regex += ".*"
        i++ // skip next *
      } else {
        regex += "[^/]*"
      }
    } else if (c === "?") {
      regex += "[^/]"
    } else if (".+^$|(){}[]\\".includes(c)) {
      regex += "\\" + c
    } else {
      regex += c
    }
  }
  regex += "$"
  try {
    return new RegExp(regex).test(value)
  } catch {
    return true // Invalid regex — fail open
  }
}
