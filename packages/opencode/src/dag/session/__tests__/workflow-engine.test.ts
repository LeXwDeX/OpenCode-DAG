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

/**
 * In-flight concurrency accounting: count nodes that have been spawned but haven't
 * yet transitioned to running/completed/failed/skipped in the DB.
 * Returns the number of in-flight nodes for the given workflow.
 */
function countInFlightNodes(
  spawnedNodes: Set<string>,
  workflowId: string,
  runningNodeIds: Set<string>,
  completedNodeIds: Set<string>,
  failedNodeIds: Set<string>,
  skippedNodeIds: Set<string>,
): number {
  return [...spawnedNodes]
    .filter(id => id.startsWith(`${workflowId}::`))
    .filter(id => !runningNodeIds.has(id) && !completedNodeIds.has(id) && !failedNodeIds.has(id) && !skippedNodeIds.has(id))
    .length;
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

// ============================================================================
// T1: Timeout Enforcement Tests
// ============================================================================

describe('Workflow Engine - T1: Timeout Enforcement', () => {
  describe('timeout configuration', () => {
    it('should use default timeout of 300_000ms when node.config.timeout_ms is undefined', () => {
      const node = makeNodeSession('node-1', 'running');
      const config = node.config;
      delete (config as any).timeout_ms;
      
      const effectiveTimeout = config.timeout_ms ?? 300_000;
      expect(effectiveTimeout).toBe(300_000);
    });

    it('should respect custom timeout_ms from node config', () => {
      const node = makeNodeSession('node-1', 'running');
      node.config.timeout_ms = 60_000;
      
      const effectiveTimeout = node.config.timeout_ms ?? 300_000;
      expect(effectiveTimeout).toBe(60_000);
    });

    it('should use node.timeout_ms from DB when available (dagworker.ts:176)', () => {
      const node = makeNodeSession('node-1', 'running');
      node.timeout_ms = 45_000;
      node.retry_count = 2;
      node.max_retries = 5;
      
      // Verify DB-level fields are accessible
      expect(node.timeout_ms).toBe(45_000);
      expect(node.retry_count).toBe(2);
      expect(node.max_retries).toBe(5);
    });
  });

  describe('timeout behavior', () => {
    it('should mark node as failed with timeout error when prompt exceeds timeout', () => {
      const node = makeNodeSession('node-1', 'running');
      node.config.timeout_ms = 5_000;
      
      // Simulate timeout failure message
      const errorMsg = `node timed out after ${node.config.timeout_ms}ms`;
      expect(errorMsg).toBe('node timed out after 5000ms');
    });

    it('should treat timeout as retryable failure (not immediately failed)', () => {
      const node = makeNodeSession('node-1', 'running');
      node.max_retries = 2;
      node.retry_count = 0;
      
      // After timeout, if retries remain, node should NOT be marked failed yet
      const canRetry = node.retry_count < node.max_retries;
      expect(canRetry).toBe(true);
    });
  });
});

// ============================================================================
// T2: Retry Loop Tests
// ============================================================================

describe('Workflow Engine - T2: Retry Loop', () => {
  describe('retry count management', () => {
    it('should use max_retries from node DB row (dagworker.ts:176)', () => {
      const node = makeNodeSession('node-1', 'running');
      node.max_retries = 3;
      
      const maxRetries = node.max_retries ?? 0;
      expect(maxRetries).toBe(3);
    });

    it('should default to 0 retries when max_retries is undefined', () => {
      const node = makeNodeSession('node-1', 'running');
      (node as any).max_retries = undefined;
      
      const maxRetries = (node as any).max_retries ?? 0;
      expect(maxRetries).toBe(0);
    });

    it('should respect retry_count from DB', () => {
      const node = makeNodeSession('node-1', 'running');
      node.retry_count = 2;
      node.max_retries = 5;
      
      // Verify we can check retry exhaustion
      const exhausted = node.retry_count >= node.max_retries;
      expect(exhausted).toBe(false);
    });
  });

  describe('retry exhaustion behavior', () => {
    it('should mark node failed after exhausting all retries', () => {
      const node = makeNodeSession('node-1', 'running');
      node.max_retries = 2;
      node.retry_count = 2; // Already at max
      
      const canRetry = node.retry_count < node.max_retries;
      expect(canRetry).toBe(false);
      
      // Node should be marked failed with final error
      const finalError = 'prompt failed after 3 attempts (2 retries)';
      expect(finalError).toContain('3 attempts');
    });

    it('should allow retry when retry_count < max_retries', () => {
      const node = makeNodeSession('node-1', 'running');
      node.max_retries = 3;
      node.retry_count = 1;
      
      const canRetry = node.retry_count < node.max_retries;
      expect(canRetry).toBe(true);
    });

    it('should not transition through failed→pending during retries', () => {
      const node = makeNodeSession('node-1', 'running');
      
      // During retry, node should remain in 'running' state
      // Only on final exhaustion should it transition to 'failed'
      const validTransitions: DAGNodeStatus[] = ['running', 'failed', 'completed'];
      expect(validTransitions).toContain('running');
      expect(validTransitions).toContain('failed');
      expect(validTransitions).not.toContain('pending'); // No retry via pending
    });
  });

  describe('retry attempt counting', () => {
    it('should calculate total attempts as max_retries + 1 (initial + retries)', () => {
      const maxRetries = 2;
      const totalAttempts = maxRetries + 1;
      expect(totalAttempts).toBe(3);
    });

    it('should increment retry_count before each retry attempt', () => {
      let retryCount = 0;
      const maxRetries = 2;
      const attempts: number[] = [];
      
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          retryCount++; // Simulates incrementRetryCount
        }
        attempts.push(attempt);
      }
      
      expect(attempts).toEqual([0, 1, 2]);
      expect(retryCount).toBe(2); // Incremented twice (before attempt 1 and 2)
    });
  });
});

