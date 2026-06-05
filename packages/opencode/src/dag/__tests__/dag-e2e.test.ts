/**
 * DAG End-to-End Integration Tests
 *
 * Tests the complete DAG workflow lifecycle with real implementations:
 * - Workflow creation and initialization
 * - State machine transitions with file persistence
 * - Event broadcasting and tracking
 * - Cross-module integration (Session + State Machine + Persistence)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WorkflowStateMachine } from '../state-machine/WorkflowStateMachine';
import { WorkflowStatus, WorkflowTransition } from '../state-machine/types';
import type { IStatePersister } from '../state-machine/IStateMachine';
import { EventBus } from '../state-machine/EventBus';

// ============================================================================
// Real File-Based Persister
// ============================================================================

class FileStatePersister implements IStatePersister {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async writeWorkflowState(workflowId: string, state: any): Promise<void> {
    const file = path.join(this.dir, `${workflowId}.json`);
    await fs.writeFile(file, JSON.stringify(state, null, 2));
  }

  async readWorkflowState(workflowId: string): Promise<any> {
    const file = path.join(this.dir, `${workflowId}.json`);
    try {
      const data = await fs.readFile(file, 'utf-8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async deleteWorkflowState(workflowId: string): Promise<void> {
    const file = path.join(this.dir, `${workflowId}.json`);
    try {
      await fs.unlink(file);
    } catch {
      // Ignore
    }
  }

  async listWorkflowIds(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.dir);
      return files.filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
    } catch {
      return [];
    }
  }
}

// ============================================================================
// End-to-End Integration Tests
// ============================================================================

describe('DAG End-to-End Integration Tests', () => {
  let testDir: string;
  let statePersister: FileStatePersister;
  let eventBus: EventBus;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dag-e2e-'));
    statePersister = new FileStatePersister(testDir);
    eventBus = new EventBus();
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true });
    } catch {
      // Ignore
    }
  });

  describe('Workflow Lifecycle', () => {
    it('should execute complete workflow lifecycle with persistence', async () => {
      const workflowId = 'workflow-001';
      const machine = new WorkflowStateMachine(workflowId, eventBus, statePersister);
      
      // Initialize workflow
      machine.initialize(WorkflowStatus.PENDING);
      expect(await machine.getStatus()).toBe(WorkflowStatus.PENDING);

      // Transition to RUNNING
      await machine.transition({
        fromStatus: WorkflowStatus.PENDING,
        toStatus: WorkflowStatus.RUNNING,
        transition: WorkflowTransition.ENGINE_START,
      });
      expect(await machine.getStatus()).toBe(WorkflowStatus.RUNNING);

      // Transition to COMPLETED
      await machine.transition({
        fromStatus: WorkflowStatus.RUNNING,
        toStatus: WorkflowStatus.COMPLETED,
        transition: WorkflowTransition.ALL_REQUIRED_COMPLETED,
      });
      expect(await machine.getStatus()).toBe(WorkflowStatus.COMPLETED);

      // Verify final state is persisted
      const persisted = await statePersister.readWorkflowState(workflowId);
      expect(persisted.status).toBe(WorkflowStatus.COMPLETED);
    });

    it('should handle pause and resume transitions', async () => {
      const workflowId = 'workflow-002';
      const machine = new WorkflowStateMachine(workflowId, eventBus, statePersister);
      
      machine.initialize(WorkflowStatus.PENDING);
      
      // Start workflow
      await machine.transition({
        fromStatus: WorkflowStatus.PENDING,
        toStatus: WorkflowStatus.RUNNING,
        transition: WorkflowTransition.ENGINE_START,
      });

      // Pause workflow
      await machine.transition({
        fromStatus: WorkflowStatus.RUNNING,
        toStatus: WorkflowStatus.PAUSED,
        transition: WorkflowTransition.DAG_PAUSE,
      });
      expect(await machine.getStatus()).toBe(WorkflowStatus.PAUSED);

      // Resume workflow
      await machine.transition({
        fromStatus: WorkflowStatus.PAUSED,
        toStatus: WorkflowStatus.RUNNING,
        transition: WorkflowTransition.DAG_RESUME,
      });
      expect(await machine.getStatus()).toBe(WorkflowStatus.RUNNING);

      // Complete workflow
      await machine.transition({
        fromStatus: WorkflowStatus.RUNNING,
        toStatus: WorkflowStatus.COMPLETED,
        transition: WorkflowTransition.ALL_REQUIRED_COMPLETED,
      });
      expect(await machine.getStatus()).toBe(WorkflowStatus.COMPLETED);
    });

    it('should handle workflow cancellation', async () => {
      const workflowId = 'workflow-003';
      const machine = new WorkflowStateMachine(workflowId, eventBus, statePersister);
      
      machine.initialize(WorkflowStatus.PENDING);
      
      await machine.transition({
        fromStatus: WorkflowStatus.PENDING,
        toStatus: WorkflowStatus.RUNNING,
        transition: WorkflowTransition.ENGINE_START,
      });

      // Cancel workflow
      await machine.transition({
        fromStatus: WorkflowStatus.RUNNING,
        toStatus: WorkflowStatus.CANCELLED,
        transition: WorkflowTransition.DAG_CANCEL,
      });
      expect(await machine.getStatus()).toBe(WorkflowStatus.CANCELLED);
    });

    it('should persist state changes throughout lifecycle', async () => {
      const workflowId = 'workflow-004';
      const machine = new WorkflowStateMachine(workflowId, eventBus, statePersister);
      
      machine.initialize(WorkflowStatus.PENDING);
      
      // Initialize only sets in-memory state, not persisted yet
      
      // Transition and verify persistence
      await machine.transition({
        fromStatus: WorkflowStatus.PENDING,
        toStatus: WorkflowStatus.RUNNING,
        transition: WorkflowTransition.ENGINE_START,
      });

      let persisted = await statePersister.readWorkflowState(workflowId);
      expect(persisted.status).toBe(WorkflowStatus.RUNNING);

      await machine.transition({
        fromStatus: WorkflowStatus.RUNNING,
        toStatus: WorkflowStatus.COMPLETED,
        transition: WorkflowTransition.ALL_REQUIRED_COMPLETED,
      });

      persisted = await statePersister.readWorkflowState(workflowId);
      expect(persisted.status).toBe(WorkflowStatus.COMPLETED);
    });
  });

  describe('Event Broadcasting and Tracking', () => {
    it('should broadcast events throughout workflow lifecycle', async () => {
      const events: any[] = [];
      
      // Subscribe to all workflow events
      eventBus.subscribe('workflow.started', (event) => {
        events.push(event);
      });
      
      eventBus.subscribe('workflow.completed', (event) => {
        events.push(event);
      });
      
      eventBus.subscribe('workflow.paused', (event) => {
        events.push(event);
      });

      const workflowId = 'workflow-events';
      const machine = new WorkflowStateMachine(workflowId, eventBus, statePersister);
      
      machine.initialize(WorkflowStatus.PENDING);

      // Start workflow
      await machine.transition({
        fromStatus: WorkflowStatus.PENDING,
        toStatus: WorkflowStatus.RUNNING,
        transition: WorkflowTransition.ENGINE_START,
      });

      // Pause workflow
      await machine.transition({
        fromStatus: WorkflowStatus.RUNNING,
        toStatus: WorkflowStatus.PAUSED,
        transition: WorkflowTransition.DAG_PAUSE,
      });

      // Complete workflow
      await machine.transition({
        fromStatus: WorkflowStatus.PAUSED,
        toStatus: WorkflowStatus.RUNNING,
        transition: WorkflowTransition.DAG_RESUME,
      });

      await machine.transition({
        fromStatus: WorkflowStatus.RUNNING,
        toStatus: WorkflowStatus.COMPLETED,
        transition: WorkflowTransition.ALL_REQUIRED_COMPLETED,
      });

      // Verify all events were broadcast
      expect(events.length).toBe(4);
      expect(events[0].type).toBe('workflow.started');
      expect(events[1].type).toBe('workflow.paused');
      expect(events[2].type).toBe('workflow.started'); // Resume broadcasts started
      expect(events[3].type).toBe('workflow.completed');
    });
  });

  describe('Concurrent Workflows', () => {
    it('should manage multiple workflows simultaneously', async () => {
      const workflowIds = ['workflow-concurrent-1', 'workflow-concurrent-2', 'workflow-concurrent-3'];
      const machines: WorkflowStateMachine[] = [];

      // Create multiple workflows
      for (const workflowId of workflowIds) {
        const machine = new WorkflowStateMachine(workflowId, eventBus, statePersister);
        machine.initialize(WorkflowStatus.PENDING);
        machines.push(machine);
      }

      // Start all workflows
      for (const machine of machines) {
        await machine.transition({
          fromStatus: WorkflowStatus.PENDING,
          toStatus: WorkflowStatus.RUNNING,
          transition: WorkflowTransition.ENGINE_START,
        });
      }

      // Verify all are running
      for (const machine of machines) {
        expect(await machine.getStatus()).toBe(WorkflowStatus.RUNNING);
      }

      // Complete all workflows
      for (const machine of machines) {
        await machine.transition({
          fromStatus: WorkflowStatus.RUNNING,
          toStatus: WorkflowStatus.COMPLETED,
          transition: WorkflowTransition.ALL_REQUIRED_COMPLETED,
        });
      }

      // Verify all completed and persisted
      for (const workflowId of workflowIds) {
        const persisted = await statePersister.readWorkflowState(workflowId);
        expect(persisted.status).toBe(WorkflowStatus.COMPLETED);
      }
    });

    it('should handle different lifecycle paths for concurrent workflows', async () => {
      const workflow1 = new WorkflowStateMachine('workflow-diverge-1', eventBus, statePersister);
      const workflow2 = new WorkflowStateMachine('workflow-diverge-2', eventBus, statePersister);

      workflow1.initialize(WorkflowStatus.PENDING);
      workflow2.initialize(WorkflowStatus.PENDING);

      // Workflow 1: Complete path
      await workflow1.transition({
        fromStatus: WorkflowStatus.PENDING,
        toStatus: WorkflowStatus.RUNNING,
        transition: WorkflowTransition.ENGINE_START,
      });

      // Workflow 2: Start and pause
      await workflow2.transition({
        fromStatus: WorkflowStatus.PENDING,
        toStatus: WorkflowStatus.RUNNING,
        transition: WorkflowTransition.ENGINE_START,
      });

      // Workflow 1 completes
      await workflow1.transition({
        fromStatus: WorkflowStatus.RUNNING,
        toStatus: WorkflowStatus.COMPLETED,
        transition: WorkflowTransition.ALL_REQUIRED_COMPLETED,
      });

      // Workflow 2 cancels
      await workflow2.transition({
        fromStatus: WorkflowStatus.RUNNING,
        toStatus: WorkflowStatus.CANCELLED,
        transition: WorkflowTransition.DAG_CANCEL,
      });

      // Verify different end states
      expect(await workflow1.getStatus()).toBe(WorkflowStatus.COMPLETED);
      expect(await workflow2.getStatus()).toBe(WorkflowStatus.CANCELLED);

      const persisted1 = await statePersister.readWorkflowState('workflow-diverge-1');
      const persisted2 = await statePersister.readWorkflowState('workflow-diverge-2');

      expect(persisted1.status).toBe(WorkflowStatus.COMPLETED);
      expect(persisted2.status).toBe(WorkflowStatus.CANCELLED);
    });
  });

  describe('State Recovery', () => {
    it('should recover workflow state after restart', async () => {
      const workflowId = 'workflow-recover';
      
      // Create and start workflow
      const machine1 = new WorkflowStateMachine(workflowId, eventBus, statePersister);
      machine1.initialize(WorkflowStatus.PENDING);

      await machine1.transition({
        fromStatus: WorkflowStatus.PENDING,
        toStatus: WorkflowStatus.RUNNING,
        transition: WorkflowTransition.ENGINE_START,
      });

      await machine1.transition({
        fromStatus: WorkflowStatus.RUNNING,
        toStatus: WorkflowStatus.PAUSED,
        transition: WorkflowTransition.DAG_PAUSE,
      });

      // Simulate restart: read persisted state and create new machine
      const persisted = await statePersister.readWorkflowState(workflowId);
      expect(persisted.status).toBe(WorkflowStatus.PAUSED);

      const machine2 = new WorkflowStateMachine(workflowId, eventBus, statePersister);
      machine2.initialize(persisted.status);

      // Verify state is recovered
      expect(await machine2.getStatus()).toBe(WorkflowStatus.PAUSED);

      // Can continue from recovered state
      await machine2.transition({
        fromStatus: WorkflowStatus.PAUSED,
        toStatus: WorkflowStatus.RUNNING,
        transition: WorkflowTransition.DAG_RESUME,
      });

      expect(await machine2.getStatus()).toBe(WorkflowStatus.RUNNING);
    });
  });
});
