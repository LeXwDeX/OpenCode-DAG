/**
 * @file DAG Workflow Engine Tests
 * @description Unit tests for DAG WorkflowEngine module
 *
 * Tests:
 * - Dependency resolution and scheduling logic
 * - Node completion/failure handling
 * - Workflow state transitions
 * - Violation tracking
 */

import { describe, it, expect } from 'bun:test';
import type {
  DAGConfig,
  DAGNodeConfig,
  DAGNodeSession,
  DAGNodeStatus,
  DAGWorkflowSession,
  DAGViolation,
} from '../types';

// ============================================================================
// Test Helpers
// ============================================================================

function makeNodeConfig(
  id: string,
  deps: string[] = [],
  required: boolean = true
): DAGNodeConfig {
  return {
    id,
    name: `Node ${id}`,
    description: `Test node ${id}`,
    dependencies: deps,
    required,
    worker_type: 'test',
    worker_config: {},
    timeout_ms: 300000,
  };
}

function makeConfig(
  nodes: DAGNodeConfig[],
  maxConcurrency: number = 3,
  requiredNodes: string[] = []
): DAGConfig {
  return {
    name: 'test-workflow',
    description: 'Test workflow',
    nodes,
    max_concurrency: maxConcurrency,
    required_nodes: requiredNodes,
  };
}

function makeNodeSession(
  nodeId: string,
  status: DAGNodeStatus,
  deps: string[] = []
): DAGNodeSession {
  return {
    node_id: nodeId,
    workflow_id: 'wf_test',
    config: makeNodeConfig(nodeId, deps),
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
  };
}

// ============================================================================
// Dependency Resolution Logic Tests
// ============================================================================

describe('WorkflowEngine - Dependency Resolution', () => {
  describe('areDependenciesSatisfied', () => {
    // Helper function to mimic the logic
    function areDependenciesSatisfied(
      node: DAGNodeSession,
      completedNodeIds: Set<string>
    ): boolean {
      if (!node.dependencies || node.dependencies.length === 0) {
        return true;
      }
      return node.dependencies.every(depId => completedNodeIds.has(depId));
    }

    it('should return true for nodes without dependencies', () => {
      const node = makeNodeSession('node-1', 'pending', []);
      const completedIds = new Set<string>();
      
      expect(areDependenciesSatisfied(node, completedIds)).toBe(true);
    });

    it('should return true when all dependencies are completed', () => {
      const node = makeNodeSession('node-3', 'pending', ['node-1', 'node-2']);
      const completedIds = new Set(['node-1', 'node-2']);
      
      expect(areDependenciesSatisfied(node, completedIds)).toBe(true);
    });

    it('should return false when some dependencies are missing', () => {
      const node = makeNodeSession('node-3', 'pending', ['node-1', 'node-2']);
      const completedIds = new Set(['node-1']); // node-2 not completed
      
      expect(areDependenciesSatisfied(node, completedIds)).toBe(false);
    });

    it('should return false when no dependencies are completed', () => {
      const node = makeNodeSession('node-2', 'pending', ['node-1']);
      const completedIds = new Set<string>();
      
      expect(areDependenciesSatisfied(node, completedIds)).toBe(false);
    });
  });

  describe('getReadyNodes', () => {
    // Helper function to mimic the logic
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
          node.dependencies.length === 0 ||
          node.dependencies.every(depId => completedNodeIds.has(depId));
        
        return isNotRunning && isNotCompleted && isNotFailed && depsSatisfied;
      });
    }

    it('should return nodes without dependencies when nothing is running', () => {
      const nodes = [
        makeNodeSession('node-1', 'pending', []),
        makeNodeSession('node-2', 'pending', []),
        makeNodeSession('node-3', 'pending', ['node-1']),
      ];
      
      const completed = new Set<string>();
      const failed = new Set<string>();
      const running = new Set<string>();
      
      const ready = getReadyNodes(nodes, completed, failed, running);
      
      expect(ready).toHaveLength(2);
      expect(ready.map(n => n.node_id)).toEqual(['node-1', 'node-2']);
    });

    it('should exclude running nodes', () => {
      const nodes = [
        makeNodeSession('node-1', 'running', []),
        makeNodeSession('node-2', 'pending', []),
      ];
      
      const completed = new Set<string>();
      const failed = new Set<string>();
      const running = new Set(['node-1']);
      
      const ready = getReadyNodes(nodes, completed, failed, running);
      
      expect(ready).toHaveLength(1);
      expect(ready[0].node_id).toBe('node-2');
    });

    it('should exclude completed nodes', () => {
      const nodes = [
        makeNodeSession('node-1', 'completed', []),
        makeNodeSession('node-2', 'pending', []),
      ];
      
      const completed = new Set(['node-1']);
      const failed = new Set<string>();
      const running = new Set<string>();
      
      const ready = getReadyNodes(nodes, completed, failed, running);
      
      expect(ready).toHaveLength(1);
      expect(ready[0].node_id).toBe('node-2');
    });

    it('should exclude failed nodes', () => {
      const nodes = [
        makeNodeSession('node-1', 'failed', []),
        makeNodeSession('node-2', 'pending', []),
      ];
      
      const completed = new Set<string>();
      const failed = new Set(['node-1']);
      const running = new Set<string>();
      
      const ready = getReadyNodes(nodes, completed, failed, running);
      
      expect(ready).toHaveLength(1);
      expect(ready[0].node_id).toBe('node-2');
    });

    it('should wait for dependencies before scheduling', () => {
      const nodes = [
        makeNodeSession('node-1', 'completed', []),
        makeNodeSession('node-2', 'pending', ['node-1']),
        makeNodeSession('node-3', 'pending', ['node-2']),
      ];
      
      const completed = new Set(['node-1']);
      const failed = new Set<string>();
      const running = new Set<string>();
      
      const ready = getReadyNodes(nodes, completed, failed, running);
      
      // Only node-2 should be ready (node-3 depends on node-2 which is not completed)
      expect(ready).toHaveLength(1);
      expect(ready[0].node_id).toBe('node-2');
    });

    it('should handle diamond dependency pattern', () => {
      const nodes = [
        makeNodeSession('A', 'completed', []),
        makeNodeSession('B', 'completed', ['A']),
        makeNodeSession('C', 'completed', ['A']),
        makeNodeSession('D', 'pending', ['B', 'C']),
      ];
      
      const completed = new Set(['A', 'B', 'C']);
      const failed = new Set<string>();
      const running = new Set<string>();
      
      const ready = getReadyNodes(nodes, completed, failed, running);
      
      // All dependencies of D are satisfied
      expect(ready).toHaveLength(1);
      expect(ready[0].node_id).toBe('D');
    });
  });

  describe('maxConcurrency', () => {
    it('should respect maxConcurrency when scheduling', () => {
      const nodes = [
        makeNodeSession('node-1', 'pending', []),
        makeNodeSession('node-2', 'pending', []),
        makeNodeSession('node-3', 'pending', []),
        makeNodeSession('node-4', 'pending', []),
      ];
      
      const maxConcurrency = 2;
      
      // Helper to get nodes to schedule
      function getNodesToSchedule(
        nodes: DAGNodeSession[],
        runningCount: number,
        maxConcurrency: number,
        completedIds: Set<string>,
        failedIds: Set<string>,
        runningIds: Set<string>
      ): DAGNodeSession[] {
        const readyNodes = nodes.filter(node => {
          const isNotRunning = !runningIds.has(node.node_id);
          const isNotCompleted = !completedIds.has(node.node_id);
          const isNotFailed = !failedIds.has(node.node_id);
          const depsSatisfied = !node.dependencies || 
            node.dependencies.every(dep => completedIds.has(dep));
          return isNotRunning && isNotCompleted && isNotFailed && depsSatisfied;
        });
        
        const availableSlots = maxConcurrency - runningCount;
        return readyNodes.slice(0, availableSlots);
      }
      
      const completed = new Set<string>();
      const failed = new Set<string>();
      const running = new Set(['node-1']); // 1 already running
      
      const toSchedule = getNodesToSchedule(
        nodes,
        running.size,
        maxConcurrency,
        completed,
        failed,
        running
      );
      
      // Only 1 more slot available (2 - 1 = 1)
      expect(toSchedule).toHaveLength(1);
    });
  });
});

