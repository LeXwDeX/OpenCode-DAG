// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

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

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
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
import {
  getValidNextSessionWorkflowStatuses,
  getValidNextSessionNodeStatuses,
  buildSessionWorkflowEvent,
  buildSessionNodeEvent,
  setEventBus,
  DAGSessionService,
} from '../session-service';
import { Effect } from 'effect';
import { Flag } from '@opencode-ai/core/flag/flag';
import * as Database from '@/storage/db';

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
      ? Date.now()
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
        'paused',
      ];
      expect(statuses).toHaveLength(6);
      expect(statuses).toContain('pending');
      expect(statuses).toContain('running');
      expect(statuses).toContain('completed');
      expect(statuses).toContain('failed');
      expect(statuses).toContain('cancelled');
      expect(statuses).toContain('paused');
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
        'recoverable',
      ];
      expect(statuses).toHaveLength(7);
      expect(statuses).toContain('pending');
      expect(statuses).toContain('queued');
      expect(statuses).toContain('running');
      expect(statuses).toContain('completed');
      expect(statuses).toContain('failed');
      expect(statuses).toContain('skipped');
      expect(statuses).toContain('recoverable');
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
        'execution_failed',
        'process_orphan',
        'condition_skipped',
        'subdag_depth_exceeded',
        'subdag_timeout',
      ];
      expect(types).toHaveLength(10);
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

    it('should return false for pending workflows', () => {
      expect(isTerminalStatus('pending')).toBe(false);
    });

    it('should return false for running workflows', () => {
      expect(isTerminalStatus('running')).toBe(false);
    });

    it('should return false for paused workflows (resume is possible)', () => {
      expect(isTerminalStatus('paused')).toBe(false);
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

    it('should return false for recoverable nodes (non-terminal; awaiting replan)', () => {
      expect(isNodeTerminalStatus('recoverable')).toBe(false);
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
    const validTransitions: Record<DAGWorkflowStatus, DAGWorkflowStatus[]> = {
      'pending': ['running', 'cancelled', 'failed'],
      'running': ['completed', 'failed', 'cancelled', 'paused'],
      'paused': ['running', 'cancelled'],
      'completed': [], // terminal
      'failed': [], // terminal
      'cancelled': [], // terminal
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

    it('paused is a valid transition from running', () => {
      expect(validTransitions['running']).toContain('paused');
    });

    it('paused can transition to running (resume)', () => {
      expect(validTransitions['paused']).toContain('running');
    });

    it('paused cannot transition to completed directly', () => {
      expect(validTransitions['paused']).not.toContain('completed');
    });

    it('paused cannot transition to failed directly', () => {
      expect(validTransitions['paused']).not.toContain('failed');
    });

  });

  describe('Node status transitions', () => {
    const validTransitions = {
      'pending': ['queued', 'running', 'skipped'],
      'queued': ['running', 'skipped'],
      'running': ['completed', 'failed', 'pending', 'recoverable'],
      'completed': [], // terminal
      'failed': [], // terminal
      'skipped': [], // terminal
      'recoverable': ['pending', 'failed'],
    };

    it('pending can transition to queued', () => {
      expect(validTransitions['pending']).toContain('queued');
    });

    it('pending can transition to skipped (violation)', () => {
      expect(validTransitions['pending']).toContain('skipped');
    });

    it('running can transition to completed, failed, or pending (recovery reset)', () => {
      expect(validTransitions['running']).toEqual(['completed', 'failed', 'pending', 'recoverable']);
    });

    it('recoverable can transition to pending (reset) or failed (abandon)', () => {
      expect(validTransitions['recoverable']).toEqual(['pending', 'failed']);
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

// ============================================================================
// 10. Iron Law Enforcement Helpers (Session Layer)
// ============================================================================

describe('Iron Law #1/#2: getValidNextSessionWorkflowStatuses', () => {
  it('pending can transition to running, failed, cancelled', () => {
    const valid = getValidNextSessionWorkflowStatuses('pending')
    expect(valid).toContain('running')
    expect(valid).toContain('failed')
    expect(valid).toContain('cancelled')
  })

  it('running can transition to completed, failed, cancelled, paused', () => {
    const valid = getValidNextSessionWorkflowStatuses('running')
    expect(valid).toContain('completed')
    expect(valid).toContain('failed')
    expect(valid).toContain('cancelled')
    expect(valid).toContain('paused')
  })

  it('paused can transition to running (resume)', () => {
    const valid = getValidNextSessionWorkflowStatuses('paused')
    expect(valid).toContain('running')
  })

  it('paused can transition to cancelled', () => {
    const valid = getValidNextSessionWorkflowStatuses('paused')
    expect(valid).toContain('cancelled')
  })

  it('paused cannot transition to completed', () => {
    const valid = getValidNextSessionWorkflowStatuses('paused')
    expect(valid).not.toContain('completed')
  })

  it('paused cannot transition to failed', () => {
    const valid = getValidNextSessionWorkflowStatuses('paused')
    expect(valid).not.toContain('failed')
  })

  it('completed is terminal (Iron Law #2)', () => {
    expect(getValidNextSessionWorkflowStatuses('completed')).toEqual([])
  })

  it('failed is terminal (Iron Law #2)', () => {
    expect(getValidNextSessionWorkflowStatuses('failed')).toEqual([])
  })

  it('cancelled is terminal (Iron Law #2)', () => {
    expect(getValidNextSessionWorkflowStatuses('cancelled')).toEqual([])
  })
});

describe('Iron Law #1/#2: getValidNextSessionNodeStatuses', () => {
  it('pending can transition to queued, running, skipped', () => {
    const valid = getValidNextSessionNodeStatuses('pending')
    expect(valid).toContain('queued')
    expect(valid).toContain('running')
    expect(valid).toContain('skipped')
  })

  it('queued can transition to running, skipped', () => {
    const valid = getValidNextSessionNodeStatuses('queued')
    expect(valid).toContain('running')
    expect(valid).toContain('skipped')
  })

  it('running can transition to completed, failed, pending', () => {
    const valid = getValidNextSessionNodeStatuses('running')
    expect(valid).toContain('completed')
    expect(valid).toContain('failed')
    expect(valid).toContain('pending')
  })

  it('completed is terminal (Iron Law #2)', () => {
    expect(getValidNextSessionNodeStatuses('completed')).toEqual([])
  })

  it('failed is terminal (Iron Law #2)', () => {
    expect(getValidNextSessionNodeStatuses('failed')).toEqual([])
  })

  it('skipped is terminal (Iron Law #2)', () => {
    expect(getValidNextSessionNodeStatuses('skipped')).toEqual([])
  })
});

describe('Iron Law #3: buildSessionWorkflowEvent', () => {
  const now = 1717610000000
  const wfId = 'wf_test_event'

  it('running transition emits workflow.started', () => {
    const event = buildSessionWorkflowEvent(wfId, 'pending', 'running', now)
    expect(event).not.toBeNull()
    expect(event!.type).toBe('workflow.started')
    expect(event!.workflow_id).toBe(wfId)
  })

  it('completed transition emits workflow.completed', () => {
    const event = buildSessionWorkflowEvent(wfId, 'running', 'completed', now)
    expect(event).not.toBeNull()
    expect(event!.type).toBe('workflow.completed')
  })

  it('failed transition emits workflow.failed', () => {
    const event = buildSessionWorkflowEvent(wfId, 'running', 'failed', now)
    expect(event).not.toBeNull()
    expect(event!.type).toBe('workflow.failed')
  })

  it('cancelled transition emits workflow.cancelled', () => {
    const event = buildSessionWorkflowEvent(wfId, 'running', 'cancelled', now)
    expect(event).not.toBeNull()
    expect(event!.type).toBe('workflow.cancelled')
  })

  it('pending transition emits null (no event)', () => {
    const event = buildSessionWorkflowEvent(wfId, 'running', 'pending', now)
    expect(event).toBeNull()
  })

  it('paused transition emits workflow.paused', () => {
    const event = buildSessionWorkflowEvent(wfId, 'running', 'paused', now)
    expect(event).not.toBeNull()
    expect(event!.type).toBe('workflow.paused')
    expect(event!.workflow_id).toBe(wfId)
  })

  it('resume (paused→running) emits workflow.resumed', () => {
    const event = buildSessionWorkflowEvent(wfId, 'paused', 'running', now)
    expect(event).not.toBeNull()
    expect(event!.type).toBe('workflow.resumed')
    expect(event!.workflow_id).toBe(wfId)
  })
});

describe('Iron Law #3: buildSessionNodeEvent', () => {
  const wfId = 'wf_test_node_event'
  const nodeId = 'node_123'
  const nodeName = 'implement'

  it('running transition emits node.started', () => {
    const event = buildSessionNodeEvent(wfId, nodeId, nodeName, 'running')
    expect(event).not.toBeNull()
    expect(event!.type).toBe('node.started')
    expect((event as any).node_name).toBe(nodeName)
  })

  it('completed transition emits node.completed', () => {
    const event = buildSessionNodeEvent(wfId, nodeId, nodeName, 'completed')
    expect(event).not.toBeNull()
    expect(event!.type).toBe('node.completed')
  })

  it('failed transition emits node.failed', () => {
    const event = buildSessionNodeEvent(wfId, nodeId, nodeName, 'failed')
    expect(event).not.toBeNull()
    expect(event!.type).toBe('node.failed')
  })

  it('skipped transition emits node.skipped', () => {
    const event = buildSessionNodeEvent(wfId, nodeId, nodeName, 'skipped')
    expect(event).not.toBeNull()
    expect(event!.type).toBe('node.skipped')
  })

  it('skipped transition carries upstream_failed_node when provided', () => {
    const event = buildSessionNodeEvent(wfId, nodeId, nodeName, 'skipped', {
      upstreamFailedNode: 'node-root',
    })
    expect(event).not.toBeNull()
    expect(event!.type).toBe('node.skipped')
    expect((event as { upstream_failed_node?: string }).upstream_failed_node).toBe('node-root')
  })

  it('pending transition emits null (no event)', () => {
    const event = buildSessionNodeEvent(wfId, nodeId, nodeName, 'pending')
    expect(event).toBeNull()
  })

  it('queued transition emits null (no event)', () => {
    const event = buildSessionNodeEvent(wfId, nodeId, nodeName, 'queued')
    expect(event).toBeNull()
  })

  it('recoverable transition emits node.recoverable event', () => {
    const event = buildSessionNodeEvent(wfId, nodeId, nodeName, 'recoverable')
    expect(event).not.toBeNull()
    expect(event!.type).toBe('node.recoverable')
    expect((event as any).workflow_id).toBe(wfId)
    expect((event as any).node_name).toBe(nodeName)
  })

  it('recoverable event carries trigger_reason and error when provided', () => {
    const event = buildSessionNodeEvent(wfId, nodeId, nodeName, 'recoverable', {
      triggerReason: 'timeout' as any,
      error: 'Node timed out after 300s',
    })
    expect(event).not.toBeNull()
    expect(event!.type).toBe('node.recoverable')
    expect((event as { trigger_reason?: string }).trigger_reason).toBe('timeout')
    expect((event as { error?: string }).error).toBe('Node timed out after 300s')
  })

  it('recoverable event serializes non-string error to JSON', () => {
    const event = buildSessionNodeEvent(wfId, nodeId, nodeName, 'recoverable', {
      error: { code: 'ERR_TIMEOUT', retryable: true },
    })
    expect(event).not.toBeNull()
    expect((event as { error?: string }).error).toBe('{"code":"ERR_TIMEOUT","retryable":true}')
  })
});

describe('setEventBus', () => {
  it('should be callable without errors', () => {
    expect(() => setEventBus(undefined)).not.toThrow()
  })

  it('should accept a mock event bus', () => {
    const mockBus = {
      subscribe: () => () => {},
      emit: () => {},
      destroy: () => {},
    }
    expect(() => setEventBus(mockBus)).not.toThrow()
    // cleanup
    setEventBus(undefined)
  })
})

// ============================================================================
// 11. Observation Layer — Interface Shape Tests
// ============================================================================

describe('Observation Layer — IDAGSessionService shape', () => {
  it('AppendNodeLogInput type supports all required fields', () => {
    // Verifies AppendNodeLogInput interface shape via structural typing
    const input: import('../session-service').AppendNodeLogInput = {
      nodeId: 'node_1',
      workflowId: 'wf_1',
      chatSessionId: 'chat_1',
      logLevel: 'info',
      logMessage: 'test log',
      logData: { step: 1 },
      executionPhase: 'execute',
    }
    expect(input.nodeId).toBe('node_1')
    expect(input.logLevel).toBe('info')
    expect(input.logData).toEqual({ step: 1 })
  })

  it('AppendNodeLogInput omits optional fields when not provided', () => {
    const input: import('../session-service').AppendNodeLogInput = {
      nodeId: 'node_1',
      workflowId: 'wf_1',
      chatSessionId: 'chat_1',
      logLevel: 'debug',
      logMessage: 'minimal',
    }
    expect(input.logData).toBeUndefined()
    expect(input.executionPhase).toBeUndefined()
  })

  it('IDAGSessionService declares listHistory / listNodeLogs / appendNodeLog', async () => {
    const mod = await import('../session-service')
    // Verify the module exports the make factory (which satisfies IDAGSessionService)
    expect(mod.DAGSessionService.make).toBeDefined()
  })
})

// ============================================================================
// 12. Iron Law #3 — emitWorkflowReplannedEvent
// ============================================================================

describe('Iron Law #3: emitWorkflowReplannedEvent', () => {
  it('is a callable function', async () => {
    const mod = await import('../session-service')
    expect(typeof mod.emitWorkflowReplannedEvent).toBe('function')
  })

  it('no-op when no bus is set (graceful degradation)', async () => {
    const mod = await import('../session-service')
    mod.setEventBus(undefined)
    // Should not throw even without a bus
    expect(() =>
      mod.emitWorkflowReplannedEvent('wf_1', 'chat_1', { added: 1, removed: 0, updated: 2, final_total: 3 }),
    ).not.toThrow()
  })

  it('emits workflow.replanned when bus is set', async () => {
    const mod = await import('../session-service')
    const emitted: unknown[] = []
    const mockBus = {
      subscribe: () => () => {},
      emit: (ev: unknown) => { emitted.push(ev) },
      destroy: () => {},
    }
    mod.setEventBus(mockBus)
    mod.emitWorkflowReplannedEvent('wf_1', 'chat_1', { added: 2, removed: 1, updated: 0, final_total: 5 })
    expect(emitted).toHaveLength(1)
    const ev = emitted[0] as { type: string; workflow_id: string; patch_summary: { added: number } }
    expect(ev.type).toBe('workflow.replanned')
    expect(ev.workflow_id).toBe('wf_1')
    expect(ev.patch_summary.added).toBe(2)
    // cleanup
    mod.setEventBus(undefined)
  })
})

// ============================================================================
// 13. Observation Layer — appendNodeLog real DB round-trip
// ============================================================================

describe('Observation Layer — appendNodeLog real DB round-trip', () => {
  const originalDb = (globalThis as any).__OPENCODE_DB_FLAG__
  let Flag: any
  let Database: any

  beforeAll(async () => {
    Flag = (await import('@opencode-ai/core/flag/flag')).Flag
    Database = await import('@/storage/db')
    Flag.OPENCODE_DB = ':memory:'
    Database.Client.reset()
  })

  afterAll(async () => {
    try { Database.close() } catch { /* ignore */ }
    Flag.OPENCODE_DB = originalDb ?? undefined
    Database.Client.reset()
  })

  it('appendNodeLog persists and listNodeLogs returns the entry', async () => {
    const { DAGSessionService } = await import('../session-service')
    const { Effect } = await import('effect')
    const service = Effect.runSync(DAGSessionService.make)

    // Create a workflow + node
    const workflow = Effect.runSync(service.createWorkflow({
      name: 'log-roundtrip-test',
      chatSessionId: 'chat-roundtrip-1',
      config: {
        name: 'log-roundtrip-test',
        nodes: [],
        max_concurrency: 1,
      },
    }))

    const node = Effect.runSync(service.createNode({
      workflowId: workflow.id,
      nodeId: `${workflow.id}::node-A`,
      name: 'node-A',
      nodeName: 'node-A',
      nodeType: 'mock',
      config: {
        id: 'node-A',
        name: 'node-A',
        dependencies: [],
        required: true,
        worker_type: 'mock',
        worker_config: {},
      },
    }))

    // Append a log entry
    const log = Effect.runSync(service.appendNodeLog({
      nodeId: node.node_id,
      workflowId: workflow.id,
      chatSessionId: workflow.chat_session_id,
      logLevel: 'info',
      logMessage: 'test log entry',
      executionPhase: 'spawn_start',
    }))

    // Verify returned DagNodeLog type
    expect(log.log_id).toMatch(/^log_/)
    expect(log.node_id).toBe(node.node_id)
    expect(log.workflow_id).toBe(workflow.id)
    expect(log.chat_session_id).toBe(workflow.chat_session_id)
    expect(log.log_level).toBe('info')
    expect(log.log_message).toBe('test log entry')
    expect(log.execution_phase).toBe('spawn_start')
    expect(typeof log.created_at).toBe('number')

    // Verify listNodeLogs returns the entry
    const logs = Effect.runSync(service.listNodeLogs(node.node_id))
    expect(logs.length).toBeGreaterThanOrEqual(1)
    const found = logs.find((l: any) => l.log_id === log.log_id)
    expect(found).toBeDefined()
    expect(found!.log_message).toBe('test log entry')
  })

  it('appendNodeLog returns DagNodeLog with millisecond-precision timestamp', async () => {
    const { DAGSessionService } = await import('../session-service')
    const { Effect } = await import('effect')
    const service = Effect.runSync(DAGSessionService.make)

    const workflow = Effect.runSync(service.createWorkflow({
      name: 'log-timestamp-test',
      chatSessionId: 'chat-ts-1',
      config: { name: 'log-timestamp-test', nodes: [], max_concurrency: 1 },
    }))

    const node = Effect.runSync(service.createNode({
      workflowId: workflow.id,
      nodeId: `${workflow.id}::node-ts`,
      name: 'node-ts',
      nodeName: 'node-ts',
      nodeType: 'mock',
      config: {
        id: 'node-ts',
        name: 'node-ts',
        dependencies: [],
        required: true,
        worker_type: 'mock',
        worker_config: {},
      },
    }))

    const before = Date.now()
    const log = Effect.runSync(service.appendNodeLog({
      nodeId: node.node_id,
      workflowId: workflow.id,
      chatSessionId: workflow.chat_session_id,
      logLevel: 'debug',
      logMessage: 'timestamp precision check',
    }))
    const after = Date.now()

    expect(log.created_at).toBeGreaterThanOrEqual(before)
    expect(log.created_at).toBeLessThanOrEqual(after)
    // Millisecond precision: created_at should be a 13-digit number (epoch ms)
    expect(String(log.created_at).length).toBeGreaterThanOrEqual(13)
  })
})

// ============================================================================
// 14. createWorkflow — config cap validation (100 nodes / 1..10 concurrency)
// ============================================================================

describe('createWorkflow — config cap validation', () => {
  const originalDb = (globalThis as any).__OPENCODE_DB_FLAG__
  let Flag: any
  let Database: any

  beforeAll(async () => {
    Flag = (await import('@opencode-ai/core/flag/flag')).Flag
    Database = await import('@/storage/db')
    Flag.OPENCODE_DB = ':memory:'
    Database.Client.reset()
  })

  afterAll(async () => {
    try { Database.close() } catch { /* ignore */ }
    Flag.OPENCODE_DB = originalDb ?? undefined
    Database.Client.reset()
  })

  const makeNodes = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `n${i}`,
      name: `n${i}`,
      dependencies: [],
      required: false,
      worker_type: 'mock',
      worker_config: {},
    }))

  it('legal config (≤100 nodes, concurrency 1..10) creates a pending workflow', async () => {
    const { DAGSessionService } = await import('../session-service')
    const { Effect } = await import('effect')
    const service = Effect.runSync(DAGSessionService.make)

    const workflow = Effect.runSync(service.createWorkflow({
      name: 'legal-config',
      chatSessionId: 'chat-legal',
      config: { name: 'legal-config', nodes: makeNodes(100), max_concurrency: 10 },
    }))
    expect(workflow.status).toBe('pending')
    expect(workflow.id).toMatch(/^workflow_/)
  })

  it('>100 nodes → fails with WorkflowConfigValidationError', async () => {
    const { DAGSessionService, WorkflowConfigValidationError } = await import('../session-service')
    const { Effect } = await import('effect')
    const service = Effect.runSync(DAGSessionService.make)

    const exit = Effect.runSyncExit(service.createWorkflow({
      name: 'too-many-nodes',
      chatSessionId: 'chat-overcap',
      config: { name: 'too-many-nodes', nodes: makeNodes(101), max_concurrency: 5 },
    }))
    expect(exit._tag).toBe('Failure')
    const error = Effect.runSync(Effect.flip(service.createWorkflow({
      name: 'too-many-nodes',
      chatSessionId: 'chat-overcap',
      config: { name: 'too-many-nodes', nodes: makeNodes(101), max_concurrency: 5 },
    })))
    expect(error).toBeInstanceOf(WorkflowConfigValidationError)
    expect(error.message).toBe('node cap exceeded: 101 > 100')
  })

  it('max_concurrency = 11 → fails', async () => {
    const { DAGSessionService, WorkflowConfigValidationError } = await import('../session-service')
    const { Effect } = await import('effect')
    const service = Effect.runSync(DAGSessionService.make)

    const error = Effect.runSync(Effect.flip(service.createWorkflow({
      name: 'concurrency-high',
      chatSessionId: 'chat-c11',
      config: { name: 'concurrency-high', nodes: makeNodes(1), max_concurrency: 11 },
    })))
    expect(error).toBeInstanceOf(WorkflowConfigValidationError)
    expect(error.message).toBe('max_concurrency must be 1..10, got 11')
  })

  it('max_concurrency = 0 → fails', async () => {
    const { DAGSessionService, WorkflowConfigValidationError } = await import('../session-service')
    const { Effect } = await import('effect')
    const service = Effect.runSync(DAGSessionService.make)

    const error = Effect.runSync(Effect.flip(service.createWorkflow({
      name: 'concurrency-zero',
      chatSessionId: 'chat-c0',
      config: { name: 'concurrency-zero', nodes: makeNodes(1), max_concurrency: 0 },
    })))
    expect(error).toBeInstanceOf(WorkflowConfigValidationError)
    expect(error.message).toBe('max_concurrency must be 1..10, got 0')
  })
})

// ============================================================================
// getWorkflow — node_sessions / violations populated (Step 2 regression)
// ============================================================================

describe('getWorkflow — node_sessions and violations populated', () => {
  it('returns a DAGWorkflowSession with real node_sessions and violations (not empty)', async () => {
    const originalDb = (globalThis as any).__OPENCODE_DB_FLAG__
    const Flag = (await import('@opencode-ai/core/flag/flag')).Flag
    const Database = await import('@/storage/db')
    const { DAGSessionService } = await import('../session-service')
    const { Effect } = await import('effect')

    Flag.OPENCODE_DB = ':memory:'
    Database.Client.reset()

    const service = Effect.runSync(DAGSessionService.make)

    const config: DAGConfig = {
      name: 'gw-test',
      nodes: [makeNodeConfig('A', true, []), makeNodeConfig('B', false, ['A'])],
      max_concurrency: 3,
    }

    const wf = Effect.runSync(
      service.createWorkflow({ name: 'gw-test', chatSessionId: 'chat-gw', config }),
    ) as DAGWorkflowSession

    // Create 2 nodes
    Effect.runSync(
      service.createNode({
        workflowId: wf.id,
        nodeId: `${wf.id}::A`,
        name: 'A',
        nodeName: 'A',
        nodeType: 'mock',
        config: config.nodes[0],
        dependencyNodes: [],
      }),
    )
    Effect.runSync(
      service.createNode({
        workflowId: wf.id,
        nodeId: `${wf.id}::B`,
        name: 'B',
        nodeName: 'B',
        nodeType: 'mock',
        config: config.nodes[1],
        dependencyNodes: [`${wf.id}::A`],
      }),
    )

    // Create a violation
    Effect.runSync(
      service.createViolation({
        workflowId: wf.id,
        nodeId: `${wf.id}::A`,
        type: 'execution_failed',
        severity: 'error',
        message: 'boom',
      }),
    )

    const result = Effect.runSync(service.getWorkflow(wf.id)) as DAGWorkflowSession

    // node_sessions populated (2 nodes, keyed by node_id)
    expect(Object.keys(result.node_sessions)).toHaveLength(2)
    expect(result.node_sessions[`${wf.id}::A`]).toBeDefined()
    expect(result.node_sessions[`${wf.id}::A`].status).toBe('pending')
    expect(result.node_sessions[`${wf.id}::B`]).toBeDefined()

    // violations populated (1 violation)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0].type).toBe('execution_failed')
    expect(result.violations[0].message).toBe('boom')

    try { Database.close() } catch { /* ignore */ }
    Flag.OPENCODE_DB = originalDb ?? undefined
    Database.Client.reset()
  })

  it('returns undefined for non-existent workflow', async () => {
    const originalDb = (globalThis as any).__OPENCODE_DB_FLAG__
    const Flag = (await import('@opencode-ai/core/flag/flag')).Flag
    const Database = await import('@/storage/db')
    const { DAGSessionService } = await import('../session-service')
    const { Effect } = await import('effect')

    Flag.OPENCODE_DB = ':memory:'
    Database.Client.reset()

    const service = Effect.runSync(DAGSessionService.make)
    const result = Effect.runSync(service.getWorkflow('nonexistent-workflow-id'))
    expect(result).toBeUndefined()

    try { Database.close() } catch { /* ignore */ }
    Flag.OPENCODE_DB = originalDb ?? undefined
    Database.Client.reset()
  })
})

// ============================================================================
// C1 fix: retry 默认值一致性 + delay_ms 不再是死字段
// 历史 bug：
//   1. session-service.createNode 默认 max_retries ?? 3，但 core-start.ts 传
//      cfg.retry?.max_attempts ?? 0——两个创建路径默认值不一致。
//   2. types.ts 声明 retry.delay_ms 但全代码库无消费点。
// 修复：
//   1. createNode 默认 max_retries 统一为 0（显式优于隐式）。
//   2. workflow-engine retry 循环消费 delay_ms（Effect.sleep）。
// ============================================================================
describe('C1 fix: createNode default max_retries consistency', () => {
  it('createNode without maxRetries defaults to 0 (was 3)', () => {
    const originalDb = Flag.OPENCODE_DB
    Flag.OPENCODE_DB = ':memory:'
    Database.Client.reset()

    const service = Effect.runSync(DAGSessionService.make)
    const workflow = Effect.runSync(service.createWorkflow({
      name: 'c1-default-retry',
      chatSessionId: 'session-c1-default',
      config: { name: 'c1', nodes: [], max_concurrency: 1 },
    }))

    // 不传 maxRetries → 应该默认 0（之前是 3）
    const node = Effect.runSync(service.createNode({
      workflowId: workflow.id,
      nodeId: `${workflow.id}::node-A`,
      name: 'node-A',
      nodeName: 'node-A',
      nodeType: 'mock',
      config: {
        id: 'node-A', name: 'node-A', dependencies: [], required: true,
        worker_type: 'mock', worker_config: {},
      },
    }))

    expect(node.max_retries).toBe(0)

    try { Database.close() } catch { /* ignore */ }
    Flag.OPENCODE_DB = originalDb ?? undefined
    Database.Client.reset()
  })

  it('createNode with explicit maxRetries is respected', () => {
    const originalDb = Flag.OPENCODE_DB
    Flag.OPENCODE_DB = ':memory:'
    Database.Client.reset()

    const service = Effect.runSync(DAGSessionService.make)
    const workflow = Effect.runSync(service.createWorkflow({
      name: 'c1-explicit-retry',
      chatSessionId: 'session-c1-explicit',
      config: { name: 'c1', nodes: [], max_concurrency: 1 },
    }))

    const node = Effect.runSync(service.createNode({
      workflowId: workflow.id,
      nodeId: `${workflow.id}::node-A`,
      name: 'node-A',
      nodeName: 'node-A',
      nodeType: 'mock',
      config: {
        id: 'node-A', name: 'node-A', dependencies: [], required: true,
        worker_type: 'mock', worker_config: {},
      },
      maxRetries: 5,
    }))

    expect(node.max_retries).toBe(5)

    try { Database.close() } catch { /* ignore */ }
    Flag.OPENCODE_DB = originalDb ?? undefined
    Database.Client.reset()
  })
})
