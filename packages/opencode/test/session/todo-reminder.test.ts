import { describe, expect, test } from "bun:test"
import { renderTodoReminder } from "../../src/session/prompt"

describe("renderTodoReminder", () => {
  test("returns empty string when there are no todos so caller can skip injection", () => {
    expect(renderTodoReminder([])).toBe("")
  })

  test("wraps the list in <system-reminder> tags so the LLM treats it as ephemeral instruction", () => {
    const out = renderTodoReminder([{ content: "ship it", status: "in_progress", priority: "high" }])
    expect(out.startsWith("<system-reminder>")).toBe(true)
    expect(out.endsWith("</system-reminder>")).toBe(true)
    expect(out).toContain("ship it")
  })

  test("orders in_progress first, then pending, then completed, then cancelled", () => {
    const out = renderTodoReminder([
      { content: "third", status: "completed", priority: "low" },
      { content: "fourth", status: "cancelled", priority: "low" },
      { content: "second", status: "pending", priority: "medium" },
      { content: "first", status: "in_progress", priority: "high" },
    ])
    const idxFirst = out.indexOf("first")
    const idxSecond = out.indexOf("second")
    const idxThird = out.indexOf("third")
    const idxFourth = out.indexOf("fourth")
    expect(idxFirst).toBeGreaterThan(-1)
    expect(idxFirst).toBeLessThan(idxSecond)
    expect(idxSecond).toBeLessThan(idxThird)
    expect(idxThird).toBeLessThan(idxFourth)
  })

  test("uses distinct status markers so the active item is visible at a glance", () => {
    const out = renderTodoReminder([
      { content: "doing", status: "in_progress", priority: "high" },
      { content: "todo", status: "pending", priority: "medium" },
      { content: "done", status: "completed", priority: "low" },
      { content: "skip", status: "cancelled", priority: "low" },
    ])
    expect(out).toContain("[→] doing")
    expect(out).toContain("[ ] todo")
    expect(out).toContain("[x] done")
    expect(out).toContain("[-] skip")
  })

  test("includes a directive nudging the model to keep working the in_progress item", () => {
    const out = renderTodoReminder([{ content: "x", status: "in_progress", priority: "high" }])
    expect(out.toLowerCase()).toContain("in_progress")
  })

  test("falls back to pending marker for unknown status values without throwing", () => {
    // Future-proofing: Todo.Info.status is just Schema.String, not an enum,
    // so user data could carry an unrecognised status. Render must not crash.
    const out = renderTodoReminder([{ content: "weird", status: "blocked", priority: "high" }])
    expect(out).toContain("weird")
  })
})
