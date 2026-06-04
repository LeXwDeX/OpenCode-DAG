/**
 * @file DAG Smoke Test (Pre-Commit)
 * @description 跨模块冒烟测试，验证四大模块基本集成正确
 */

import { describe, it, expect } from 'bun:test';
import { WorkflowStateMachine } from '../state-machine/WorkflowStateMachine';
import { GroupManager } from '../group-manager/GroupManager';
import { WorktreeManager } from '../worktree-manager/WorktreeManager';
import type { IStatePersister } from '../state-machine/IStateMachine';
import type { IGroupStatePersister } from '../group-manager/GroupManager';
import type { IWorktreePersister } from '../worktree-manager/types';
import type { IEventBus } from '../state-machine/IStateMachine';
import { WorkflowStatus } from '../state-machine/types';

describe('DAG Cross-Module Smoke Tests', () => {
  describe('Mock Smoke Test (Pre-Commit)', () => {
    it('should instantiate and integrate state machine with event bus', () => {
      const events: any[] = [];
      const mockEventBus: IEventBus = {
        emit: (event: any) => { events.push(event); },
        subscribe: () => () => {},
        destroy: () => {},
      };

      const mockPersister: IStatePersister = {
        writeWorkflowState: async () => {},
        readWorkflowState: async () => null,
        deleteWorkflowState: async () => {},
        listWorkflowIds: async () => [],
      };

      const sm = new WorkflowStateMachine('test-workflow', mockEventBus, mockPersister);
      sm.initialize(WorkflowStatus.PENDING);
      
      expect(sm).toBeDefined();
      expect(sm.getStatus()).resolves.toBe(WorkflowStatus.PENDING);
    });

    it('should instantiate GroupManager with EventBus and optional dependencies', () => {
      const events: any[] = [];
      const mockEventBus: IEventBus = {
        emit: (event: any) => { events.push(event); },
        subscribe: () => () => {},
        destroy: () => {},
      };

      const gm = new GroupManager(mockEventBus);
      expect(gm).toBeDefined();
    });

    it('should instantiate WorktreeManager with EventBus and optional persister', () => {
      const events: any[] = [];
      const mockEventBus: IEventBus = {
        emit: (event: any) => { events.push(event); },
        subscribe: () => () => {},
        destroy: () => {},
      };

      const mockPersister: IWorktreePersister = {
        save: async () => {},
        load: async () => [],
      };

      const wtm = new WorktreeManager(mockEventBus, mockPersister);
      expect(wtm).toBeDefined();
    });

    it('should integrate state machine with group manager', async () => {
      const events: any[] = [];
      const mockEventBus: IEventBus = {
        emit: (event: any) => { events.push(event); },
        subscribe: () => () => {},
        destroy: () => {},
      };

      const mockPersister: IStatePersister = {
        writeWorkflowState: async () => {},
        readWorkflowState: async () => null,
        deleteWorkflowState: async () => {},
        listWorkflowIds: async () => [],
      };

      const mockGroupPersister: IGroupStatePersister = {
        saveGroupState: async () => {},
      };

      const sm = new WorkflowStateMachine('test-workflow', mockEventBus, mockPersister);
      sm.initialize(WorkflowStatus.PENDING);

      const gm = new GroupManager(mockEventBus, undefined, mockGroupPersister);
      
      expect(sm).toBeDefined();
      expect(gm).toBeDefined();
    });

    it('should integrate worktree manager with group manager', () => {
      const events: any[] = [];
      const mockEventBus: IEventBus = {
        emit: (event: any) => { events.push(event); },
        subscribe: () => () => {},
        destroy: () => {},
      };

      const mockPersister: IWorktreePersister = {
        save: async () => {},
        load: async () => [],
      };

      const mockGroupPersister: IGroupStatePersister = {
        saveGroupState: async () => {},
      };

      const wtm = new WorktreeManager(mockEventBus, mockPersister);
      const gm = new GroupManager(mockEventBus, wtm, mockGroupPersister);
      
      expect(wtm).toBeDefined();
      expect(gm).toBeDefined();
    });
  });
});
