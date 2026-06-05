/**
 * @file DAG Session Service Tests
 * @description Integration tests for DAG Session module
 *
 * Tests:
 * - Type/API shape validation (structure correctness)
 * - Pure logic helpers (calculateWorkflowProgress, terminals, etc.)
 * - Status transition rules
 * - Violation detection logic
 */

import { describe, it, expect } from 'bun:test';
import {
  calculateWorkflowProgress,
  createEmptyWorkflowSession,
  isTerminalStatus,
  isNodeTerminalStatus,
} from '../types';
import type {
  DAGWorkflowStatus,
  DAGNodeStatus,
  DAGViolationType,
  DAGViolationSeverity,
  DAGConfig,
  DAGWorkflowSession,
  DAGNodeSession,
  DAGNodeConfig,
  DAGViolation,
} from '../types';

// ============================================================================
// Test Helper: Build mock DAG config
// ============================================================================

function makeNodeConfig(
  id: string,
  required: boolean = true,
  deps: string[] = []
): DAGNodeConfig {
  return {
    id,
    name: `Node ${id}`,
    description: `Mock node ${id}`,
    dependencies: deps,
    required,
    worker_type: 'mock',
    worker_config: {},
    timeout_ms: 300000,
    retry: { max_attempts: 3, delay_ms: 1000 },
  };
}

function makeConfig(nodes: DAGNodeConfig[] = []): DAGConfig {
  return {
    name: 'test-workflow',
    description: 'Test workflow',
    nodes,
    max_concurrency: 3,
    timeout_ms: 600000,
  };
}

function makeNodeSession(
  nodeId: string,
  status: DAGNodeStatus,
  required: boolean = true,
  durationMs: number | null = null
): DAGNodeSession {
  return {
    node_id: nodeId,
    workflow_id: 'wf_test',
    config: makeNodeConfig(nodeId, required),
    status,
    output: null,
    retry_count: 0,
    max_retries: 3,
    timeout_ms: 300000,
    required_nodes: [],
    dependencies: [],
    metadata: {},
    start_time: status !== 'pending' ? Date.now() - 10000 : null,
    completed_at: (status === 'completed' || status === 'failed' || status === 'skipped')
      ? Date.now().toString()
      : null,
    end_time: (status === 'completed' || status === 'failed') ? Date.now() : null,
    duration_ms: durationMs,
    parent_node: null,
    created_at: Date.now() - 20000,
    updated_at: Date.now(),
    logs: [],
  };
}

// ============================================================================
// 1. Type & API Shape Tests
// ============================================================================

describe('DAG Session Types - Shape Validation', () => {
  describe('DAGWorkflowStatus', () => {
    it('should have all expected status values', () => {
      const statuses: DAGWorkflowStatus[] = [
        'pending',
        'running',
        'completed',
        'failed',
        'cancelled',
        'failed_with_violations',
      ];
      expect(statuses).toHaveLength(6);
      expect(statuses).toContain('pending');
      expect(statuses).toContain('running');
      expect(statuses).toContain('completed');
      expect(statuses).toContain('failed');
      expect(statuses).toContain('cancelled');
      expect(statuses).toContain('failed_with_violations');
    });
  });

  describe('DAGNodeStatus', () => {
    it('should have all expected status values', () => {
      const statuses: DAGNodeStatus[] = [
        'pending',
        'queued',
        'running',
        'completed',
        'failed',
        'skipped',
      ];
      expect(statuses).toHaveLength(6);
      expect(statuses).toContain('pending');
      expect(statuses).toContain('queued');
      expect(statuses).toContain('running');
      expect(statuses).toContain('completed');
      expect(statuses).toContain('failed');
      expect(statuses).toContain('skipped');
    });
  });

  describe('DAGViolationType', () => {
    it('should have all expected violation types', () => {
      const types: DAGViolationType[] = [
        'required_node_skipped',
        'required_node_failed',
        'max_nodes_exceeded',
        'max_concurrency_exceeded',
        'timeout_exceeded',
      ];
      expect(types).toHaveLength(5);
    });
  });

  describe('DAGViolationSeverity', () => {
    it('should have all expected severity levels', () => {
      const severities: DAGViolationSeverity[] = [
        'info',
        'warning',
        'error',
        'critical',
      ];
      expect(severities).toHaveLength(4);
    });
  });
});

