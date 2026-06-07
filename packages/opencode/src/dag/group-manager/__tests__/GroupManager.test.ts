// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * GroupManager 单元测试
 *
 * 覆盖 IGroupManager 所有方法，包括：
 * - Group CRUD
 * - Branch CRUD
 * - 状态管理（铁律 #15 #16 #17）
 * - 依赖管理
 * - 环境管理（继承）
 * - Fallback 管理
 * - 并发控制
 * - 配置继承
 * - 嵌套深度限制
 * - Worktree 隔离
 * - 事件广播
 * - 生命周期（cleanup / export / import）
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { GroupManager } from '../GroupManager';
import { DependencyGraph } from '../DependencyGraph';
import type {
  IEventBus,
  UnsubscribeFunction,
  IStatePersister,
} from '../../state-machine/IStateMachine';
import type { WorkflowEvent, NodeEvent } from '../../state-machine/types';
import type { GroupConfig, GroupEvent } from '../types';
import {
  GroupNotFoundError,
  GroupConflictError,
  GroupNestingDepthError,
  GroupDependedOnError,
  InvalidGroupTransitionError,
  GroupTerminalViolationError,
  BranchNotFoundError,
  BranchConflictError,
  GroupConfigError,
} from '../errors';

// ============================================================================
// Test helpers
// ============================================================================

function createStubEventBus() {
  const events: (WorkflowEvent | NodeEvent)[] = [];
  const bus: IEventBus = {
    subscribe(_event: string, _listener: any): UnsubscribeFunction {
      return () => {};
    },
    emit(event: WorkflowEvent | NodeEvent): void {
      events.push(event);
    },
    destroy(): void {},
  };
  return { bus, events };
}

function makeConfig(id: string, overrides: Partial<GroupConfig> = {}): GroupConfig {
  return { id, name: `Group ${id}`, ...overrides };
}

// ============================================================================
// Tests
// ============================================================================

