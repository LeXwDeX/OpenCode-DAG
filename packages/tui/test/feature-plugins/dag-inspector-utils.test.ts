import { describe, expect, test } from "bun:test"
import {
  computeWaves,
  dagControlProgressMessage,
  dagControlUnavailableMessage,
  formatDagError,
  type DagNode,
} from "../../src/feature-plugins/system/dag-inspector-utils"

const node = (id: string, depends_on: string[] = [], name = id): DagNode => ({
  id,
  workflow_id: "wf-1",
  name,
  status: "pending",
  worker_type: "task",
  required: false,
  depends_on,
})

describe("computeWaves", () => {
  test("empty input produces no waves", () => {
    expect(computeWaves([])).toEqual([])
  })

  test("independent nodes land in one wave sorted by name", () => {
    const waves = computeWaves([node("b"), node("a"), node("c")])
    expect(waves).toHaveLength(1)
    expect(waves[0].map((n) => n.id)).toEqual(["a", "b", "c"])
  })

  test("linear chain produces one wave per node", () => {
    const waves = computeWaves([node("c", ["b"]), node("a"), node("b", ["a"])])
    expect(waves.map((w) => w.map((n) => n.id))).toEqual([["a"], ["b"], ["c"]])
  })

  test("diamond topology groups by depth", () => {
    const waves = computeWaves([
      node("root"),
      node("left", ["root"]),
      node("right", ["root"]),
      node("merge", ["left", "right"]),
    ])
    expect(waves.map((w) => w.map((n) => n.id))).toEqual([["root"], ["left", "right"], ["merge"]])
  })

  test("dependency cycle terminates and drops only the cycle members", () => {
    const waves = computeWaves([node("a"), node("x", ["y"]), node("y", ["x"])])
    expect(waves.map((w) => w.map((n) => n.id))).toEqual([["a"]])
  })

  test("dependency on a missing node is treated as satisfied (replan removed it)", () => {
    const waves = computeWaves([node("a", ["ghost"]), node("b", ["a"])])
    expect(waves.map((w) => w.map((n) => n.id))).toEqual([["a"], ["b"]])
  })
})

describe("formatDagError", () => {
  test("removes Effect and provider error wrappers without hiding the useful message", () => {
    expect(
      formatDagError(
        "Cause([Die(ProviderModelNotFoundError: Model not found: local/local/glm. Did you mean: glm?)])",
      ),
    ).toBe("Model not found: local/local/glm. Did you mean: glm?")
  })
})

describe("DAG control state", () => {
  test("allows only operations valid for the current workflow status", () => {
    expect(dagControlUnavailableMessage("running", "pause")).toBeUndefined()
    expect(dagControlUnavailableMessage("stepping", "pause")).toBeUndefined()
    expect(dagControlUnavailableMessage("paused", "resume")).toBeUndefined()
    expect(dagControlUnavailableMessage("completed", "pause")).toBe(
      "Workflow is completed and cannot be paused",
    )
    expect(dagControlUnavailableMessage("cancelled", "cancel")).toBe(
      "Workflow is cancelled and cannot be cancelled",
    )
    expect(dagControlUnavailableMessage("pending", "cancel")).toBe(
      "Workflow is pending and cannot be cancelled",
    )
    expect(dagControlUnavailableMessage("archived", "cancel")).toBe(
      "Workflow is archived and cannot be cancelled",
    )
  })

  test("formats progress without component-level branching", () => {
    expect(dagControlProgressMessage("pause")).toBe("Pausing workflow...")
    expect(dagControlProgressMessage("resume")).toBe("Resuming workflow...")
    expect(dagControlProgressMessage("cancel")).toBe("Cancelling workflow...")
  })
})