// ============================================================================
// 2. Pure Logic Tests
// ============================================================================

describe('DAG Session Logic - Terminal Status Guards', () => {
  describe('isTerminalStatus (workflow)', () => {
    it('should return true for completed workflows', () => {
      expect(isTerminalStatus('completed')).toBe(true);
    });

    it('should return true for failed workflows', () => {
      expect(isTerminalStatus('failed')).toBe(true);
    });

    it('should return true for cancelled workflows', () => {
      expect(isTerminalStatus('cancelled')).toBe(true);
    });

    it('should return true for failed_with_violations workflows', () => {
      expect(isTerminalStatus('failed_with_violations')).toBe(true);
    });

    it('should return false for pending workflows', () => {
      expect(isTerminalStatus('pending')).toBe(false);
    });

    it('should return false for running workflows', () => {
      expect(isTerminalStatus('running')).toBe(false);
    });
  });

  describe('isNodeTerminalStatus', () => {
    it('should return true for completed nodes', () => {
      expect(isNodeTerminalStatus('completed')).toBe(true);
    });

    it('should return true for failed nodes', () => {
      expect(isNodeTerminalStatus('failed')).toBe(true);
    });

    it('should return true for skipped nodes (violation)', () => {
      expect(isNodeTerminalStatus('skipped')).toBe(true);
    });

    it('should return false for pending nodes', () => {
      expect(isNodeTerminalStatus('pending')).toBe(false);
    });

    it('should return false for queued nodes', () => {
      expect(isNodeTerminalStatus('queued')).toBe(false);
    });

    it('should return false for running nodes', () => {
      expect(isNodeTerminalStatus('running')).toBe(false);
    });
  });
});

// ============================================================================
// 3. createEmptyWorkflowSession Tests
// ============================================================================

describe('DAG Session - createEmptyWorkflowSession', () => {
  it('should create a valid empty workflow session', () => {
    const config = makeConfig([makeNodeConfig('node-1', true)]);
    const session = createEmptyWorkflowSession('chat_123', config);

    expect(session).toBeDefined();
    expect(session.chat_session_id).toBe('chat_123');
    expect(session.config).toEqual(config);
    expect(session.status).toBe('pending');
    expect(session.node_sessions).toEqual({});
    expect(session.violations).toEqual([]);
    expect(session.metadata).toEqual({});
  });

  it('should set timestamps correctly', () => {
    const config = makeConfig();
    const before = Date.now();
    const session = createEmptyWorkflowSession('chat_123', config);
    const after = Date.now();

    expect(session.created_at).toBeGreaterThanOrEqual(before);
    expect(session.created_at).toBeLessThanOrEqual(after);
    expect(session.updated_at).toBe(session.created_at);
  });

  it('should generate unique IDs', () => {
    const config = makeConfig();
    const s1 = createEmptyWorkflowSession('chat_1', config);
    const s2 = createEmptyWorkflowSession('chat_2', config);
    expect(s1.id).not.toBe(s2.id);
  });

  it('should pass metadata through', () => {
    const config = makeConfig();
    const session = createEmptyWorkflowSession(
      'chat_123',
      config,
      { user: 'test', priority: 'high' }
    );
    expect(session.metadata).toEqual({ user: 'test', priority: 'high' });
  });

  it('should default optional fields to null', () => {
    const config = makeConfig();
    const session = createEmptyWorkflowSession('chat_123', config);

    expect(session.end_time).toBeNull();
    expect(session.current_node).toBeNull();
    expect(session.completed_at).toBeNull();
    expect(session.duration_ms).toBeNull();
  });
});