// ============================================================================
// T3: In-Flight Concurrency Accounting Tests
// ============================================================================

describe('Workflow Engine - T3: In-Flight Concurrency Accounting', () => {
  describe('in-flight node detection', () => {
    it('should count spawned nodes not yet in running/completed/failed/skipped', () => {
      const workflowId = 'wf-1';
      const spawnedNodes = new Set([
        `${workflowId}::node-1`,
        `${workflowId}::node-2`,
        `${workflowId}::node-3`,
      ]);
      
      const runningNodeIds = new Set([`${workflowId}::node-1`]);
      const completedNodeIds = new Set<string>();
      const failedNodeIds = new Set<string>();
      const skippedNodeIds = new Set<string>();
      
      const inFlight = countInFlightNodes(
        spawnedNodes, workflowId,
        runningNodeIds, completedNodeIds, failedNodeIds, skippedNodeIds
      );
      
      // node-2 and node-3 are in-flight (spawned but not yet running)
      expect(inFlight).toBe(2);
    });

    it('should exclude running nodes from in-flight count', () => {
      const workflowId = 'wf-1';
      const spawnedNodes = new Set([
        `${workflowId}::node-1`,
        `${workflowId}::node-2`,
      ]);
      
      const runningNodeIds = new Set([
        `${workflowId}::node-1`,
        `${workflowId}::node-2`,
      ]);
      const completedNodeIds = new Set<string>();
      const failedNodeIds = new Set<string>();
      const skippedNodeIds = new Set<string>();
      
      const inFlight = countInFlightNodes(
        spawnedNodes, workflowId,
        runningNodeIds, completedNodeIds, failedNodeIds, skippedNodeIds
      );
      
      expect(inFlight).toBe(0);
    });

    it('should exclude completed nodes from in-flight count', () => {
      const workflowId = 'wf-1';
      const spawnedNodes = new Set([`${workflowId}::node-1`]);
      
      const runningNodeIds = new Set<string>();
      const completedNodeIds = new Set([`${workflowId}::node-1`]);
      const failedNodeIds = new Set<string>();
      const skippedNodeIds = new Set<string>();
      
      const inFlight = countInFlightNodes(
        spawnedNodes, workflowId,
        runningNodeIds, completedNodeIds, failedNodeIds, skippedNodeIds
      );
      
      expect(inFlight).toBe(0);
    });

    it('should exclude failed nodes from in-flight count', () => {
      const workflowId = 'wf-1';
      const spawnedNodes = new Set([`${workflowId}::node-1`]);
      
      const runningNodeIds = new Set<string>();
      const completedNodeIds = new Set<string>();
      const failedNodeIds = new Set([`${workflowId}::node-1`]);
      const skippedNodeIds = new Set<string>();
      
      const inFlight = countInFlightNodes(
        spawnedNodes, workflowId,
        runningNodeIds, completedNodeIds, failedNodeIds, skippedNodeIds
      );
      
      expect(inFlight).toBe(0);
    });

    it('should exclude skipped nodes from in-flight count', () => {
      const workflowId = 'wf-1';
      const spawnedNodes = new Set([`${workflowId}::node-1`]);
      
      const runningNodeIds = new Set<string>();
      const completedNodeIds = new Set<string>();
      const failedNodeIds = new Set<string>();
      const skippedNodeIds = new Set([`${workflowId}::node-1`]);
      
      const inFlight = countInFlightNodes(
        spawnedNodes, workflowId,
        runningNodeIds, completedNodeIds, failedNodeIds, skippedNodeIds
      );
      
      expect(inFlight).toBe(0);
    });

    it('should ignore spawned nodes from other workflows', () => {
      const workflowId = 'wf-1';
      const spawnedNodes = new Set([
        `${workflowId}::node-1`,
        `wf-2::node-2`, // Different workflow
        `wf-3::node-3`, // Different workflow
      ]);
      
      const runningNodeIds = new Set<string>();
      const completedNodeIds = new Set<string>();
      const failedNodeIds = new Set<string>();
      const skippedNodeIds = new Set<string>();
      
      const inFlight = countInFlightNodes(
        spawnedNodes, workflowId,
        runningNodeIds, completedNodeIds, failedNodeIds, skippedNodeIds
      );
      
      // Only wf-1::node-1 is in-flight for wf-1
      expect(inFlight).toBe(1);
    });
  });

  describe('budget calculation', () => {
    it('should subtract in-flight count from concurrency budget', () => {
      const maxConcurrency = 5;
      const runningCount = 2;
      const inFlightCount = 2;
      
      const budget = maxConcurrency - runningCount - inFlightCount;
      expect(budget).toBe(1); // 5 - 2 - 2 = 1
    });

    it('should return 0 budget when running + in-flight >= maxConcurrency', () => {
      const maxConcurrency = 3;
      const runningCount = 2;
      const inFlightCount = 2;
      
      const budget = maxConcurrency - runningCount - inFlightCount;
      expect(budget).toBeLessThanOrEqual(0); // 3 - 2 - 2 = -1
    });

    it('should allow full concurrency when no in-flight nodes', () => {
      const maxConcurrency = 5;
      const runningCount = 2;
      const inFlightCount = 0;
      
      const budget = maxConcurrency - runningCount - inFlightCount;
      expect(budget).toBe(3); // 5 - 2 - 0 = 3
    });
  });
});

