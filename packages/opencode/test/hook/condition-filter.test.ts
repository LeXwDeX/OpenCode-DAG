import { describe, expect, test } from "bun:test"
import { evaluate } from "@/hook/extensions/condition-filter"
import type { HookCommand, HookEvent } from "@/hook/settings"

// `evaluate` only reads `entry.if`; `type` is the one required field on
// HookCommand, so this is the minimal valid fixture.
const entry = (ifCond: string): HookCommand => ({ type: "command", if: ifCond })

describe("condition-filter evaluate", () => {
  test("PermissionRequest: if 不匹配 → 跳过", () => {
    // delta spec scenario: Bash(rm *) against a `ls` command → no match
    const result = evaluate(entry("Bash(rm *)"), { tool_name: "bash", tool_input: { command: "ls" } }, "PermissionRequest")
    expect(result).toBe(false)
  })

  test("PermissionDenied: if 匹配 → 执行", () => {
    // delta spec scenario: Edit(*.ts) against filePath a.ts → match
    const result = evaluate(
      entry("Edit(*.ts)"),
      { tool_name: "edit", tool_input: { filePath: "a.ts" } },
      "PermissionDenied",
    )
    expect(result).toBe(true)
  })

  test("非工具事件 (Stop) if 恒为真（被忽略）", () => {
    // delta spec scenario: any if on a non-tool event is ignored
    expect(evaluate(entry("Bash(rm *)"), { prompt: "hi" }, "Stop")).toBe(true)
    expect(evaluate(entry("Edit(*.ts)"), {}, "UserPromptSubmit")).toBe(true)
  })

  test("PreToolUse 既有行为保持（匹配/不匹配）", () => {
    expect(
      evaluate(entry("Bash(npm install *)"), { tool_name: "bash", tool_input: { command: "npm install foo" } }, "PreToolUse"),
    ).toBe(true)
    expect(
      evaluate(entry("Bash(npm install *)"), { tool_name: "bash", tool_input: { command: "rm -rf /" } }, "PreToolUse"),
    ).toBe(false)
  })

  test("PostToolUse/PostToolUseFailure 仍受 if 过滤", () => {
    expect(
      evaluate(entry("Read(*.ts)"), { tool_name: "read", tool_input: { filePath: "x.ts" } }, "PostToolUse"),
    ).toBe(true)
    expect(
      evaluate(entry("Read(*.ts)"), { tool_name: "read", tool_input: { filePath: "x.py" } }, "PostToolUseFailure"),
    ).toBe(false)
  })

  test("空/* /undefined 条件恒为真", () => {
    const events: HookEvent[] = ["PreToolUse", "PermissionRequest", "Stop", "UserPromptSubmit"]
    for (const ev of events) {
      expect(evaluate({ type: "command" }, { tool_name: "bash" }, ev)).toBe(true)
      expect(evaluate({ type: "command", if: "" }, { tool_name: "bash" }, ev)).toBe(true)
      expect(evaluate({ type: "command", if: "*" }, { tool_name: "bash" }, ev)).toBe(true)
    }
  })
})
