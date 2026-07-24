import { describe, expect, test } from "bun:test"
import { DagLoop } from "@/dag/runtime/loop"
import { DagSummaryPublisher } from "@/dag/runtime/summary-publisher"
import { InstanceBootstrap } from "@/project/bootstrap"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

describe("instance bootstrap DAG wiring", () => {
  test("production LayerNode graph provides the DAG runtime and summary publisher", () => {
    expect(InstanceBootstrap.node.dependencies).toContain(DagLoop.node)
    expect(InstanceBootstrap.node.dependencies).toContain(DagSummaryPublisher.node)
    expect(() => LayerNode.buildLayer(InstanceBootstrap.node)).not.toThrow()
  })
})