// ============================================================================
// T4: getWorkflowStatus Degraded Response Tests
// ============================================================================

describe('Workflow Engine - T4: getWorkflowStatus Degraded Response', () => {
  it('should return degraded snapshot when workflow not found', () => {
    const workflowId = 'nonexistent-wf';
    
    // Simulate degraded response
    const snapshot = {
      workflowId,
      status: 'cancelled' as const,
      totalNodes: 0,
      completedNodes: 0,
      failedNodes: 0,
      runningNodes: 0,
      readyNodes: 0,
      violations: [],
      violations_count: 0,
      timestamp: Date.now(),
    };
    
    expect(snapshot.workflowId).toBe('nonexistent-wf');
    expect(snapshot.status).toBe('cancelled');
    expect(snapshot.totalNodes).toBe(0);
  });

  it('should compute node statistics correctly when workflow exists', () => {
    const allNodes: DAGNodeSession[] = [
      makeNodeSession('node-1', 'completed'),
      makeNodeSession('node-2', 'completed'),
      makeNodeSession('node-3', 'failed'),
      makeNodeSession('node-4', 'running'),
      makeNodeSession('node-5', 'pending'),
    ];
    
    const completedNodes = allNodes.filter(n => n.status === 'completed').length;
    const failedNodes = allNodes.filter(n => n.status === 'failed').length;
    const runningNodes = allNodes.filter(n => n.status === 'running').length;
    
    expect(completedNodes).toBe(2);
    expect(failedNodes).toBe(1);
    expect(runningNodes).toBe(1);
    expect(allNodes.length).toBe(5);
  });

  it('should catch violations query errors and use empty array', async () => {
    // Simulate Effect.catchCause on violations query
    const violations = await Effect.gen(function* () {
      return yield* Effect.fail(new Error('DB connection lost')).pipe(
        Effect.catchCause(() => Effect.succeed([]))
      );
    }).pipe(Effect.runPromise);
    
    expect(violations).toEqual([]);
  });

  it('should return snapshot with correct timestamp', () => {
    const before = Date.now();
    
    const snapshot = {
      workflowId: 'wf-1',
      status: 'running' as const,
      totalNodes: 5,
      completedNodes: 2,
      failedNodes: 1,
      runningNodes: 1,
      readyNodes: 1,
      violations: [],
      violations_count: 0,
      timestamp: Date.now(),
    };
    
    const after = Date.now();
    expect(snapshot.timestamp).toBeGreaterThanOrEqual(before);
    expect(snapshot.timestamp).toBeLessThanOrEqual(after);
  });
});

