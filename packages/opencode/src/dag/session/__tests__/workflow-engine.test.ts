// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

import { Effect } from 'effect';
import type { DAGConfig, DAGNodeConfig, DAGNodeSession, DAGNodeStatus } from '../types';
import { describe, expect, it } from 'bun:test';

// Helper to create a complete DAGNodeConfig
function makeNodeConfig(
  id: string,
  deps: string[] = [],
  required: boolean = true
): DAGNodeConfig {
  return {
    id,
    name: `Node ${id}`,
    description: `Test node ${id}`,
    required,
    dependencies: deps,
    worker_type: 'mock',
    worker_config: {},
  };
}

// Helper to create a complete DAGConfig
function makeConfig(
  nodes: DAGNodeConfig[],
  maxConcurrency: number = 3
): DAGConfig {
  return {
    name: 'test-workflow',
    description: 'Test workflow',
    nodes,
    max_concurrency: maxConcurrency,
  };
}

// Helper to create a complete DAGNodeSession
function makeNodeSession(
  nodeId: string,
  status: DAGNodeStatus,
  deps: string[] = [],
  required: boolean = true,
  workflowId: string = 'test-workflow'
): DAGNodeSession {
  return {
    node_id: nodeId,
    workflow_id: workflowId,
    config: makeNodeConfig(nodeId, deps, required),
    status,
    output: null,
    retry_count: 0,
    max_retries: 3,
    timeout_ms: 300000,
    required_nodes: [],
    dependencies: deps,
    metadata: {},
    start_time: status !== 'pending' ? Date.now() : null,
    end_time: (status === 'completed' || status === 'failed') ? Date.now() : null,
    duration_ms: null,
    completed_at: null,
    parent_node: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    logs: [],
  };
}

// Helper function to get ready nodes (pure logic)
function getReadyNodes(
  nodes: DAGNodeSession[],
  completedNodeIds: Set<string>,
  failedNodeIds: Set<string>,
  runningNodeIds: Set<string>
): DAGNodeSession[] {
  return nodes.filter(node => {
    const isNotRunning = !runningNodeIds.has(node.node_id);
    const isNotCompleted = !completedNodeIds.has(node.node_id);
    const isNotFailed = !failedNodeIds.has(node.node_id);
    const depsSatisfied = !node.dependencies || 
      node.dependencies.every(dep => completedNodeIds.has(dep));
    return isNotRunning && isNotCompleted && isNotFailed && depsSatisfied;
  });
}

describe('Workflow Engine - Dependency Logic', () => {
  it('should identify nodes with no dependencies as ready', () => {
    const nodes = [
      makeNodeSession('node-1', 'pending'),
      makeNodeSession('node-2', 'pending'),
      makeNodeSession('node-3', 'pending', ['node-1']),
    ];
    
    const completed = new Set<string>();
    const failed = new Set<string>();
    const running = new Set<string>();
    
    const ready = getReadyNodes(nodes, completed, failed, running);
    
    expect(ready).toHaveLength(2);
    expect(ready.map(n => n.node_id)).toEqual(['node-1', 'node-2']);
  });

  it('should wait for dependencies to complete', () => {
    const nodes = [
      makeNodeSession('node-1', 'completed'),
      makeNodeSession('node-2', 'pending', ['node-1']),
      makeNodeSession('node-3', 'pending', ['node-1', 'node-2']),
    ];
    
    const completed = new Set(['node-1']);
    const failed = new Set<string>();
    const running = new Set<string>();
    
    const ready = getReadyNodes(nodes, completed, failed, running);
    
    // Only node-2 is ready (node-3 waits for node-2)
    expect(ready).toHaveLength(1);
    expect(ready[0].node_id).toBe('node-2');
  });

  it('should not schedule nodes with failed dependencies', () => {
    const nodes = [
      makeNodeSession('node-1', 'failed'),
      makeNodeSession('node-2', 'pending', ['node-1']),
    ];
    
    const completed = new Set<string>();
    const failed = new Set(['node-1']);
    const running = new Set<string>();
    
    const ready = getReadyNodes(nodes, completed, failed, running);
    
    // node-2 should not be ready (node-1 failed)
    expect(ready).toHaveLength(0);
  });

  it('should handle diamond dependency pattern', () => {
    //      node-1
    //      /    \
    //  node-2  node-3
    //      \    /
    //      node-4
    const nodes = [
      makeNodeSession('node-1', 'completed'),
      makeNodeSession('node-2', 'completed', ['node-1']),
      makeNodeSession('node-3', 'completed', ['node-1']),
      makeNodeSession('node-4', 'pending', ['node-2', 'node-3']),
    ];
    
    const completed = new Set(['node-1', 'node-2', 'node-3']);
    const failed = new Set<string>();
    const running = new Set<string>();
    
    const ready = getReadyNodes(nodes, completed, failed, running);
    
    // Only node-4 should be ready
    expect(ready).toHaveLength(1);
    expect(ready[0].node_id).toBe('node-4');
  });

  it('should handle circular dependencies (all stuck)', () => {
    const nodes = [
      makeNodeSession('A', 'pending', ['C']),
      makeNodeSession('B', 'pending', ['A']),
      makeNodeSession('C', 'pending', ['B']),
    ];
    
    const completed = new Set<string>();
    const failed = new Set<string>();
    const running = new Set<string>();
    
    const ready = getReadyNodes(nodes, completed, failed, running);
    
    // All nodes have unsatisfied dependencies
    expect(ready).toHaveLength(0);
  });

  it('should handle empty workflow', () => {
    const nodes: DAGNodeSession[] = [];
    
    const completed = new Set<string>();
    const failed = new Set<string>();
    const running = new Set<string>();
    
    const ready = getReadyNodes(nodes, completed, failed, running);
    
    expect(ready).toHaveLength(0);
  });

  it('should handle self-dependency', () => {
    const nodes = [
      makeNodeSession('A', 'pending', ['A']),
    ];
    
    const completed = new Set<string>();
    const failed = new Set<string>();
    const running = new Set<string>();
    
    const ready = getReadyNodes(nodes, completed, failed, running);
    
    // Self-dependency, so not ready
    expect(ready).toHaveLength(0);
  });

  it('should handle complex workflow with multiple parallel paths', () => {
    // Path 1: A -> B -> E
    // Path 2: C -> D -> E
    const nodes = [
      makeNodeSession('A', 'completed'),
      makeNodeSession('B', 'pending', ['A']),
      makeNodeSession('C', 'completed'),
      makeNodeSession('D', 'completed', ['C']),
      makeNodeSession('E', 'pending', ['B', 'D']),
    ];
    
    const completed = new Set(['A', 'C', 'D']);
    const failed = new Set<string>();
    const running = new Set<string>();
    
    const ready = getReadyNodes(nodes, completed, failed, running);
    
    // B is ready (A complete), E is not ready (waits for B)
    expect(ready).toHaveLength(1);
    expect(ready[0].node_id).toBe('B');
  });
});