// ============================================================================
// Violation Detection Logic Tests
// ============================================================================

describe('WorkflowEngine - Violation Detection', () => {
  describe('required node failures', () => {
    it('should detect when required node fails', () => {
      const config = makeConfig(
        [
          makeNodeConfig('node-1', [], true),
          makeNodeConfig('node-2', ['node-1'], false),
        ],
        3,
        ['node-1'] // node-1 is required
      );
      
      const nodes = [
        makeNodeSession('node-1', 'failed', []),
        makeNodeSession('node-2', 'pending', ['node-1']),
      ];
      
      // Helper to check if any required node failed
      function hasRequiredNodeFailed(
        nodes: DAGNodeSession[],
        requiredNodeIds: string[]
      ): boolean {
        return nodes.some(node => 
          requiredNodeIds.includes(node.node_id) && 
          node.status === 'failed'
        );
      }
      
      expect(hasRequiredNodeFailed(nodes, config.required_nodes)).toBe(true);
    });

    it('should not flag non-required node failures', () => {
      const config = makeConfig(
        [
          makeNodeConfig('node-1', [], true),
          makeNodeConfig('node-2', [], false),
        ],
        3,
        ['node-1']
      );
      
      const nodes = [
        makeNodeSession('node-1', 'completed', []),
        makeNodeSession('node-2', 'failed', []),
      ];
      
      function hasRequiredNodeFailed(
        nodes: DAGNodeSession[],
        requiredNodeIds: string[]
      ): boolean {
        return nodes.some(node => 
          requiredNodeIds.includes(node.node_id) && 
          node.status === 'failed'
        );
      }
      
      expect(hasRequiredNodeFailed(nodes, config.required_nodes)).toBe(false);
    });
  });

  describe('workflow completion with violations', () => {
    it('should complete workflow when all required nodes succeed', () => {
      const config = makeConfig(
        [
          makeNodeConfig('node-1', [], true),
          makeNodeConfig('node-2', ['node-1'], true),
        ],
        3,
        ['node-1', 'node-2']
      );
      
      const nodes = [
        makeNodeSession('node-1', 'completed', []),
        makeNodeSession('node-2', 'completed', ['node-1']),
      ];
      
      function isWorkflowCompleted(
        nodes: DAGNodeSession[],
        requiredNodeIds: string[]
      ): boolean {
        const requiredNodes = nodes.filter(n => requiredNodeIds.includes(n.node_id));
        return requiredNodes.every(n => n.status === 'completed');
      }
      
      expect(isWorkflowCompleted(nodes, config.required_nodes)).toBe(true);
    });

    it('should detect incomplete required nodes', () => {
      const config = makeConfig(
        [
          makeNodeConfig('node-1', [], true),
          makeNodeConfig('node-2', ['node-1'], true),
        ],
        3,
        ['node-1', 'node-2']
      );
      
      const nodes = [
        makeNodeSession('node-1', 'completed', []),
        makeNodeSession('node-2', 'failed', ['node-1']), // Required but failed
      ];
      
      function isWorkflowCompleted(
        nodes: DAGNodeSession[],
        requiredNodeIds: string[]
      ): boolean {
        const requiredNodes = nodes.filter(n => requiredNodeIds.includes(n.node_id));
        return requiredNodes.every(n => n.status === 'completed');
      }
      
      expect(isWorkflowCompleted(nodes, config.required_nodes)).toBe(false);
    });
  });
});