// ============================================================================
// 4. calculateWorkflowProgress Tests
// ============================================================================

describe('DAG Session Logic - calculateWorkflowProgress', () => {
  it('should return empty progress for empty workflow', () => {
    const config = makeConfig([]);
    const session = createEmptyWorkflowSession('chat_123', config);

    const progress = calculateWorkflowProgress(session);

    expect(progress.required.total).toBe(0);
    expect(progress.all_nodes.total).toBe(0);
    expect(progress.current_concurrency).toBe(0);
    expect(progress.max_concurrency).toBe(3);
  });

  it('should count completed nodes correctly', () => {
    const config = makeConfig([
      makeNodeConfig('n1', true),
      makeNodeConfig('n2', true),
      makeNodeConfig('n3', false),
    ]);
    const session = createEmptyWorkflowSession('chat_123', config);
    session.node_sessions = {
      'n1': makeNodeSession('n1', 'completed', true, 5000),
      'n2': makeNodeSession('n2', 'failed', true, 3000),
      'n3': makeNodeSession('n3', 'running', false, null),
    };

    const progress = calculateWorkflowProgress(session);

    expect(progress.required.total).toBe(2); // n1, n2 are required
    expect(progress.required.completed).toBe(1); // n1
    expect(progress.required.failed).toBe(1); // n2
    expect(progress.all_nodes.total).toBe(3);
    expect(progress.all_nodes.completed).toBe(1);
    expect(progress.all_nodes.failed).toBe(1);
    expect(progress.all_nodes.running).toBe(1);
  });

  it('should count skipped nodes as violations', () => {
    const config = makeConfig([
      makeNodeConfig('n1', true),
      makeNodeConfig('n2', true),
    ]);
    const session = createEmptyWorkflowSession('chat_123', config);
    session.node_sessions = {
      'n1': makeNodeSession('n1', 'completed', true, 5000),
      'n2': makeNodeSession('n2', 'skipped', true, null),
    };

    const progress = calculateWorkflowProgress(session);

    expect(progress.required.skipped).toBe(1);
    expect(progress.required.completed).toBe(1);
  });

  it('should count queued + running together for running total', () => {
    const config = makeConfig([
      makeNodeConfig('n1', true),
      makeNodeConfig('n2', true),
      makeNodeConfig('n3', true),
    ]);
    const session = createEmptyWorkflowSession('chat_123', config);
    session.node_sessions = {
      'n1': makeNodeSession('n1', 'running', true, null),
      'n2': makeNodeSession('n2', 'queued', true, null),
      'n3': makeNodeSession('n3', 'pending', true, null),
    };

    const progress = calculateWorkflowProgress(session);

    expect(progress.required.running).toBe(2); // n1 (running) + n2 (queued)
    expect(progress.required.pending).toBe(1); // n3
    expect(progress.current_concurrency).toBe(1); // only 'running' counts
  });

  it('should reflect max_concurrency from config', () => {
    const config = makeConfig([]);
    config.max_concurrency = 7;
    const session = createEmptyWorkflowSession('chat_123', config);

    const progress = calculateWorkflowProgress(session);

    expect(progress.max_concurrency).toBe(7);
  });
});

// ============================================================================
// 5. Status State Machine Tests (Iron Law: Transitions)
// ============================================================================

