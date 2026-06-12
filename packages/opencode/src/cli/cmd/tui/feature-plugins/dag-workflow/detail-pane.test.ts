/**
 * detail-pane.tsx tests
 *
 * DetailPane is a pure presentation component that composes the right-column
 * panel group. Following the existing dag-workflow test style (components are
 * not render-tested; only pure helpers/exports are asserted), this is an
 * import/type smoke test:
 * - DetailPane is exported and is a function (callable component)
 * - The props contract type-checks against the resolved shapes the console
 *   route passes (compile-time guarantee).
 */
import { describe, it, expect } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { DAGNodeSession } from "@/dag/session/types"
import type { InspectDiagnosticsApi, WorkflowHistory, NodeLog, Timeline } from "./data"
import type { Lang } from "./i18n"
import { DetailPane } from "./detail-pane"

describe("DetailPane — export + props contract", () => {
  it("is exported as a function component", () => {
    expect(typeof DetailPane).toBe("function")
  })

  it("accepts the resolved right-column props shape", () => {
    // Compile-time contract: this object must satisfy DetailPane's props.
    // If any prop name/type drifts, typecheck fails (the real assertion).
    const props: Parameters<typeof DetailPane>[0] = {
      lang: "en" as Lang,
      node: null as DAGNodeSession | null,
      toolCounts: () => ({}) as Record<string, number>,
      route: {} as TuiPluginApi["route"],
      onNodeClose: () => {},
      history: [] as WorkflowHistory[],
      historyError: null,
      historyLoading: false,
      logs: [] as NodeLog[],
      logsError: null,
      logsLoading: false,
      timeline: null as Timeline | null,
      timelineError: null,
      timelineLoading: false,
      inspect: {
        block: () => [],
        topology: () => null,
        snapshot: () => null,
        cascade: () => null,
        error: () => null,
        loading: () => false,
        refresh: () => {},
      } as InspectDiagnosticsApi,
      event: {} as TuiPluginApi["event"],
      nodes: [] as DAGNodeSession[],
    }
    expect(props.lang).toBe("en")
    expect(props.history).toEqual([])
    expect(typeof props.onNodeClose).toBe("function")
  })

  it("embeds the InspectPanel in the right-column composition", async () => {
    const source = await Bun.file(new URL("./detail-pane.tsx", import.meta.url)).text()

    expect(source).toContain("import { InspectPanel }")
    expect(source).toContain("<InspectPanel")
    expect(source.indexOf("<InspectPanel")).toBeGreaterThan(source.indexOf("<TimelinePanel"))
  })
})