describe('GroupManager', () => {
  let eventBus: IEventBus;
  let events: (WorkflowEvent | NodeEvent)[];
  let manager: GroupManager;

  beforeEach(() => {
    const stub = createStubEventBus();
    eventBus = stub.bus;
    events = stub.events;
    manager = new GroupManager(eventBus);
  });

  // ==========================================================================
  // Group CRUD
  // ==========================================================================

  describe('Group CRUD', () => {
    it('createGroup 应创建并返回 Group', async () => {
      const group = await manager.createGroup(makeConfig('g1'));
      expect(group.id).toBe('g1');
      expect(group.name).toBe('Group g1');
      expect(group.status).toBe('pending');
    });

    it('createGroup 重复 ID 应抛出 GroupConflictError', async () => {
      await manager.createGroup(makeConfig('g1'));
      await expect(manager.createGroup(makeConfig('g1'))).rejects.toBeInstanceOf(GroupConflictError);
    });

    it('createGroup 带依赖应正确注册', async () => {
      await manager.createGroup(makeConfig('g1'));
      await manager.createGroup(makeConfig('g2', { depends_on: ['g1'] }));
      const deps = await manager.getDependencies('g2');
      expect(deps).toContain('g1');
    });

    it('createGroup 依赖不存在应抛出 GroupConfigError', async () => {
      await expect(
        manager.createGroup(makeConfig('g2', { depends_on: ['missing'] }))
      ).rejects.toBeInstanceOf(GroupConfigError);
    });

    it('createGroup 带 sub_groups 应递归创建', async () => {
      await manager.createGroup(
        makeConfig('parent', {
          sub_groups: [
            makeConfig('child1'),
            makeConfig('child2'),
          ],
        })
      );
      const c1 = await manager.getGroup('child1');
      expect(c1.group.parent_id).toBe('parent');
      const c2 = await manager.getGroup('child2');
      expect(c2.group.parent_id).toBe('parent');
    });

    it('createGroup 带初始 branches 应注册', async () => {
      await manager.createGroup(
        makeConfig('g1', {
          branches: [{ id: 'b1', name: 'Branch 1', nodes: ['n1'] }],
        })
      );
      const branches = await manager.getBranches('g1');
      expect(branches).toHaveLength(1);
      expect(branches[0]!.id).toBe('b1');
    });

    it('deleteGroup 应删除 Group', async () => {
      await manager.createGroup(makeConfig('g1'));
      await manager.deleteGroup('g1');
      await expect(manager.getGroup('g1')).rejects.toBeInstanceOf(GroupNotFoundError);
    });

    it('deleteGroup 不存在的应抛出 GroupNotFoundError', async () => {
      await expect(manager.deleteGroup('x')).rejects.toBeInstanceOf(GroupNotFoundError);
    });

    it('deleteGroup 被依赖的应抛出 GroupDependedOnError', async () => {
      await manager.createGroup(makeConfig('g1'));
      await manager.createGroup(makeConfig('g2', { depends_on: ['g1'] }));
      await expect(manager.deleteGroup('g1')).rejects.toBeInstanceOf(GroupDependedOnError);
    });

    it('getGroup 应返回 GroupQueryResult', async () => {
      await manager.createGroup(makeConfig('g1'));
      const result = await manager.getGroup('g1');
      expect(result.group.id).toBe('g1');
      expect(result.parent_path).toEqual([]);
    });

    it('getGroup 嵌套 Group 应有正确的 parent_path', async () => {
      await manager.createGroup(
        makeConfig('root', { sub_groups: [makeConfig('child')] })
      );
      const result = await manager.getGroup('child');
      expect(result.parent_path).toEqual(['root']);
    });

    it('getAllGroups 应返回所有 Groups', async () => {
      await manager.createGroup(makeConfig('g1'));
      await manager.createGroup(makeConfig('g2'));
      const all = await manager.getAllGroups();
      expect(all).toHaveLength(2);
    });
  });

  // ==========================================================================
  // Branch CRUD
  // ==========================================================================

  describe('Branch CRUD', () => {
    beforeEach(async () => {
      await manager.createGroup(makeConfig('g1'));
    });

    it('addBranch 应添加分支', async () => {
      const branch = await manager.addBranch('g1', {
        id: 'b1',
        name: 'Branch 1',
        nodes: ['n1'],
      });
      expect(branch.id).toBe('b1');
      expect(branch.status).toBe('pending');
    });

    it('addBranch 重复 ID 应抛出 BranchConflictError', async () => {
      await manager.addBranch('g1', { id: 'b1', name: 'B1', nodes: [] });
      await expect(
        manager.addBranch('g1', { id: 'b1', name: 'B1 dup', nodes: [] })
      ).rejects.toBeInstanceOf(BranchConflictError);
    });

    it('deleteBranch 应删除分支', async () => {
      await manager.addBranch('g1', { id: 'b1', name: 'B1', nodes: [] });
      await manager.deleteBranch('g1', 'b1');
      await expect(manager.getBranch('g1', 'b1')).rejects.toBeInstanceOf(BranchNotFoundError);
    });

    it('deleteBranch 不存在的应抛出 BranchNotFoundError', async () => {
      await expect(manager.deleteBranch('g1', 'x')).rejects.toBeInstanceOf(BranchNotFoundError);
    });

    it('getBranch 应返回正确分支', async () => {
      await manager.addBranch('g1', { id: 'b1', name: 'B1', nodes: ['n1'] });
      const branch = await manager.getBranch('g1', 'b1');
      expect(branch.name).toBe('B1');
    });

    it('getBranches 应返回所有分支', async () => {
      await manager.addBranch('g1', { id: 'b1', name: 'B1', nodes: [] });
      await manager.addBranch('g1', { id: 'b2', name: 'B2', nodes: [] });
      const branches = await manager.getBranches('g1');
      expect(branches).toHaveLength(2);
    });
  });

  // ==========================================================================
  // 状态管理（铁律 #15 #16 #17）
  // ==========================================================================

  describe('状态管理', () => {
    beforeEach(async () => {
      await manager.createGroup(makeConfig('g1'));
    });

    it('pending → running 应成功', async () => {
      await manager.updateGroupStatus('g1', 'running');
      const result = await manager.getGroup('g1');
      expect(result.group.status).toBe('running');
    });

    it('running → completed 应成功', async () => {
      await manager.updateGroupStatus('g1', 'running');
      await manager.updateGroupStatus('g1', 'completed');
      const result = await manager.getGroup('g1');
      expect(result.group.status).toBe('completed');
    });

    it('running → failed 应成功', async () => {
      await manager.updateGroupStatus('g1', 'running');
      await manager.updateGroupStatus('g1', 'failed');
      expect((await manager.getGroup('g1')).group.status).toBe('failed');
    });

    it('running → cancelled 应成功', async () => {
      await manager.updateGroupStatus('g1', 'running');
      await manager.updateGroupStatus('g1', 'cancelled');
      expect((await manager.getGroup('g1')).group.status).toBe('cancelled');
    });

    it('pending → cancelled 应成功', async () => {
      await manager.updateGroupStatus('g1', 'cancelled');
      expect((await manager.getGroup('g1')).group.status).toBe('cancelled');
    });

    it('铁律 #16: completed 不可回退到 running', async () => {
      await manager.updateGroupStatus('g1', 'running');
      await manager.updateGroupStatus('g1', 'completed');
      await expect(
        manager.updateGroupStatus('g1', 'running')
      ).rejects.toBeInstanceOf(GroupTerminalViolationError);
    });

    it('铁律 #16: failed 不可回退', async () => {
      await manager.updateGroupStatus('g1', 'running');
      await manager.updateGroupStatus('g1', 'failed');
      await expect(
        manager.updateGroupStatus('g1', 'running')
      ).rejects.toBeInstanceOf(GroupTerminalViolationError);
    });

    it('铁律 #16: cancelled 不可回退', async () => {
      await manager.updateGroupStatus('g1', 'cancelled');
      await expect(
        manager.updateGroupStatus('g1', 'running')
      ).rejects.toBeInstanceOf(GroupTerminalViolationError);
    });

    it('铁律 #15: pending → completed 是非法转移', async () => {
      await expect(
        manager.updateGroupStatus('g1', 'completed')
      ).rejects.toBeInstanceOf(InvalidGroupTransitionError);
    });

    it('铁律 #17: 状态变更应广播事件', async () => {
      events.length = 0;
      await manager.updateGroupStatus('g1', 'running');
      expect(events.length).toBe(1);
      const event = events[0] as unknown as GroupEvent;
      expect(event.type).toBe('group.state_changed');
    });

    it('running 时应设置 started_at', async () => {
      await manager.updateGroupStatus('g1', 'running');
      const result = await manager.getGroup('g1');
      expect(result.group.started_at).toBeDefined();
    });

    it('completed 时应设置 completed_at', async () => {
      await manager.updateGroupStatus('g1', 'running');
      await manager.updateGroupStatus('g1', 'completed');
      const result = await manager.getGroup('g1');
      expect(result.group.completed_at).toBeDefined();
    });

    it('不存在的 Group 应抛出 GroupNotFoundError', async () => {
      await expect(
        manager.updateGroupStatus('x', 'running')
      ).rejects.toBeInstanceOf(GroupNotFoundError);
    });
  });

  describe('Branch 状态管理', () => {
    beforeEach(async () => {
      await manager.createGroup(makeConfig('g1'));
      await manager.addBranch('g1', { id: 'b1', name: 'B1', nodes: [] });
    });

    it('分支 pending → running 应成功', async () => {
      await manager.updateBranchStatus('g1', 'b1', 'running');
      const branch = await manager.getBranch('g1', 'b1');
      expect(branch.status).toBe('running');
    });

    it('分支状态变更应广播事件', async () => {
      events.length = 0;
      await manager.updateBranchStatus('g1', 'b1', 'running');
      expect(events.length).toBe(1);
      const event = events[0] as unknown as GroupEvent;
      expect(event.type).toBe('branch.state_changed');
    });

    it('分支终态不可回退', async () => {
      await manager.updateBranchStatus('g1', 'b1', 'running');
      await manager.updateBranchStatus('g1', 'b1', 'completed');
      await expect(
        manager.updateBranchStatus('g1', 'b1', 'running')
      ).rejects.toBeInstanceOf(GroupTerminalViolationError);
    });
  });

  // ==========================================================================
  // 依赖管理
  // ==========================================================================

  describe('依赖管理', () => {
    beforeEach(async () => {
      await manager.createGroup(makeConfig('g1'));
      await manager.createGroup(makeConfig('g2'));
      await manager.createGroup(makeConfig('g3'));
    });

    it('addDependency 应添加依赖', async () => {
      await manager.addDependency('g2', ['g1']);
      const deps = await manager.getDependencies('g2');
      expect(deps).toContain('g1');
    });

    it('removeDependency 应移除依赖', async () => {
      await manager.addDependency('g2', ['g1']);
      await manager.removeDependency('g2', ['g1']);
      const deps = await manager.getDependencies('g2');
      expect(deps).not.toContain('g1');
    });

    it('hasCycles 无环应返回 false', async () => {
      await manager.addDependency('g2', ['g1']);
      expect(await manager.hasCycles()).toBe(false);
    });

    it('getTopologicalOrder 应返回正确排序', async () => {
      await manager.addDependency('g2', ['g1']);
      await manager.addDependency('g3', ['g2']);
      const order = await manager.getTopologicalOrder();
      expect(order.indexOf('g1')).toBeLessThan(order.indexOf('g2'));
      expect(order.indexOf('g2')).toBeLessThan(order.indexOf('g3'));
    });

    it('getExecutableGroups 无完成时返回叶节点', async () => {
      await manager.addDependency('g2', ['g1']);
      const exec = await manager.getExecutableGroups();
      // g1 和 g3 无依赖，可执行
      expect(exec).toContain('g1');
      expect(exec).toContain('g3');
    });

    it('getExecutableGroups 部分完成时返回下一批', async () => {
      await manager.addDependency('g2', ['g1']);
      await manager.updateGroupStatus('g1', 'running');
      await manager.updateGroupStatus('g1', 'completed');
      const exec = await manager.getExecutableGroups();
      expect(exec).toContain('g2');
    });
  });

  // ==========================================================================
  // 环境管理（继承）
  // ==========================================================================

  describe('环境管理', () => {
    it('setEnvironment / getEnvironment 基本操作', async () => {
      await manager.createGroup(makeConfig('g1'));
      await manager.setEnvironment('g1', { NODE_ENV: 'production' });
      const env = await manager.getEnvironment('g1');
      expect(env.NODE_ENV).toBe('production');
    });

    it('子 Group 应继承父的 env', async () => {
      await manager.createGroup(
        makeConfig('parent', {
          env: { NODE_ENV: 'production', DB: 'main' },
          sub_groups: [makeConfig('child')],
        })
      );
      const env = await manager.getEnvironment('child');
      expect(env.NODE_ENV).toBe('production');
      expect(env.DB).toBe('main');
    });

    it('子配置应覆盖父配置的 env', async () => {
      await manager.createGroup(
        makeConfig('parent', {
          env: { NODE_ENV: 'production', DB: 'main' },
          sub_groups: [
            makeConfig('child', { env: { NODE_ENV: 'development' } }),
          ],
        })
      );
      const env = await manager.getEnvironment('child');
      expect(env.NODE_ENV).toBe('development');
      expect(env.DB).toBe('main');
    });

    it('多层级继承应逐层覆盖', async () => {
      await manager.createGroup(
        makeConfig('root', {
          env: { A: '1', B: '2', C: '3' },
          sub_groups: [
            makeConfig('mid', {
              env: { B: '20' },
              sub_groups: [
                makeConfig('leaf', { env: { C: '30' } }),
              ],
            }),
          ],
        })
      );
      const env = await manager.getEnvironment('leaf');
      expect(env.A).toBe('1');   // 从 root 继承
      expect(env.B).toBe('20');  // mid 覆盖 root
      expect(env.C).toBe('30');  // leaf 覆盖 root
    });
  });

  // ==========================================================================
  // 配置继承（getResolvedConfig）
  // ==========================================================================

  describe('配置继承', () => {
    it('getResolvedConfig 应合并 env', async () => {
      await manager.createGroup(
        makeConfig('parent', {
          env: { KEY: 'parent_val' },
          sub_groups: [makeConfig('child')],
        })
      );
      const resolved = await manager.getResolvedConfig('child');
      expect(resolved.env.KEY).toBe('parent_val');
    });

    it('getResolvedConfig 应包含子自身配置', async () => {
      await manager.createGroup(makeConfig('g1', {
        env: { A: '1' },
        max_parallel: 3,
      }));
      const resolved = await manager.getResolvedConfig('g1');
      expect(resolved.env.A).toBe('1');
      expect(resolved.max_parallel).toBe(3);
    });
  });

  // ==========================================================================
  // 嵌套深度限制
  // ==========================================================================

  describe('嵌套深度限制', () => {
    it('5 层嵌套应成功', async () => {
      const deep = makeConfig('l1', {
        sub_groups: [
          makeConfig('l2', {
            sub_groups: [
              makeConfig('l3', {
                sub_groups: [
                  makeConfig('l4', {
                    sub_groups: [makeConfig('l5')],
                  }),
                ],
              }),
            ],
          }),
        ],
      });
      await expect(manager.createGroup(deep)).resolves.toBeDefined();
    });

    it('6 层嵌套应抛出 GroupNestingDepthError', async () => {
      const deep = makeConfig('l1', {
        sub_groups: [
          makeConfig('l2', {
            sub_groups: [
              makeConfig('l3', {
                sub_groups: [
                  makeConfig('l4', {
                    sub_groups: [
                      makeConfig('l5', {
                        sub_groups: [makeConfig('l6')],
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      });
      await expect(manager.createGroup(deep)).rejects.toBeInstanceOf(GroupNestingDepthError);
    });
  });

  // ==========================================================================
  // Fallback 管理
  // ==========================================================================

  describe('Fallback 管理', () => {
    beforeEach(async () => {
      await manager.createGroup(makeConfig('g1'));
    });

    it('setFallback / getFallback 基本操作', async () => {
      await manager.setFallback('g1', { node: 'shadow1', trigger: 'on_error' });
      const fb = await manager.getFallback('g1');
      expect(fb?.node).toBe('shadow1');
      expect(fb?.trigger).toBe('on_error');
    });

    it('getFallback 无配置时返回 null', async () => {
      const fb = await manager.getFallback('g1');
      expect(fb).toBeNull();
    });

    it('executeFallback 有配置时应返回结果', async () => {
      await manager.setFallback('g1', { node: 'shadow1' });
      const result = await manager.executeFallback('g1');
      expect(result.fallback_node).toBe('shadow1');
      expect(result.decision).toBe('rerun');
    });

    it('executeFallback 无配置时应抛出错误', async () => {
      await expect(manager.executeFallback('g1')).rejects.toThrow();
    });
  });

  // ==========================================================================
  // 并发控制
  // ==========================================================================

  describe('并发控制', () => {
    beforeEach(async () => {
      await manager.createGroup(makeConfig('g1', { max_parallel: 2 }));
      await manager.addBranch('g1', { id: 'b1', name: 'B1', nodes: [] });
      await manager.addBranch('g1', { id: 'b2', name: 'B2', nodes: [] });
      await manager.addBranch('g1', { id: 'b3', name: 'B3', nodes: [] });
    });

    it('setMaxParallel / getMaxParallel 基本操作', async () => {
      await manager.setMaxParallel('g1', 5);
      expect(await manager.getMaxParallel('g1')).toBe(5);
    });

    it('getMaxParallel 未设置时返回 Infinity', async () => {
      await manager.createGroup(makeConfig('g2'));
      expect(await manager.getMaxParallel('g2')).toBe(Infinity);
    });

    it('isConcurrencyExceeded 未超时应返回 false', async () => {
      expect(await manager.isConcurrencyExceeded('g1')).toBe(false);
    });

    it('isConcurrencyExceeded 超限时应返回 true', async () => {
      await manager.updateBranchStatus('g1', 'b1', 'running');
      await manager.updateBranchStatus('g1', 'b2', 'running');
      expect(await manager.isConcurrencyExceeded('g1')).toBe(true);
    });

    it('getRunningBranchCount 应正确计数', async () => {
      expect(await manager.getRunningBranchCount('g1')).toBe(0);
      await manager.updateBranchStatus('g1', 'b1', 'running');
      expect(await manager.getRunningBranchCount('g1')).toBe(1);
    });
  });

  // ==========================================================================
  // Worktree 管理
  // ==========================================================================

  describe('Worktree 管理', () => {
    beforeEach(async () => {
      await manager.createGroup(
        makeConfig('g1', {
          worktree: { base_path: '/tmp/wt', branch_prefix: 'group-' },
        })
      );
    });

    it('createWorktree 无 worktreeManager 时返回空信息', async () => {
      const info = await manager.createWorktree('g1');
      expect(info.groupId).toBe('g1');
      expect(info.path).toBe('');
    });

    it('deleteWorktree 应清除路径', async () => {
      await manager.createWorktree('g1');
      await manager.deleteWorktree('g1');
      const info = await manager.getWorktreeInfo('g1');
      expect(info.path).toBe('');
    });

    it('getWorktreeInfo 应返回信息', async () => {
      const info = await manager.getWorktreeInfo('g1');
      expect(info.groupId).toBe('g1');
    });

    it('mergeWorktree 无 worktree 时返回失败', async () => {
      const result = await manager.mergeWorktree('g1');
      expect(result.success).toBe(false);
    });
  });

  // ==========================================================================
  // 事件广播（铁律 #17）
  // ==========================================================================

  describe('事件广播', () => {
    it('createGroup 应广播 group.created', async () => {
      events.length = 0;
      await manager.createGroup(makeConfig('g1'));
      const created = events.find((e: any) => e.type === 'group.created');
      expect(created).toBeDefined();
    });

    it('deleteGroup 应广播 group.removed', async () => {
      await manager.createGroup(makeConfig('g1'));
      events.length = 0;
      await manager.deleteGroup('g1');
      const removed = events.find((e: any) => e.type === 'group.removed');
      expect(removed).toBeDefined();
    });

    it('updateGroupStatus 应广播 group.state_changed', async () => {
      await manager.createGroup(makeConfig('g1'));
      events.length = 0;
      await manager.updateGroupStatus('g1', 'running');
      expect(events.length).toBe(1);
      expect((events[0] as any).type).toBe('group.state_changed');
      expect((events[0] as any).newStatus).toBe('running');
    });
  });

  // ==========================================================================
  // 生命周期
  // ==========================================================================

  describe('生命周期', () => {
    it('cleanup 应清除所有状态', async () => {
      await manager.createGroup(makeConfig('g1'));
      await manager.createGroup(makeConfig('g2'));
      await manager.cleanup();
      const all = await manager.getAllGroups();
      expect(all).toHaveLength(0);
    });

    it('exportConfig 应导出所有 Group 配置', async () => {
      await manager.createGroup(makeConfig('g1'));
      await manager.createGroup(makeConfig('g2'));
      const configs = await manager.exportConfig();
      expect(configs).toHaveLength(2);
    });

    it('importConfig 应导入 Groups', async () => {
      const configs = [makeConfig('g1'), makeConfig('g2')];
      await manager.importConfig(configs);
      const all = await manager.getAllGroups();
      expect(all).toHaveLength(2);
    });

    it('importConfig 已存在的 ID 应跳过', async () => {
      await manager.createGroup(makeConfig('g1'));
      await manager.importConfig([makeConfig('g1'), makeConfig('g2')]);
      const all = await manager.getAllGroups();
      expect(all).toHaveLength(2);
    });
  });

  // ==========================================================================
  // 原子删除（两阶段）
  // ==========================================================================

  describe('原子删除（两阶段）', () => {
    it('删除带子树的父 Group 时，若子树中有被外部依赖的节点，应保持原子性', async () => {
      // 准备：父 Group 有 2 个子 Group，第 2 个子 Group 被外部 Group 依赖
      await manager.createGroup(makeConfig('parent'));
      await manager.createGroup(makeConfig('child1', { parent_id: 'parent' }));
      await manager.createGroup(makeConfig('child2', { parent_id: 'parent' }));
      await manager.createGroup(makeConfig('external', { depends_on: ['child2'] }));

      // 执行：尝试删除 parent（应失败，因为 child2 被 external 依赖）
      await expect(manager.deleteGroup('parent')).rejects.toThrow(GroupDependedOnError);

      // 验证：child1 不应该被删除（原子性）—— 所有 4 个 Group 都在
      const all = await manager.getAllGroups();
      expect(all).toHaveLength(4); // parent, child1, child2, external
    });

    it('删除无外部依赖的子树应成功', async () => {
      await manager.createGroup(makeConfig('parent'));
      await manager.createGroup(makeConfig('child1', { parent_id: 'parent' }));
      await manager.createGroup(makeConfig('child2', { parent_id: 'parent' }));

      await manager.deleteGroup('parent');

      const all = await manager.getAllGroups();
      expect(all).toHaveLength(0);
    });
  });

  // ==========================================================================
  // getExecutableGroups 过滤
  // ==========================================================================

  describe('getExecutableGroups 过滤', () => {
    it('只返回 pending 状态的 Group，不返回 running/failed/cancelled', async () => {
      await manager.createGroup(makeConfig('g1')); // pending
      await manager.createGroup(makeConfig('g2'));
      await manager.createGroup(makeConfig('g3'));
      await manager.createGroup(makeConfig('g4'));

      await manager.updateGroupStatus('g2', 'running');
      await manager.updateGroupStatus('g3', 'running');
      await manager.updateGroupStatus('g3', 'failed');
      await manager.updateGroupStatus('g4', 'cancelled');

      const executable = await manager.getExecutableGroups();

      expect(executable).toContain('g1'); // pending ✅
      expect(executable).not.toContain('g2'); // running ❌
      expect(executable).not.toContain('g3'); // failed ❌
      expect(executable).not.toContain('g4'); // cancelled ❌
    });
  });

  // ==========================================================================
  // IGroupStatePersister 集成
  // ==========================================================================

  describe('IGroupStatePersister 集成', () => {
    it('updateGroupStatus 调用 persister.saveGroupState 且在 emit 之前', async () => {
      const callOrder: string[] = [];

      const stub = createStubEventBus();
      // 替换 eventBus 的 emit 以记录调用顺序
      stub.bus.emit = () => {
        callOrder.push('emit');
      };

      const mockPersister = {
        saveGroupState: async (groupId: string, state: any) => {
          callOrder.push('persist');
        },
      };

      const managerWithPersister = new GroupManager(stub.bus, undefined, mockPersister);
      await managerWithPersister.createGroup(makeConfig('g1'));

      callOrder.length = 0; // 清空
      await managerWithPersister.updateGroupStatus('g1', 'running');

      expect(callOrder).toEqual(['persist', 'emit']);
    });

    it('无 persister 时 updateGroupStatus 仍应正常 emit', async () => {
      await manager.createGroup(makeConfig('g1'));
      events.length = 0;
      await manager.updateGroupStatus('g1', 'running');
      expect(events.length).toBe(1);
    });
  });
});