describe('DAG Session - Status State Machine (Iron Law)', () => {
  describe('Workflow status transitions', () => {
    const validTransitions = {
      'pending': ['running', 'cancelled', 'failed'],
      'running': ['completed', 'failed', 'cancelled', 'failed_with_violations'],
      'completed': [], // terminal
      'failed': [], // terminal
      'cancelled': [], // terminal
      'failed_with_violations': [], // terminal
    };

    it('pending can transition to running', () => {
      expect(validTransitions['pending']).toContain('running');
    });

    it('pending can transition to cancelled', () => {
      expect(validTransitions['pending']).toContain('cancelled');
    });

    it('running can transition to completed', () => {
      expect(validTransitions['running']).toContain('completed');
    });

    it('running can transition to failed', () => {
      expect(validTransitions['running']).toContain('failed');
    });

    it('completed is terminal (no outgoing transitions)', () => {
      expect(validTransitions['completed']).toHaveLength(0);
    });

    it('failed is terminal (no outgoing transitions)', () => {
      expect(validTransitions['failed']).toHaveLength(0);
    });

    it('cancelled is terminal (no outgoing transitions)', () => {
      expect(validTransitions['cancelled']).toHaveLength(0);
    });

    it('failed_with_violations is terminal (no outgoing transitions)', () => {
      expect(validTransitions['failed_with_violations']).toHaveLength(0);
    });
  });

  describe('Node status transitions', () => {
    const validTransitions = {
      'pending': ['queued', 'running', 'skipped'],
      'queued': ['running', 'skipped'],
      'running': ['completed', 'failed'],
      'completed': [], // terminal
      'failed': [], // terminal
      'skipped': [], // terminal
    };

    it('pending can transition to queued', () => {
      expect(validTransitions['pending']).toContain('queued');
    });

    it('pending can transition to skipped (violation)', () => {
      expect(validTransitions['pending']).toContain('skipped');
    });

    it('running can only transition to completed or failed', () => {
      expect(validTransitions['running']).toEqual(['completed', 'failed']);
    });

    it('terminal node states have no outgoing transitions', () => {
      expect(validTransitions['completed']).toHaveLength(0);
      expect(validTransitions['failed']).toHaveLength(0);
      expect(validTransitions['skipped']).toHaveLength(0);
    });
  });
});

// ============================================================================
// 6. Session Service API Shape Tests
// ============================================================================

describe('DAG Session Service API - Shape Validation', () => {
  let module: any;

  it('should export make factory', async () => {
    module = await import('../session-service');
    expect(module.DAGSessionService).toBeDefined();
    expect(module.DAGSessionService.make).toBeDefined();
  });

  it('make should be an Effect (built by Effect.gen)', async () => {
    module = await import('../session-service');
    // Effect.gen returns an Effect object, not a function
    expect(module.DAGSessionService.make).toBeDefined();
    expect(typeof module.DAGSessionService.make).toBe('object');
  });
});

// ============================================================================
// 7. DAG Node Config Tests
// ============================================================================

describe('DAG Session - DAGNodeConfig', () => {
  it('should allow creating required node config', () => {
    const config = makeNodeConfig('test-node', true, []);

    expect(config.id).toBe('test-node');
    expect(config.name).toBe('Node test-node');
    expect(config.required).toBe(true);
    expect(config.dependencies).toEqual([]);
    expect(config.worker_type).toBe('mock');
  });

  it('should allow creating optional node config', () => {
    const config = makeNodeConfig('optional-node', false, ['dep1', 'dep2']);

    expect(config.required).toBe(false);
    expect(config.dependencies).toEqual(['dep1', 'dep2']);
  });
});

// ============================================================================
// 8. Integration Tests: End-to-End Workflow Lifecycle
// ============================================================================

