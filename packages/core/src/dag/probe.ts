/**
 * DAG diagnostic probes — read-only analysis over the read-model.
 *
 * 4 probe methods, all NEW code (no equivalent in old dag-query.ts):
 * - getTopology: graph-wide adjacency map
 * - getExecutionSnapshot: current-state compose (workflow + nodes + violations)
 * - predictCascade: failure blast-radius (which downstream nodes would be affected)
 * - explainBlock: why a node is blocked (which deps are unsatisfied)
 *
 * These run against the DagStore read-model (no EventV2 subscription, no I/O
 * beyond DB reads). Exposed ONLY through the HTTP inspector route (D7), never
 * as an agent tool.
 */

import { DependencyGraph } from "@opencode-ai/core/dag/core/graph"
import { assignLongestPathRanks } from "@opencode-ai/core/dag/core/layering"
import type { DagStore } from "@opencode-ai/core/dag/store"

export interface TopologyResult {
  nodes: { id: string; name: string; status: string; depth: number; deps: string[]; dependents: string[] }[]
  layers: string[][]
  edgeCount: number
  nodeCount: number
}

export interface ExecutionSnapshotResult {
  workflow: DagStore.WorkflowRow
  nodes: DagStore.NodeRow[]
  violations: DagStore.ViolationRow[]
  summary: {
    total: number
    completed: number
    running: number
    pending: number
    failed: number
    skipped: number
  }
}

export interface CascadeResult {
  /** The node whose failure we're predicting from. */
  nodeId: string
  /** Nodes that would be orphaned (transitive downstream). */
  affected: string[]
}

export interface BlockExplanation {
  nodeId: string
  isBlocked: boolean
  unsatisfiedDeps: { depId: string; depStatus: string }[]
}

/**
 * Build a topology view: adjacency, layers, depth per node.
 */
export async function getTopology(store: DagStore.Interface, workflowId: string): Promise<TopologyResult | undefined> {
  const wf = await Effect.runPromise(store.getWorkflow(workflowId))
  if (!wf) return undefined
  const nodes = await Effect.runPromise(store.getNodes(workflowId))

  const graph = new DependencyGraph()
  for (const n of nodes) graph.addNode(n.id)
  for (const n of nodes) {
    for (const dep of n.dependsOn) {
      if (graph.hasNode(dep)) graph.addEdge(n.id, dep)
    }
  }

  const ranks = assignLongestPathRanks(graph)
  const layers = graph.getLayers()

  return {
    nodeCount: nodes.length,
    edgeCount: graph.getEdgeCount(),
    layers,
    nodes: nodes.map((n) => ({
      id: n.id,
      name: n.name,
      status: n.status,
      depth: ranks.get(n.id) ?? 0,
      deps: n.dependsOn,
      dependents: graph.getDependents(n.id),
    })),
  }
}

/**
 * Snapshot the full current state of a workflow for inspector display.
 */
export async function getExecutionSnapshot(store: DagStore.Interface, workflowId: string): Promise<ExecutionSnapshotResult | undefined> {
  const wf = await Effect.runPromise(store.getWorkflow(workflowId))
  if (!wf) return undefined
  const [nodes, violations] = await Promise.all([
    Effect.runPromise(store.getNodes(workflowId)),
    Effect.runPromise(store.listViolations(workflowId)),
  ])

  const summary = { total: 0, completed: 0, running: 0, pending: 0, failed: 0, skipped: 0 }
  for (const n of nodes) {
    summary.total++
    if (n.status === "completed") summary.completed++
    else if (n.status === "running") summary.running++
    else if (n.status === "pending" || n.status === "queued") summary.pending++
    else if (n.status === "failed") summary.failed++
    else if (n.status === "skipped" || n.status === "aborted") summary.skipped++
  }

  return { workflow: wf, nodes, violations, summary }
}

/**
 * Predict which nodes would be affected if a given node fails.
 * Uses transitive dependents from the dependency graph.
 */
export async function predictCascade(store: DagStore.Interface, workflowId: string, nodeId: string): Promise<CascadeResult | undefined> {
  const nodes = await Effect.runPromise(store.getNodes(workflowId))
  const graph = new DependencyGraph()
  for (const n of nodes) graph.addNode(n.id)
  for (const n of nodes) {
    for (const dep of n.dependsOn) {
      if (graph.hasNode(dep)) graph.addEdge(n.id, dep)
    }
  }

  if (!graph.hasNode(nodeId)) return undefined
  const affected = graph.getAllDependents(nodeId)
  return { nodeId, affected }
}

/**
 * Explain why a node is blocked: which dependencies are unsatisfied.
 */
export async function explainBlock(store: DagStore.Interface, workflowId: string, nodeId: string): Promise<BlockExplanation | undefined> {
  const nodes = await Effect.runPromise(store.getNodes(workflowId))
  const node = nodes.find((n) => n.id === nodeId)
  if (!node) return undefined

  const unsatisfiedDeps: { depId: string; depStatus: string }[] = []
  for (const depId of node.dependsOn) {
    const dep = nodes.find((n) => n.id === depId)
    if (!dep || dep.status !== "completed") {
      unsatisfiedDeps.push({ depId, depStatus: dep?.status ?? "missing" })
    }
  }

  return {
    nodeId,
    isBlocked: unsatisfiedDeps.length > 0 && node.status === "pending",
    unsatisfiedDeps,
  }
}

// Local import to avoid circular dependency at module scope
import { Effect } from "effect"