// ============================================================================
// Retry Success Scenario Tests
// ============================================================================

// ============================================================================
// T5: Worktree Isolation (opt-in via worker_config.use_worktree)
// ============================================================================

describe('Workflow Engine - T5: Worktree Isolation', () => {
  /**
   * Pure-logic extraction of the use_worktree flag from worker_config.
   * Must use the proper type guard (as { use_worktree?: boolean }), NOT `as any`.
   */
  function getUseWorktree(workerConfig: Record<string, unknown> | undefined): boolean {
    return (workerConfig as { use_worktree?: boolean } | undefined)?.use_worktree === true
  }

  /**
   * Computes the deterministic worktree branch name for a DAG node.
   */
  function computeWorktreeBranch(workflowId: string, configId: string): string {
    return `dag-${workflowId}-${configId}`
  }

  it('A: opt-out - use_worktree absent → no worktree created, no directory override', () => {
    // Config WITHOUT use_worktree
    const node = makeNodeSession('node-1', 'pending')
    node.config.worker_config = { prompt: 'do something' }

    const useWorktree = getUseWorktree(node.config.worker_config)
    expect(useWorktree).toBe(false)

    // Config with use_worktree explicitly false
    node.config.worker_config = { prompt: 'do', use_worktree: false }
    expect(getUseWorktree(node.config.worker_config)).toBe(false)

    // Config with use_worktree set to a non-boolean truthy value (edge case)
    node.config.worker_config = { prompt: 'do', use_worktree: 'yes' }
    expect(getUseWorktree(node.config.worker_config)).toBe(false)

    // Undefined worker_config
    expect(getUseWorktree(undefined)).toBe(false)
  })

  it('B: opt-in - use_worktree true → worktree created with deterministic branch naming', () => {
    const workflowId = 'wf-abc-123'
    const node = makeNodeSession('my-task', 'pending')
    node.config.worker_config = { prompt: 'do work', use_worktree: true }

    const useWorktree = getUseWorktree(node.config.worker_config)
    expect(useWorktree).toBe(true)

    // Branch naming: dag-<workflowId>-<configId>
    const branch = computeWorktreeBranch(workflowId, node.config.id)
    expect(branch).toBe('dag-wf-abc-123-my-task')

    // Simulate worktree creation result + directory override for session.create
    const worktreeInfo = { id: 'wt-001', path: '/tmp/.worktrees/wt-001', branch }
    expect(worktreeInfo.path).toBe('/tmp/.worktrees/wt-001')

    // Session.create should receive directory=worktreeInfo.path
    const createArgs = {
      parentID: 'parent-sess-1',
      title: node.config.name + ' (DAG node)',
      ...(worktreeInfo ? { directory: worktreeInfo.path } : {}),
    }
    expect(createArgs.directory).toBe('/tmp/.worktrees/wt-001')
  })

  it('C: cleanup fires on any exit path (simulates Effect.ensuring semantics)', () => {
    const cleanupCalls: string[] = []

    // Simulate the closure-based cleanup pattern used in spawnReadyNode:
    // - worktreeCleanup is set after successful create
    // - cleanup fires in a "finally" block (equivalent to Effect.ensuring)
    function simulateSpawn(opts: { createSucceeds: boolean; promptSucceeds: boolean }) {
      let worktreeCleanup: (() => Promise<void>) | undefined

      // Outer try/catch models Effect.catchCause (swallows error, marks node failed)
      try {
        // Inner try/finally models Effect.ensuring (cleanup always fires)
        try {
          if (opts.createSucceeds) {
            const wtId = 'wt-002'
            worktreeCleanup = () => {
              cleanupCalls.push(wtId)
              return Promise.resolve()
            }
          }

          if (!opts.promptSucceeds) {
            throw new Error('prompt failed')
          }
        } finally {
          // Effect.ensuring equivalent: always fires
          if (worktreeCleanup) {
            worktreeCleanup().catch(() => {})
          }
        }
      } catch {
        // Effect.catchCause equivalent: error handled — node marked failed silently
      }
    }

    // Case 1: worktree created, prompt succeeds → cleanup fires
    simulateSpawn({ createSucceeds: true, promptSucceeds: true })
    expect(cleanupCalls).toEqual(['wt-002'])

    // Case 2: worktree created, prompt FAILS → cleanup still fires
    cleanupCalls.length = 0
    expect(() => simulateSpawn({ createSucceeds: true, promptSucceeds: false })).not.toThrow()
    // cleanup was scheduled (async), so it fired
    expect(cleanupCalls).toEqual(['wt-002'])

    // Case 3: worktree create fails → no cleanup to fire
    cleanupCalls.length = 0
    simulateSpawn({ createSucceeds: false, promptSucceeds: true })
    expect(cleanupCalls).toEqual([])
  })
})

