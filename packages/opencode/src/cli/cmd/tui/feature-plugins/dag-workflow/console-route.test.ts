/**
 * DAG workflow — buildTemplateInput unit tests
 *
 * Covers the acceptance criterion:
 * "Empty scope/context → passed as undefined to template (not empty string)"
 */
import { describe, it, expect } from "bun:test"
import { buildTemplateInput } from "./console-route"

describe("buildTemplateInput", () => {
  it("includes all three fields when all are non-empty", () => {
    const result = buildTemplateInput({
      goal: "design a widget",
      scope: "frontend only",
      context: "react 19",
    })
    expect(result.goal).toBe("design a widget")
    expect(result.scope).toBe("frontend only")
    expect(result.context).toBe("react 19")
  })

  it("omits scope when it is an empty string", () => {
    const result = buildTemplateInput({ goal: "build a thing", scope: "", context: "TypeScript" })
    expect(result.goal).toBe("build a thing")
    expect(result.scope).toBeUndefined()
    expect(result.context).toBe("TypeScript")
  })

  it("omits context when it is an empty string", () => {
    const result = buildTemplateInput({ goal: "build a thing", scope: "API layer", context: "" })
    expect(result.goal).toBe("build a thing")
    expect(result.scope).toBe("API layer")
    expect(result.context).toBeUndefined()
  })

  it("omits both scope and context when both are whitespace-only", () => {
    const result = buildTemplateInput({ goal: "review code", scope: "   ", context: "\t" })
    expect(result.goal).toBe("review code")
    expect(result.scope).toBeUndefined()
    expect(result.context).toBeUndefined()
  })

  it("trims whitespace from scope and context before including them", () => {
    const result = buildTemplateInput({
      goal: "ship it",
      scope: "  backend  ",
      context: "\n strict mode \n",
    })
    expect(result.scope).toBe("backend")
    expect(result.context).toBe("strict mode")
  })

  it("always includes goal as-is (even if empty)", () => {
    const result = buildTemplateInput({ goal: "", scope: "", context: "" })
    expect(result.goal).toBe("")
    expect(result.scope).toBeUndefined()
    expect(result.context).toBeUndefined()
  })
})
