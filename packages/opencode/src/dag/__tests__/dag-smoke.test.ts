// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * @file DAG Smoke Test (Pre-Commit)
 * @description 跨模块冒烟测试，验证生产装配模块基本集成正确
 *              Retired Core classes (NodeStateMachine / WorkflowStateMachine /
 *              GroupManager / Scheduler) removed per D-PLAN-RETIRE (WP-6).
 */

import { describe, it, expect } from 'bun:test';
import { WorktreeManager } from '../worktree-manager/WorktreeManager';
import type { IWorktreePersister } from '../worktree-manager/types';
import type { IEventBus } from '../state-machine/IStateMachine';

describe('DAG Cross-Module Smoke Tests', () => {
  describe('Mock Smoke Test (Pre-Commit)', () => {
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

  });
});