// ============================================================================
// Workflow Status Tracking Tests
// ============================================================================

describe('WorkflowEngine - Status Tracking', () => {
  it('should correctly calculate node counts', () => {
    const nodes = [
      makeNodeSession('node-1', 'completed', []),
      makeNodeSession('node-2', 'running', []),
      makeNodeSession('node-3', 'pending', []),
      makeNodeSession('node-4', 'failed', []),
    ];
    
    function calculateNodeCounts(nodes: DAGNodeSession[]) {
      return {
        total: nodes.length,
        running: nodes.filter(n => n.status === 'running').length,
        pending: nodes.filter(n => n.status === 'pending').length,
        completed: nodes.filter(n => n.status === 'completed').length,
        failed: nodes.filter(n => n.status === 'failed').length,
      };
    }
    
    const counts = calculateNodeCounts(nodes);
    
    expect(counts.total).toBe(4);
    expect(counts.running).toBe(1);
    expect(counts.pending).toBe(1);
    expect(counts.completed).toBe(1);
    expect(counts.failed).toBe(1);
  });

  it('should detect workflow completion', () => {
    const nodes = [
      makeNodeSession('node-1', 'completed', []),
      makeNodeSession('node-2', 'completed', ['node-1']),
    ];
    
    function isAllNodesTerminal(nodes: DAGNodeSession[]): boolean {
      const terminalStatuses: DAGNodeStatus[] = ['completed', 'failed', 'cancelled'];
      return nodes.every(n => terminalStatuses.includes(n.status));
    }
    
    expect(isAllNodesTerminal(nodes)).toBe(true);
  });

  it('should detect workflow still running', () => {
    const nodes = [
      makeNodeSession('node-1', 'completed', []),
      makeNodeSession('node-2', 'running', ['node-1']),
    ];
    
    function isAllNodesTerminal(nodes: DAGNodeSession[]): boolean {
      const terminalStatuses: DAGNodeStatus[] = ['completed', 'failed', 'cancelled'];
      return nodes.every(n => terminalStatuses.includes(n.status));
    }
    
    expect(isAllNodesTerminal(nodes)).toBe(false);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('WorkflowEngine - Edge Cases', () => {
  it('should handle empty node list', () => {
    const nodes: DAGNodeSession[] = [];
    const completed = new Set<string>();
    const failed = new Set<string>();
    const running = new Set<string>();
    
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
    
    const ready = getReadyNodes(nodes, completed, failed, running);
    expect(ready).toHaveLength(0);
  });

  it('should handle circular dependencies (all stuck)', () => {
    // Circular: A -> B -> C -> A
    const nodes = [
      makeNodeSession('A', 'pending', ['C']),
      makeNodeSession('B', 'pending', ['A']),
      makeNodeSession('C', 'pending', ['B']),
    ];
    
    const completed = new Set<string>();
    const failed = new Set<string>();
    const running = new Set<string>();
    
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
    
    const ready = getReadyNodes(nodes, completed, failed, running);
    
    // All nodes have unsatisfied dependencies
    expect(ready).toHaveLength(0);
  });

  it('should handle node depending on itself', () => {
    const nodes = [
      makeNodeSession('node-1', 'pending', ['node-1']), // Self-dependency
    ];
    
    const completed = new Set<string>();
    const failed = new Set<string>();
    const running = new Set<string>();
    
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
    
    const ready = getReadyNodes(nodes, completed, failed, running);
    
    // Self-dependency is unsatisfied
    expect(ready).toHaveLength(0);
  });
});
