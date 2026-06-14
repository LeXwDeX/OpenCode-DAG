/**
 * DAG workflow — buildTemplateInput unit tests
 *
 * Covers the acceptance criterion:
 * "Empty scope/context → passed as undefined to template (not empty string)"
 */
import { describe, it, expect } from "bun:test"
import { buildTemplateInput, buildPreviewMessage, routeWorkflowId, DagErrorFallback, DAG_SEARCH_MODE } from "./console-route"

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
    expect(message).toContain("nodes: 2 -> 1")
    expect(message).toContain("max concurrency: 2 -> 4")
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

describe("ConsoleRoute workflow route param selection", () => {
  it("accepts canonical workflowId route param", () => {
    expect(routeWorkflowId({ workflowId: "wf-canonical" })).toBe("wf-canonical")
  })

  it("accepts event-style workflowID route param from external callers", () => {
    expect(routeWorkflowId({ workflowID: "wf-event-style" })).toBe("wf-event-style")
  })

  it("prefers canonical workflowId when both names are present", () => {
    expect(routeWorkflowId({ workflowId: "wf-canonical", workflowID: "wf-event-style" })).toBe("wf-canonical")
  })

  it("keeps a route-param resync effect for already-mounted DAG pages", async () => {
    const source = await Bun.file(new URL("./console-route.tsx", import.meta.url)).text()
    expect(source).toContain("routeWorkflowId(routeParams())")
    expect(source).toContain("setCurrentWorkflowID(next)")
    expect(source).toContain("setSelectedNodeID(null)")
  })
})

/**
 * WP-1 BUG-2 regression guard: the `/` shortcut was never registered and the
 * sidebar search input had no focus path. Contract:
 * - `/` lives in the base-mode bindings group and requests search focus
 *   (focusSearch handles wide vs narrow: narrow also expands the sidebar).
 * - While search is focused a dedicated keymap mode (DAG_SEARCH_MODE) is
 *   pushed, suppressing the console nav bindings (now scoped to base mode).
 * - Escape has dual semantics: search focused → blur (search-mode binding);
 *   unfocused → existing "Back to session" base-mode binding.
 */
describe("WP-1 ConsoleRoute search shortcut + escape dual semantics", () => {
  async function routeSource(): Promise<string> {
    return Bun.file(new URL("./console-route.tsx", import.meta.url)).text()
  }

  it("exports the search keymap mode", () => {
    expect(DAG_SEARCH_MODE).toBe("dag-search")
  })

  it("registers the / binding to focus search", async () => {
    const source = await routeSource()
    expect(source).toContain('key: "/"')
    expect(source).toContain("focusSearch()")
  })

  it("scopes console nav bindings to base mode and search bindings to the search mode", async () => {
    const source = await routeSource()
    expect(source).toContain("mode: OPENCODE_BASE_MODE")
    expect(source).toContain("mode: DAG_SEARCH_MODE")
  })

  it("suppresses console bindings while focused via the keymap mode stack", async () => {
    const source = await routeSource()
    expect(source).toContain("useOpencodeModeStack")
    expect(source).toContain("modeStack.push(DAG_SEARCH_MODE)")
  })

  it("escape keeps dual semantics: blur while focused, back-to-session otherwise", async () => {
    const source = await routeSource()
    expect(source).toContain("blurSearch()")
    expect(source).toContain("goToSessionTab()")
    // search-mode escape (blur) must NOT navigate; base escape stays intact
    const searchModeBlock = source.slice(source.indexOf("mode: DAG_SEARCH_MODE"))
    const searchEscape = searchModeBlock.slice(0, searchModeBlock.indexOf("}))"))
    expect(searchEscape).toContain('key: "escape"')
    expect(searchEscape).not.toContain("goToSessionTab")
  })
})

/**
 * WP-1 BUG-1 regression guard: the topbar had no height/flexShrink guard
 * (background obscured + content jitter on mouse click) and the middle
 * scrollbox declared contradictory sticky props.
 */
describe("WP-1 ConsoleRoute topbar + scrollbox layout guards", () => {
  async function routeSource(): Promise<string> {
    return Bun.file(new URL("./console-route.tsx", import.meta.url)).text()
  }

  it("pins the topbar to height 3 with flexShrink 0", async () => {
    const source = await routeSource()
    const topbarStart = source.indexOf("TOP BAR")
    expect(topbarStart).toBeGreaterThan(-1)
    const topbar = source.slice(topbarStart, source.indexOf("</box>", topbarStart))
    expect(topbar).toContain("height={3}")
    expect(topbar).toContain("flexShrink={0}")
  })

  it("drops the contradictory stickyStart from the middle scrollbox", async () => {
    const source = await routeSource()
    expect(source).not.toContain("stickyStart")
    expect(source).toContain("stickyScroll={false}")
  })
})