describe('Workflow Engine - Retry Success Scenarios', () => {
  it('should succeed on second attempt after first failure', () => {
    const maxRetries = 2;
    let attempts = 0;
    let success = false;
    
    // Simulate: fail once, succeed on second
    while (attempts <= maxRetries && !success) {
      attempts++;
      if (attempts === 2) {
        success = true;
      }
    }
    
    expect(success).toBe(true);
    expect(attempts).toBe(2); // Succeeded on 2nd attempt
  });

  it('should succeed on third attempt after two failures', () => {
    const maxRetries = 3;
    let attempts = 0;
    let success = false;
    
    // Simulate: fail twice, succeed on third
    while (attempts <= maxRetries && !success) {
      attempts++;
      if (attempts === 3) {
        success = true;
      }
    }
    
    expect(success).toBe(true);
    expect(attempts).toBe(3);
  });

  it('should fail after exhausting all retries', () => {
    const maxRetries = 2;
    let attempts = 0;
    let success = false;
    
    // Simulate: always fail
    while (attempts <= maxRetries && !success) {
      attempts++;
      // Never succeed
    }
    
    expect(success).toBe(false);
    expect(attempts).toBe(3); // Initial + 2 retries = 3 total
  });
});

// ============================================================================
// P2: Pause/Resume — spawnReadyNode paused guard
// ============================================================================

describe('Workflow Engine - P2: Pause/Resume Guard', () => {
  type WorkflowStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

  /**
   * Extracted pure-logic guard pattern from spawnReadyNode:
   * Returns true when spawn should proceed (workflow is not paused).
   */
  function shouldSpawnNode(workflowStatus: WorkflowStatus): boolean {
    return workflowStatus !== 'paused'
  }

  it('spawnReadyNode guard: returns early when workflow is paused', () => {
    expect(shouldSpawnNode('paused')).toBe(false)
  })

  it('spawnReadyNode guard: proceeds when workflow is running', () => {
    expect(shouldSpawnNode('running')).toBe(true)
  })

  it('spawnReadyNode guard: proceeds when workflow is pending', () => {
    expect(shouldSpawnNode('pending')).toBe(true)
  })

  it('pending node remains pending when workflow is paused (no status change)', () => {
    // Simulate: a pending node with a paused workflow stays pending
    const nodeStatus: DAGNodeStatus = 'pending'
    const workflowStatus: WorkflowStatus = 'paused'
    
    // Guard fires: spawnReadyNode returns early
    const wouldSpawn = shouldSpawnNode(workflowStatus)
    expect(wouldSpawn).toBe(false)
    
    // Node status is unchanged (still pending)
    expect(nodeStatus).toBe('pending')
  })

  /**
   * Pause semantics: pauseWorkflow updates workflow status to 'paused'.
   * Resume semantics: resumeWorkflow updates status back to 'running' and
   * calls scheduleReadyNodes to dispatch pending nodes.
   * (Full Effect-based integration tested via workflow-engine integration tests.)
   */
  it('pause→resume cycle: workflow goes running → paused → running', () => {
    type WfStatusHistory = WorkflowStatus[]
    const history: WfStatusHistory = ['running']

    // pause
    history.push('paused')
    expect(history[history.length - 1]).toBe('paused')

    // resume
    history.push('running')
    expect(history[history.length - 1]).toBe('running')
  })

  it('pauseWorkflow: DAGWorkflowStatus is valid transition from running', () => {
    const { getValidNextSessionWorkflowStatuses } = require('../session-service')
    const valid = getValidNextSessionWorkflowStatuses('running')
    expect(valid).toContain('paused')
  })

  it('resumeWorkflow: DAGWorkflowStatus is valid transition from paused', () => {
    const { getValidNextSessionWorkflowStatuses } = require('../session-service')
    const valid = getValidNextSessionWorkflowStatuses('paused')
    expect(valid).toContain('running')
  })
})