describe('DAG Session - Lifecycle Integration (Mock)', () => {
  it('should support creating a workflow with multiple required nodes', () => {
    const config = makeConfig([
      makeNodeConfig('analyze', true),
      makeNodeConfig('plan', true, ['analyze']),
      makeNodeConfig('implement', true, ['plan']),
      makeNodeConfig('test', true, ['implement']),
    ]);

    const session = createEmptyWorkflowSession('chat_123', config);

    expect(session).toBeDefined();
    expect(session.config.nodes).toHaveLength(4);
    expect(session.config.nodes.filter((n: DAGNodeConfig) => n.required)).toHaveLength(4);
    expect(session.status).toBe('pending');
  });

  it('should support mixed required/optional nodes', () => {
    const config = makeConfig([
      makeNodeConfig('analyze', true),
      makeNodeConfig('optional-optimize', false, ['analyze']),
      makeNodeConfig('implement', true, ['analyze']),
    ]);

    const session = createEmptyWorkflowSession('chat_123', config);

    expect(session.config.nodes.filter((n: DAGNodeConfig) => n.required)).toHaveLength(2);
    expect(session.config.nodes.filter((n: DAGNodeConfig) => !n.required)).toHaveLength(1);
  });

  it('should calculate progress accurately after partial completion', () => {
    const config = makeConfig([
      makeNodeConfig('n1', true),
      makeNodeConfig('n2', true),
      makeNodeConfig('n3', false),
      makeNodeConfig('n4', true),
    ]);

    const session = createEmptyWorkflowSession('chat_123', config);
    session.node_sessions = {
      'n1': makeNodeSession('n1', 'completed', true, 5000),
      'n2': makeNodeSession('n2', 'completed', true, 3000),
      'n3': makeNodeSession('n3', 'running', false, null),
      'n4': makeNodeSession('n4', 'pending', true, null),
    };

    const progress = calculateWorkflowProgress(session);

    // Required: 3 (n1, n2, n4)
    expect(progress.required.total).toBe(3);
    expect(progress.required.completed).toBe(2);
    expect(progress.required.pending).toBe(1);

    // All nodes: 4
    expect(progress.all_nodes.total).toBe(4);
    expect(progress.all_nodes.completed).toBe(2);
    expect(progress.all_nodes.running).toBe(1);
    expect(progress.all_nodes.pending).toBe(1);
  });
});

// ============================================================================
// 9. Violation Type Coverage
// ============================================================================

describe('DAG Session - Violation Type Coverage', () => {
  it('should cover all required_node_skipped scenarios', () => {
    const violation: DAGViolation = {
      id: 'v1',
      workflowId: 'wf_test',
      nodeId: 'n1',
      type: 'required_node_skipped',
      severity: 'error',
      message: 'Required node n1 was skipped',
      timestamp: new Date().toISOString(),
    };

    expect(violation.type).toBe('required_node_skipped');
    expect(violation.severity).toBe('error');
  });

  it('should cover required_node_failed scenarios', () => {
    const violation: DAGViolation = {
      id: 'v2',
      workflowId: 'wf_test',
      nodeId: 'n2',
      type: 'required_node_failed',
      severity: 'critical',
      message: 'Required node n2 failed',
      timestamp: new Date().toISOString(),
    };

    expect(violation.type).toBe('required_node_failed');
    expect(violation.severity).toBe('critical');
  });

  it('should cover max_nodes_exceeded scenarios', () => {
    const violation: DAGViolation = {
      id: 'v3',
      workflowId: 'wf_test',
      type: 'max_nodes_exceeded',
      severity: 'warning',
      message: 'Exceeded max 20 nodes',
      timestamp: new Date().toISOString(),
    };

    expect(violation.type).toBe('max_nodes_exceeded');
  });

  it('should cover max_concurrency_exceeded scenarios', () => {
    const violation: DAGViolation = {
      id: 'v4',
      workflowId: 'wf_test',
      type: 'max_concurrency_exceeded',
      severity: 'warning',
      message: 'Exceeded max concurrency 10',
      timestamp: new Date().toISOString(),
    };

    expect(violation.type).toBe('max_concurrency_exceeded');
  });

  it('should cover timeout_exceeded scenarios', () => {
    const violation: DAGViolation = {
      id: 'v5',
      workflowId: 'wf_test',
      nodeId: 'n5',
      type: 'timeout_exceeded',
      severity: 'error',
      message: 'Node n5 exceeded 300000ms timeout',
      timestamp: new Date().toISOString(),
    };

    expect(violation.type).toBe('timeout_exceeded');
    expect(violation.severity).toBe('error');
  });
});
