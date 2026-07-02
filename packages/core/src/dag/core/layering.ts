/**
 * DAG scheduling core — topological layering helpers (D10).
 *
 * Pure functions over {@link DependencyGraph} that produce the depth structure
 * the α-rendering `═══` wave headers and the scheduling waves consume. Two
 * semantics are provided; pick the one that matches the consumer:
 *
 * - {@link assignWavefrontLayers} — a node joins the EARLIEST layer its deps
 *   allow (Kahn BFS). Matches {@link DependencyGraph.getLayers}. This is the
 *   default for scatter-gather patterns.
 * - {@link assignLongestPathRanks} — a node joins the LATEST layer its deps
 *   allow (1 + max(dep ranks)). Used when the wave header should reflect the
 *   "critical-path distance from a root" rather than "earliest runnable batch".
 *
 * The two coincide for pure scatter-gather (diamonds without bypass). They
 * differ only for shapes like `a->b, a->c, b->d` where c and d both have only
 * a as a dep but d is "deeper" by longest-path — wavefront puts c and d in the
 * same layer 1; longest-path puts c in 1 and d in 2.
 */

import { DependencyGraph } from "./graph"

/**
 * Wavefront layers: Map<nodeId, layerIndex> derived from getLayers().
 * layerIndex 0 = root layer (no deps). Higher = deeper.
 */
export function assignWavefrontLayers(graph: DependencyGraph): Map<string, number> {
  const out = new Map<string, number>()
  const layers = graph.getLayers()
  for (let i = 0; i < layers.length; i++) {
    for (const nodeId of layers[i]) out.set(nodeId, i)
  }
  return out
}

/**
 * Longest-path ranks: Map<nodeId, rank> where rank(node) = 1 + max(rank(dep)).
 * Roots (no deps) have rank 0. Memoised DFS.
 *
 * Use this when the α wave header should show "how far is this node from a
 * root along the longest path" — useful for cascade-prediction probes.
 */
export function assignLongestPathRanks(graph: DependencyGraph): Map<string, number> {
  const memo = new Map<string, number>()
  const rank = (nodeId: string): number => {
    const cached = memo.get(nodeId)
    if (cached !== undefined) return cached
    const deps = graph.getDependencies(nodeId)
    let max = -1
    for (const dep of deps) max = Math.max(max, rank(dep))
    const r = max + 1
    memo.set(nodeId, r)
    return r
  }
  const out = new Map<string, number>()
  for (const nodeId of graph.getAllNodes()) out.set(nodeId, rank(nodeId))
  return out
}
