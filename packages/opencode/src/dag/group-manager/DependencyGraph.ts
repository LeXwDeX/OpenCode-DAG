// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * Dependency Graph 实现
 *
 * @module dag/group-manager/DependencyGraph
 *
 * 纯数据结构，无副作用，无 async。
 * 使用邻接表存储依赖关系，支持 O(V+E) 拓扑排序（Kahn 算法）和循环检测（DFS 三色标记）。
 */

import type { IDependencyGraph } from './IDependencyGraph';
import { GroupNotFoundError, CycleError } from './errors';

/** 节点颜色（用于 DFS 循环检测） */
const enum Color {
  White = 0,
  Gray = 1,
  Black = 2,
}

export class DependencyGraph implements IDependencyGraph {
  /** nodeId → 此节点依赖的节点集合 */
  private deps: Map<string, Set<string>> = new Map();
  /** nodeId → 依赖此节点的节点集合 */
  private revDeps: Map<string, Set<string>> = new Map();

  // ==========================================================================
  // Node Management
  // ==========================================================================

  addNode(nodeId: string): void {
    if (!this.deps.has(nodeId)) {
      this.deps.set(nodeId, new Set());
      this.revDeps.set(nodeId, new Set());
    }
  }

  removeNode(nodeId: string): void {
    if (!this.deps.has(nodeId)) throw new GroupNotFoundError(nodeId);

    // 清除以此节点为起点的边
    for (const to of this.deps.get(nodeId)!) {
      this.revDeps.get(to)?.delete(nodeId);
    }
    // 清除以此节点为终点的边
    for (const from of this.revDeps.get(nodeId)!) {
      this.deps.get(from)?.delete(nodeId);
    }

    this.deps.delete(nodeId);
    this.revDeps.delete(nodeId);
  }

  hasNode(nodeId: string): boolean {
    return this.deps.has(nodeId);
  }

  getAllNodes(): string[] {
    return Array.from(this.deps.keys());
  }

  getNodeCount(): number {
    return this.deps.size;
  }

  // ==========================================================================
  // Edge Management
  // ==========================================================================

  addEdge(from: string, to: string): void {
    if (!this.deps.has(from)) throw new GroupNotFoundError(from);
    if (!this.deps.has(to)) throw new GroupNotFoundError(to);

    // 检测是否会引入环
    if (this.wouldCreateCycle(from, to)) {
      throw new CycleError([from, to]);
    }

    this.deps.get(from)!.add(to);
    this.revDeps.get(to)!.add(from);
  }

  removeEdge(from: string, to: string): void {
    if (!this.deps.has(from)) throw new GroupNotFoundError(from);
    this.deps.get(from)?.delete(to);
    this.revDeps.get(to)?.delete(from);
  }

  hasEdge(from: string, to: string): boolean {
    return this.deps.get(from)?.has(to) ?? false;
  }

  getEdgeCount(): number {
    let count = 0;
    for (const edges of this.deps.values()) count += edges.size;
    return count;
  }

  // ==========================================================================
  // Dependency Queries
  // ==========================================================================

  getDependencies(nodeId: string): string[] {
    if (!this.deps.has(nodeId)) throw new GroupNotFoundError(nodeId);
    return Array.from(this.deps.get(nodeId)!);
  }

  getDependents(nodeId: string): string[] {
    if (!this.revDeps.has(nodeId)) throw new GroupNotFoundError(nodeId);
    return Array.from(this.revDeps.get(nodeId)!);
  }

  getAllDependencies(nodeId: string): string[] {
    if (!this.deps.has(nodeId)) throw new GroupNotFoundError(nodeId);
    const visited = new Set<string>();
    const dfs = (id: string) => {
      for (const dep of this.deps.get(id)!) {
        if (!visited.has(dep)) {
          visited.add(dep);
          dfs(dep);
        }
      }
    };
    dfs(nodeId);
    return Array.from(visited);
  }

  getAllDependents(nodeId: string): string[] {
    if (!this.revDeps.has(nodeId)) throw new GroupNotFoundError(nodeId);
    const visited = new Set<string>();
    const dfs = (id: string) => {
      for (const dep of this.revDeps.get(id)!) {
        if (!visited.has(dep)) {
          visited.add(dep);
          dfs(dep);
        }
      }
    };
    dfs(nodeId);
    return Array.from(visited);
  }

  // ==========================================================================
  // Topological Sort（Kahn 算法）
  // ==========================================================================

  topologicalSort(): string[] {
    if (this.hasCycle()) throw new CycleError(this.findFirstCycle());

    const inDegree = new Map<string, number>();
    for (const [id, edges] of this.deps) {
      inDegree.set(id, edges.size);
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }
    // 保持确定性：按字典序排列初始队列
    queue.sort();

    const sorted: string[] = [];
    while (queue.length > 0) {
      const node = queue.shift()!;
      sorted.push(node);
      const dependents = this.revDeps.get(node)!;
      const nextCandidates: string[] = [];
      for (const dep of dependents) {
        const newDeg = (inDegree.get(dep) ?? 1) - 1;
        inDegree.set(dep, newDeg);
        if (newDeg === 0) nextCandidates.push(dep);
      }
      nextCandidates.sort();
      queue.push(...nextCandidates);
    }

    return sorted;
  }

  // ==========================================================================
  // Execution Planning
  // ==========================================================================

  getExecutableNodes(completed: Set<string>): string[] {
    const result: string[] = [];
    for (const [id, edges] of this.deps) {
      if (completed.has(id)) continue;
      const allDepsCompleted = Array.from(edges).every((dep) => completed.has(dep));
      if (allDepsCompleted) result.push(id);
    }
    return result;
  }

