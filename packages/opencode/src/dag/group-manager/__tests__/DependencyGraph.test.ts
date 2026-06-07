// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * DependencyGraph 单元测试
 *
 * 覆盖 IDependencyGraph 所有方法，包括：
 * - 节点管理（add/remove/has/getAll/count）
 * - 边管理（add/remove/has/count）
 * - 依赖查询（直接/间接/传递）
 * - 拓扑排序（Kahn 算法）
 * - 循环检测（DFS 三色标记）
 * - 执行计划（executableNodes / layers）
 * - 序列化（toJSON / fromJSON / clone / clear）
 * - 统计信息
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { DependencyGraph } from '../DependencyGraph';
import { GroupNotFoundError, CycleError } from '../errors';

describe('DependencyGraph', () => {
  let graph: DependencyGraph;

  beforeEach(() => {
    graph = new DependencyGraph();
  });

  // ==========================================================================
  // 节点管理
  // ==========================================================================

  describe('节点管理', () => {
    it('addNode 应添加节点', () => {
      graph.addNode('a');
      expect(graph.hasNode('a')).toBe(true);
    });

    it('重复 addNode 不应报错', () => {
      graph.addNode('a');
      graph.addNode('a');
      expect(graph.getNodeCount()).toBe(1);
    });

    it('removeNode 应移除节点', () => {
      graph.addNode('a');
      graph.removeNode('a');
      expect(graph.hasNode('a')).toBe(false);
    });

    it('removeNode 不存在的节点应抛出 GroupNotFoundError', () => {
      expect(() => graph.removeNode('x')).toThrow(GroupNotFoundError);
    });

    it('removeNode 应清除关联边', () => {
      graph.addNode('a');
      graph.addNode('b');
      graph.addEdge('a', 'b');
      graph.removeNode('b');
      expect(graph.getDependencies('a')).toEqual([]);
      expect(graph.getEdgeCount()).toBe(0);
    });

    it('hasNode 对不存在的节点返回 false', () => {
      expect(graph.hasNode('x')).toBe(false);
    });

    it('getAllNodes 应返回所有节点', () => {
      graph.addNode('a');
      graph.addNode('b');
      graph.addNode('c');
      expect(graph.getAllNodes().sort()).toEqual(['a', 'b', 'c']);
    });

    it('getNodeCount 应返回正确数量', () => {
      expect(graph.getNodeCount()).toBe(0);
      graph.addNode('a');
      graph.addNode('b');
      expect(graph.getNodeCount()).toBe(2);
    });
  });

  // ==========================================================================
  // 边管理
  // ==========================================================================

  describe('边管理', () => {
    beforeEach(() => {
      graph.addNode('a');
      graph.addNode('b');
      graph.addNode('c');
    });

    it('addEdge 应添加边', () => {
      graph.addEdge('a', 'b');
      expect(graph.hasEdge('a', 'b')).toBe(true);
    });

    it('addEdge 对不存在的 from 节点应抛出错误', () => {
      expect(() => graph.addEdge('x', 'b')).toThrow(GroupNotFoundError);
    });

    it('addEdge 对不存在的 to 节点应抛出错误', () => {
      expect(() => graph.addEdge('a', 'x')).toThrow(GroupNotFoundError);
    });

    it('addEdge 产生循环应抛出 CycleError', () => {
      graph.addEdge('a', 'b');
      graph.addEdge('b', 'c');
      expect(() => graph.addEdge('c', 'a')).toThrow(CycleError);
    });

    it('addEdge 自环应抛出 CycleError', () => {
      expect(() => graph.addEdge('a', 'a')).toThrow(CycleError);
    });

    it('removeEdge 应移除边', () => {
      graph.addEdge('a', 'b');
      graph.removeEdge('a', 'b');
      expect(graph.hasEdge('a', 'b')).toBe(false);
    });

    it('hasEdge 对不存在的边返回 false', () => {
      expect(graph.hasEdge('a', 'b')).toBe(false);
    });

    it('getEdgeCount 应返回正确数量', () => {
      expect(graph.getEdgeCount()).toBe(0);
      graph.addEdge('a', 'b');
      graph.addEdge('b', 'c');
      expect(graph.getEdgeCount()).toBe(2);
    });
  });

  // ==========================================================================
  // 依赖查询
  // ==========================================================================

  describe('依赖查询', () => {
    beforeEach(() => {
      graph.addNode('a');
      graph.addNode('b');
      graph.addNode('c');
      graph.addNode('d');
      // a → b → c, a → d
      graph.addEdge('a', 'b');
      graph.addEdge('b', 'c');
      graph.addEdge('a', 'd');
    });

    it('getDependencies 应返回直接依赖', () => {
      expect(graph.getDependencies('a').sort()).toEqual(['b', 'd']);
    });

    it('getDependencies 对不存在的节点应抛出错误', () => {
      expect(() => graph.getDependencies('x')).toThrow(GroupNotFoundError);
    });

    it('getDependents 应返回直接被依赖者', () => {
      expect(graph.getDependents('b').sort()).toEqual(['a']);
    });

    it('getDependents 对不存在的节点应抛出错误', () => {
      expect(() => graph.getDependents('x')).toThrow(GroupNotFoundError);
    });

    it('getAllDependencies 应返回传递依赖', () => {
      const deps = graph.getAllDependencies('a').sort();
      expect(deps).toEqual(['b', 'c', 'd']);
    });

    it('getAllDependencies 对不存在的节点应抛出错误', () => {
      expect(() => graph.getAllDependencies('x')).toThrow(GroupNotFoundError);
    });

    it('getAllDependents 应返回传递被依赖者', () => {
      const deps = graph.getAllDependents('c').sort();
      expect(deps).toEqual(['a', 'b']);
    });

    it('getAllDependents 对不存在的节点应抛出错误', () => {
      expect(() => graph.getAllDependents('x')).toThrow(GroupNotFoundError);
    });
  });

  // ==========================================================================
  // 拓扑排序
  // ==========================================================================

  describe('拓扑排序', () => {
    it('线性依赖应正确排序', () => {
      graph.addNode('c');
      graph.addNode('b');
      graph.addNode('a');
      graph.addEdge('a', 'b');
      graph.addEdge('b', 'c');
      const sorted = graph.topologicalSort();
      expect(sorted.indexOf('c')).toBeLessThan(sorted.indexOf('b'));
      expect(sorted.indexOf('b')).toBeLessThan(sorted.indexOf('a'));
    });

    it('无依赖的节点应全部出现在结果中', () => {
      graph.addNode('a');
      graph.addNode('b');
      graph.addNode('c');
      const sorted = graph.topologicalSort();
      expect(sorted.sort()).toEqual(['a', 'b', 'c']);
    });

    it('有环时应抛出 CycleError', () => {
      // 先手动构造环（绕过 addEdge 的循环检测）
      graph.addNode('a');
      graph.addNode('b');
      graph.addNode('c');
      // 通过底层操作注入环
      graph.addEdge('a', 'b');
      graph.addEdge('b', 'c');
      // 注入 c→a 以构造环
      (graph as any).deps.get('c')!.add('a');
      (graph as any).revDeps.get('a')!.add('c');
      expect(() => graph.topologicalSort()).toThrow(CycleError);
    });

    it('复杂 DAG 应正确排序', () => {
      graph.addNode('d');
      graph.addNode('c');
      graph.addNode('b');
      graph.addNode('a');
      graph.addEdge('a', 'b');
      graph.addEdge('a', 'c');
      graph.addEdge('b', 'd');
      graph.addEdge('c', 'd');
      const sorted = graph.topologicalSort();
      // d 在 b、c 之前，b、c 在 a 之前
      expect(sorted.indexOf('d')).toBeLessThan(sorted.indexOf('b'));
      expect(sorted.indexOf('d')).toBeLessThan(sorted.indexOf('c'));
      expect(sorted.indexOf('b')).toBeLessThan(sorted.indexOf('a'));
      expect(sorted.indexOf('c')).toBeLessThan(sorted.indexOf('a'));
    });
  });

  // ==========================================================================
  // 循环检测
  // ==========================================================================

  describe('循环检测', () => {
    it('无环图应返回 false', () => {
      graph.addNode('a');
      graph.addNode('b');
      graph.addEdge('a', 'b');
      expect(graph.hasCycle()).toBe(false);
    });

    it('有环图应返回 true', () => {
      graph.addNode('a');
      graph.addNode('b');
      graph.addNode('c');
      graph.addEdge('a', 'b');
      graph.addEdge('b', 'c');
      (graph as any).deps.get('c')!.add('a');
      (graph as any).revDeps.get('a')!.add('c');
      expect(graph.hasCycle()).toBe(true);
    });

    it('findCycles 无环应返回空数组', () => {
      graph.addNode('a');
      graph.addNode('b');
      graph.addEdge('a', 'b');
      expect(graph.findCycles()).toEqual([]);
    });

    it('findCycles 有环应返回环', () => {
      graph.addNode('a');
      graph.addNode('b');
      graph.addNode('c');
      graph.addEdge('a', 'b');
      graph.addEdge('b', 'c');
      (graph as any).deps.get('c')!.add('a');
      const cycles = graph.findCycles();
      expect(cycles.length).toBeGreaterThan(0);
    });

    it('validate 无环应返回 true', () => {
      graph.addNode('a');
      graph.addNode('b');
      graph.addEdge('a', 'b');
      expect(graph.validate()).toBe(true);
    });

    it('validate 有环应返回错误列表', () => {
      graph.addNode('a');
      graph.addNode('b');
      (graph as any).deps.get('a')!.add('b');
      (graph as any).revDeps.get('b')!.add('a');
      (graph as any).deps.get('b')!.add('a');
      (graph as any).revDeps.get('a')!.add('b');
      const result = graph.validate();
      expect(result).not.toBe(true);
    });
  });

  // ==========================================================================
  // 执行计划
  // ==========================================================================

  describe('执行计划', () => {
    beforeEach(() => {
      graph.addNode('a');
      graph.addNode('b');
      graph.addNode('c');
      graph.addEdge('a', 'b');
      graph.addEdge('a', 'c');
    });

    it('getExecutableNodes 无完成时返回叶节点', () => {
      const exec = graph.getExecutableNodes(new Set());
      // b 和 c 无依赖，可执行
      expect(exec.sort()).toEqual(['b', 'c']);
    });

    it('getExecutableNodes 部分完成时返回下一批', () => {
      const exec = graph.getExecutableNodes(new Set(['b', 'c']));
      expect(exec).toEqual(['a']);
    });

    it('getExecutableNodes 全部完成时返回空', () => {
      const exec = graph.getExecutableNodes(new Set(['a', 'b', 'c']));
      expect(exec).toEqual([]);
    });

    it('getLayers 应返回正确的层级', () => {
      const layers = graph.getLayers();
      // 第一层：b、c（无依赖），第二层：a（依赖 b、c）
      expect(layers.length).toBe(2);
      expect(layers[0]!.sort()).toEqual(['b', 'c']);
      expect(layers[1]!).toEqual(['a']);
    });

    it('getLayers 对独立节点应每层一个或全部一层', () => {
      const g = new DependencyGraph();
      g.addNode('x');
      g.addNode('y');
      const layers = g.getLayers();
      expect(layers.length).toBe(1);
      expect(layers[0]!.sort()).toEqual(['x', 'y']);
    });
  });

  // ==========================================================================
  // 序列化
  // ==========================================================================

  describe('序列化', () => {
    it('toJSON 应返回可序列化对象', () => {
      graph.addNode('a');
      graph.addNode('b');
      graph.addEdge('a', 'b');
      const json = graph.toJSON();
      expect(json.nodes.sort()).toEqual(['a', 'b']);
      expect(json.edges).toEqual([{ from: 'a', to: 'b' }]);
    });

    it('fromJSON 应正确恢复图', () => {
      const data = {
        nodes: ['a', 'b', 'c'],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
        ],
      };
      const restored = graph.fromJSON(data);
      expect(restored.hasNode('a')).toBe(true);
      expect(restored.hasEdge('a', 'b')).toBe(true);
      expect(restored.hasEdge('b', 'c')).toBe(true);
      expect(restored.getNodeCount()).toBe(3);
      expect(restored.getEdgeCount()).toBe(2);
    });

    it('clone 应返回独立副本', () => {
      graph.addNode('a');
      graph.addNode('b');
      graph.addEdge('a', 'b');
      const cloned = graph.clone();
      cloned.addNode('c');
      expect(graph.hasNode('c')).toBe(false);
      expect(cloned.hasNode('c')).toBe(true);
    });

    it('clear 应清除所有节点和边', () => {
      graph.addNode('a');
      graph.addNode('b');
      graph.addEdge('a', 'b');
      graph.clear();
      expect(graph.getNodeCount()).toBe(0);
      expect(graph.getEdgeCount()).toBe(0);
    });
  });

  // ==========================================================================
  // 统计信息
  // ==========================================================================

  describe('统计信息', () => {
    it('空图统计应返回零', () => {
      const stats = graph.getStats();
      expect(stats.nodeCount).toBe(0);
      expect(stats.edgeCount).toBe(0);
      expect(stats.averageDegree).toBe(0);
      expect(stats.maxDepth).toBe(0);
      expect(stats.hasCycle).toBe(false);
    });

    it('有数据图统计应正确', () => {
      graph.addNode('a');
      graph.addNode('b');
      graph.addNode('c');
      graph.addEdge('a', 'b');
      graph.addEdge('b', 'c');
      const stats = graph.getStats();
      expect(stats.nodeCount).toBe(3);
      expect(stats.edgeCount).toBe(2);
      expect(stats.averageDegree).toBeCloseTo(2 / 3);
      expect(stats.hasCycle).toBe(false);
    });
  });
});
