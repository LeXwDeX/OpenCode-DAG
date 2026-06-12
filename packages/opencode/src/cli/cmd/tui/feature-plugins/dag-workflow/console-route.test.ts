/**
 * DAG workflow — buildTemplateInput unit tests
 *
 * Covers the acceptance criterion:
 * "Empty scope/context → passed as undefined to template (not empty string)"
 */
import { describe, it, expect } from "bun:test"
import { buildTemplateInput, buildPreviewMessage, DagErrorFallback } from "./console-route"

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

describe("WP-A ConsoleRoute DAG-local ErrorBoundary", () => {
  it("exports the DAG-local fallback component used by the route boundary", () => {
    expect(DagErrorFallback).toBeFunction()
  })

  it("places the DAG-local ErrorBoundary above sidebar, middle DAG, and detail panes", async () => {
    const source = await Bun.file(new URL("./console-route.tsx", import.meta.url)).text()
    const boundaryOpen = source.indexOf("<ErrorBoundary")
    const boundaryClose = source.lastIndexOf("</ErrorBoundary>")
    const sidebar = source.indexOf("<Sidebar")
    const asciiDag = source.indexOf("<AsciiDag")
    const detailPane = source.indexOf("<DetailPane")

    expect(boundaryOpen).toBeGreaterThan(-1)
    expect(boundaryOpen).toBeLessThan(sidebar)
    expect(boundaryOpen).toBeLessThan(asciiDag)
    expect(boundaryOpen).toBeLessThan(detailPane)
    expect(boundaryClose).toBeGreaterThan(source.lastIndexOf("<DetailPane"))
  })
})

describe("WP-B ConsoleRoute replan preview", () => {
  it("formats preview success before confirm/apply", () => {
    const message = buildPreviewMessage({
      ok: true,
      workflow_id: "wf-1",
      pre: {
        config: { name: "Flow", nodes: [], max_concurrency: 2 },
        node_ids: ["wf-1::a", "wf-1::b"],
        max_concurrency: 2,
        total_nodes: 2,
      },
      post: {
        config: { name: "Flow", nodes: [], max_concurrency: 4 },
        node_ids: ["wf-1::a"],
        max_concurrency: 4,
        total_nodes: 1,
      },
      delta: {
        nodes_added: 0,
        nodes_removed: 1,
        nodes_updated: 0,
        final_total: 1,
        max_concurrency_changed: true,
      },
    })

    expect(message).toContain("Preview for wf-1")
    expect(message).toContain("nodes: 2 → 1")
    expect(message).toContain("max concurrency: 2 → 4")
    expect(message).toContain("added: 0, removed: 1, updated: 0")
  })

  it("formats preview failure as rejected", () => {
    const message = buildPreviewMessage({ ok: false, reason: "Cannot remove frozen nodes: wf-1::a" })

    expect(message).toContain("Preview rejected")
    expect(message).toContain("Cannot remove frozen nodes")
  })
})

describe("WP-C ConsoleRoute inspect wiring", () => {
  it("uses data.ts inspect hook and passes diagnostics into DetailPane", async () => {
    const source = await Bun.file(new URL("./console-route.tsx", import.meta.url)).text()

    expect(source).toContain("useInspectDiagnostics")
    expect(source).toContain("const inspectDiagnostics = useInspectDiagnostics")
    expect(source).toContain("selectedNodeId: selectedNodeID")
    expect(source).toContain("inspect={inspectDiagnostics}")
  })
})