  getLayers(): string[][] {
    if (this.hasCycle()) throw new CycleError(this.findFirstCycle());

    const remaining = new Set(this.deps.keys());
    const completed = new Set<string>();
    const layers: string[][] = [];

    while (remaining.size > 0) {
      const layer: string[] = [];
      for (const id of remaining) {
        const allDepsDone = Array.from(this.deps.get(id)!).every(
          (dep) => completed.has(dep)
        );
        if (allDepsDone) layer.push(id);
      }
      if (layer.length === 0) break; // 不应发生（无环图）
      layer.sort();
      layers.push(layer);
      for (const id of layer) {
        completed.add(id);
        remaining.delete(id);
      }
    }

    return layers;
  }

  // ==========================================================================
  // Cycle Detection（DFS 三色标记）
  // ==========================================================================

  hasCycle(): boolean {
    const color = new Map<string, Color>();
    for (const id of this.deps.keys()) color.set(id, Color.White);

    for (const id of this.deps.keys()) {
      if (color.get(id) === Color.White) {
        if (this.dfsHasCycle(id, color)) return true;
      }
    }
    return false;
  }

  findCycles(): string[][] {
    // 简化实现：找到第一个环后返回
    if (!this.hasCycle()) return [];
    return [this.findFirstCycle()];
  }

  // ==========================================================================
  // Validation
  // ==========================================================================

  validate(): true | string[] {
    const errors: string[] = [];
    if (this.hasCycle()) {
      errors.push('Graph contains cycle(s)');
    }
    return errors.length === 0 ? true : errors;
  }

  // ==========================================================================
  // Statistics
  // ==========================================================================

  getStats(): {
    nodeCount: number;
    edgeCount: number;
    averageDegree: number;
    maxDepth: number;
    hasCycle: boolean;
  } {
    const nodeCount = this.getNodeCount();
    const edgeCount = this.getEdgeCount();
    const averageDegree = nodeCount > 0 ? edgeCount / nodeCount : 0;
    const maxDepth = this.hasCycle() ? -1 : this.computeMaxDepth();

    return {
      nodeCount,
      edgeCount,
      averageDegree,
      maxDepth,
      hasCycle: maxDepth === -1,
    };
  }

  // ==========================================================================
  // Serialization
  // ==========================================================================

  toJSON(): { nodes: string[]; edges: { from: string; to: string }[] } {
    const nodes = Array.from(this.deps.keys());
    const edges: { from: string; to: string }[] = [];
    for (const [from, tos] of this.deps) {
      for (const to of tos) {
        edges.push({ from, to });
      }
    }
    return { nodes, edges };
  }

  fromJSON(data: {
    nodes: string[];
    edges: { from: string; to: string }[];
  }): DependencyGraph {
    const graph = new DependencyGraph();
    for (const node of data.nodes) graph.addNode(node);
    for (const edge of data.edges) {
      if (graph.hasNode(edge.from) && graph.hasNode(edge.to)) {
        graph.deps.get(edge.from)!.add(edge.to);
        graph.revDeps.get(edge.to)!.add(edge.from);
      }
    }
    return graph;
  }

  clone(): DependencyGraph {
    return this.fromJSON(this.toJSON());
  }

  clear(): void {
    this.deps.clear();
    this.revDeps.clear();
  }

  // ==========================================================================
  // Internal helpers
  // ==========================================================================

  private dfsHasCycle(node: string, color: Map<string, Color>): boolean {
    color.set(node, Color.Gray);
    for (const dep of this.deps.get(node)!) {
      const c = color.get(dep);
      if (c === Color.Gray) return true;
      if (c === Color.White && this.dfsHasCycle(dep, color)) return true;
    }
    color.set(node, Color.Black);
    return false;
  }

  private wouldCreateCycle(from: string, to: string): boolean {
    if (from === to) return true;
    // 检测从 to 是否能到达 from（如果能，添加 from→to 会形成环）
    const visited = new Set<string>();
    const dfs = (current: string): boolean => {
      if (current === from) return true;
      if (visited.has(current)) return false;
      visited.add(current);
      for (const dep of this.deps.get(current) ?? []) {
        if (dfs(dep)) return true;
      }
      return false;
    };
    return dfs(to);
  }

  private findFirstCycle(): string[] {
    const color = new Map<string, Color>();
    const parent = new Map<string, string | null>();
    for (const id of this.deps.keys()) {
      color.set(id, Color.White);
      parent.set(id, null);
    }

    for (const start of this.deps.keys()) {
      if (color.get(start) !== Color.White) continue;
      const cycle = this.findCycleFrom(start, color, parent, []);
      if (cycle) return cycle;
    }
    return [];
  }

  private findCycleFrom(
    node: string,
    color: Map<string, Color>,
    _parent: Map<string, string | null>,
    path: string[]
  ): string[] | null {
    color.set(node, Color.Gray);
    path.push(node);

    for (const dep of this.deps.get(node)!) {
      if (color.get(dep) === Color.Gray) {
        const cycleStart = path.indexOf(dep);
        return path.slice(cycleStart);
      }
      if (color.get(dep) === Color.White) {
        const result = this.findCycleFrom(dep, color, _parent, path);
        if (result) return result;
      }
    }

    path.pop();
    color.set(node, Color.Black);
    return null;
  }

  private computeMaxDepth(): number {
    const memo = new Map<string, number>();
    const dfs = (id: string): number => {
      if (memo.has(id)) return memo.get(id)!;
      let maxChild = 0;
      for (const dep of this.revDeps.get(id)!) {
        maxChild = Math.max(maxChild, dfs(dep) + 1);
      }
      memo.set(id, maxChild);
      return maxChild;
    };

    let maxDepth = 0;
    for (const id of this.deps.keys()) {
      maxDepth = Math.max(maxDepth, dfs(id));
    }
    return maxDepth;
  }
}
