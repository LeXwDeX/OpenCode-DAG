/**
 * DAG Integration Test - Real Implementations
 *
 * Tests with real file-based persisters and real EventBus.
 * No mocks except for test event tracking.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WorkflowStateMachine } from '../state-machine/WorkflowStateMachine';
import { WorkflowStatus, WorkflowTransition } from '../state-machine/types';
import type { IStatePersister, IEventBus } from '../state-machine/IStateMachine';
import { WorktreeManager } from '../worktree-manager/WorktreeManager';
import type { IWorktreePersister, WorktreeInfo } from '../worktree-manager/types';
import { EventBus } from '../state-machine/EventBus';

// ============================================================================
// Real File-Based Persisters
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

class FileWorktreePersister implements IWorktreePersister {
  private file: string;

  constructor(dir: string) {
    this.file = path.join(dir, 'worktrees.json');
  }

  async save(data: WorktreeInfo[]): Promise<void> {
    await fs.writeFile(this.file, JSON.stringify(data, null, 2));
  }

  async load(): Promise<WorktreeInfo[]> {
    try {
      const data = await fs.readFile(this.file, 'utf-8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }
}

// ============================================================================
// Integration Tests with Real Implementations
// ============================================================================

describe('DAG Integration Tests - Real Implementation', () => {
  let testDir: string;
  let statePersister: FileStatePersister;
  let worktreePersister: FileWorktreePersister;
  let eventBus: EventBus;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dag-integration-'));
    statePersister = new FileStatePersister(testDir);
    worktreePersister = new FileWorktreePersister(testDir);
    eventBus = new EventBus();
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true });
    } catch {
      // Ignore
    }
  });

  describe('State Machine with File Persistence', () => {
    it('should persist state to real file system', async () => {
      const workflowId = 'test-workflow-001';
      const machine = new WorkflowStateMachine(workflowId, eventBus, statePersister);
      machine.initialize(WorkflowStatus.PENDING);

      // Transition to RUNNING
      await machine.transition({
        fromStatus: WorkflowStatus.PENDING,
        toStatus: WorkflowStatus.RUNNING,
        transition: WorkflowTransition.ENGINE_START,
      });

      // Verify state is RUNNING
      const status = await machine.getStatus();
      expect(status).toBe(WorkflowStatus.RUNNING);

      // Verify file was written
      const file = path.join(testDir, `${workflowId}.json`);
      const exists = await fs
        .access(file)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);

      // Verify file content
      const content = await fs.readFile(file, 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe(WorkflowStatus.RUNNING);
    });

    it('should restore state via persister and re-initialize', async () => {
      const workflowId = 'test-workflow-002';

      // Write state directly to simulate a previously persisted state
      await statePersister.writeWorkflowState(workflowId, {
        workflowId,
        status: WorkflowStatus.PAUSED,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Read state from persister (simulates a restart reading persisted state)
      const persisted = await statePersister.readWorkflowState(workflowId);
      expect(persisted).not.toBeNull();
      expect(persisted.status).toBe(WorkflowStatus.PAUSED);

      // Create machine and initialize with the persisted status
      const machine = new WorkflowStateMachine(workflowId, eventBus, statePersister);
      machine.initialize(persisted.status);

      // Should have PAUSED status from persisted state
      const status = await machine.getStatus();
      expect(status).toBe(WorkflowStatus.PAUSED);
    });

    it('should handle multiple workflows concurrently', async () => {
      const workflowIds = ['wf-1', 'wf-2', 'wf-3'];
      const machines: WorkflowStateMachine[] = [];

      // Create and transition multiple workflows
      for (const id of workflowIds) {
        const machine = new WorkflowStateMachine(id, eventBus, statePersister);
        machine.initialize(WorkflowStatus.PENDING);
        await machine.transition({
          fromStatus: WorkflowStatus.PENDING,
          toStatus: WorkflowStatus.RUNNING,
          transition: WorkflowTransition.ENGINE_START,
        });
        machines.push(machine);
      }

      // Verify all are RUNNING
      for (const machine of machines) {
        expect(await machine.getStatus()).toBe(WorkflowStatus.RUNNING);
      }

      // Verify all files exist
      for (const id of workflowIds) {
        const file = path.join(testDir, `${id}.json`);
        const exists = await fs
          .access(file)
          .then(() => true)
          .catch(() => false);
        expect(exists).toBe(true);
      }
    });

    it('should list all workflow IDs', async () => {
      const workflowIds = ['list-1', 'list-2', 'list-3'];

      for (const id of workflowIds) {
        await statePersister.writeWorkflowState(id, {
          workflowId: id,
          status: WorkflowStatus.RUNNING,
        });
      }

      const listed = await statePersister.listWorkflowIds();
      expect(listed.sort()).toEqual(workflowIds.sort());
    });

    it('should delete workflow state', async () => {
      const workflowId = 'delete-test';
      const machine = new WorkflowStateMachine(workflowId, eventBus, statePersister);
      machine.initialize(WorkflowStatus.PENDING);

      await machine.transition({
        fromStatus: WorkflowStatus.PENDING,
        toStatus: WorkflowStatus.RUNNING,
        transition: WorkflowTransition.ENGINE_START,
      });

      // Verify exists
      const before = await statePersister.readWorkflowState(workflowId);
      expect(before).not.toBeNull();

      // Delete
      await statePersister.deleteWorkflowState(workflowId);

      // Verify deleted
      const after = await statePersister.readWorkflowState(workflowId);
      expect(after).toBeNull();
    });
  });

  describe('Event Bus Integration', () => {
    it('should broadcast events to subscribers', async () => {
      const events: any[] = [];

      eventBus.subscribe('workflow.started', (event: any) => {
        events.push(event);
      });

      const machine = new WorkflowStateMachine('event-test', eventBus, statePersister);
      machine.initialize(WorkflowStatus.PENDING);

      await machine.transition({
        fromStatus: WorkflowStatus.PENDING,
        toStatus: WorkflowStatus.RUNNING,
        transition: WorkflowTransition.ENGINE_START,
      });

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe('workflow.started');
    });

    it('should unsubscribe when destroy is called', () => {
      let called = false;
      const unsub = eventBus.subscribe('test', () => {
        called = true;
      });

      eventBus.destroy();

      // Subscribe should no longer work
      eventBus.emit({ type: 'test' } as any);
      expect(called).toBe(false);

      // Unsubscribe should be safe to call
      unsub();
    });
  });

  describe('Cross-Module Integration', () => {
    it('should integrate state machine, event bus, and persistence', async () => {
      const workflowId = 'integration-test';
      let startedEvent = false;
      let pausedEvent = false;

      // Subscribe to specific events
      eventBus.subscribe('workflow.started', () => {
        startedEvent = true;
      });
      eventBus.subscribe('workflow.paused', () => {
        pausedEvent = true;
      });

      // Create machine with all dependencies
      const machine = new WorkflowStateMachine(workflowId, eventBus, statePersister);
      machine.initialize(WorkflowStatus.PENDING);

      // Transition through multiple states
      await machine.transition({
        fromStatus: WorkflowStatus.PENDING,
        toStatus: WorkflowStatus.RUNNING,
        transition: WorkflowTransition.ENGINE_START,
      });

      await machine.transition({
        fromStatus: WorkflowStatus.RUNNING,
        toStatus: WorkflowStatus.PAUSED,
        transition: WorkflowTransition.DAG_PAUSE,
      });

      // Verify final state
      expect(await machine.getStatus()).toBe(WorkflowStatus.PAUSED);

      // Verify events were broadcast
      expect(startedEvent).toBe(true);
      expect(pausedEvent).toBe(true);

      // Verify persistence
      const persisted = await statePersister.readWorkflowState(workflowId);
      expect(persisted.status).toBe(WorkflowStatus.PAUSED);
    });

    it('should handle rapid state transitions', async () => {
      const workflowId = 'rapid-test';
      const machine = new WorkflowStateMachine(workflowId, eventBus, statePersister);
      machine.initialize(WorkflowStatus.PENDING);

      // Initial transition: PENDING -> RUNNING
      await machine.transition({
        fromStatus: WorkflowStatus.PENDING,
        toStatus: WorkflowStatus.RUNNING,
        transition: WorkflowTransition.ENGINE_START,
      });
      expect(await machine.getStatus()).toBe(WorkflowStatus.RUNNING);

      // Rapid but valid transitions: RUNNING -> PAUSED -> RUNNING -> PAUSED ...
      for (let i = 0; i < 10; i++) {
        await machine.transition({
          fromStatus: WorkflowStatus.RUNNING,
          toStatus: WorkflowStatus.PAUSED,
          transition: WorkflowTransition.DAG_PAUSE,
        });
        expect(await machine.getStatus()).toBe(WorkflowStatus.PAUSED);

        await machine.transition({
          fromStatus: WorkflowStatus.PAUSED,
          toStatus: WorkflowStatus.RUNNING,
          transition: WorkflowTransition.DAG_RESUME,
        });
        expect(await machine.getStatus()).toBe(WorkflowStatus.RUNNING);
      }

      // Verify persistence is consistent
      const persisted = await statePersister.readWorkflowState(workflowId);
      expect(persisted).not.toBeNull();
      expect(persisted.status).toBe(WorkflowStatus.RUNNING);
    });
  });
});
