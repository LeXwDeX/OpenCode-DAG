# DAG 工作流引擎 - 开发者指南

## 概述

DAG 工作流引擎是 opencode 的核心扩展模块，实现了基于有向无环图的任务编排系统。本文档为开发者提供二次开发和维护的指导。

## 架构约束

### 四条铁律（不可违反）

DAG 引擎所有状态变更模块必须遵守：

1. **状态机不可绕过** — 所有状态变更必须通过状态机 API，禁止直接修改状态变量
2. **终态不可逆** — `completed`/`failed`/`cancelled`/`archived` 不可回退
3. **事件必须广播** — 每次状态变更必须发出对应事件（含完整上下文）
4. **状态持久化优先** — 内存状态变更前必须先持久化到 SQLite，失败时回滚内存

### 跨模块设计模式

所有 DAG 模块遵循统一设计模式（详见 `ARCHITECTURE.md` §0）：

| 规则 | 要点 |
|------|------|
| §0.1 构造函数依赖注入 | 必需依赖在前，可选依赖在后（`eventBus?: IEventBus`） |
| §0.2 事件广播统一 | 共享同一 `IEventBus` 实例，禁止自建事件通道 |
| §0.3 持久化 rollback | 先持久化 → 后内存 → 最后广播；持久化失败自动回滚 |
| §0.4 类型桥接 | `as unknown as WorkflowEvent \| NodeEvent`，禁止 `as any` |

## 模块开发规范

### 创建新模块前检查

- [ ] 阅读 `ARCHITECTURE.md` §0-§3，理解现有模块设计模式
- [ ] 检查依赖关系图（`ARCHITECTURE.md` §5），避免循环依赖
- [ ] 定义清晰的接口边界（参考现有 `IXxx.ts` 模式）
- [ ] 确认事件类型命名规范（`module.entity.event_type`）

### 模块开发流程

1. **定义接口** — `types.ts` 中声明 `IMyModule`
2. **实现骨架** — `MyModule.ts` 中实现，遵循 §0.1-§0.4
3. **编写测试** — 按铁律组织测试用例
4. **更新文档** — 在 `ARCHITECTURE.md` 添加模块章节

### 测试规范

- 测试按铁律组织（`describe('铁律 #N: ...')`）
- 命名清晰描述测试内容，禁止模糊命名（`should work`）
- 运行命令：`cd packages/opencode && bun test src/dag`

### 代码审查清单

- [ ] 所有状态变更通过状态机 API（铁律 #1）
- [ ] 终态不可逆（铁律 #2）
- [ ] 所有状态变更发出事件（铁律 #3）
- [ ] 持久化优先于内存更新（铁律 #4）
- [ ] 遵循跨模块设计模式（ARCHITECTURE.md §0）
- [ ] 无 `any` 类型，无硬编码依赖，无循环依赖

## 测试状态

**总计: 396 pass, 5 skip, 0 fail**（跨 15 个测试文件，2026-06-05）

| 模块 | 测试数 | 状态 |
|------|--------|------|
| state-machine | 65 | ✅ |
| scheduler | 43 | ✅ |
| worktree-manager | 15 | ✅ |
| group-manager | 43 | ✅ |
| dag-integration | 24 | ✅ |
| dag-smoke | 5 | ✅ |
| dag-e2e | 8 | ✅ |
| dag-deepseek-e2e | 8 | ✅ |
| worker-execution | 16 | ✅ |
| session-service | 98 | ✅ |
| workflow-engine | 14 | ✅ |
| required-nodes-validator | 17 | ✅ |

完整测试文件清单见各模块 `__tests__/` 目录。

## 文档索引

| 文档 | 用途 |
|------|------|
| `ARCHITECTURE.md` | 模块架构设计、依赖关系图、各模块章节 |
| `API.md` | 公共接口参考、状态转移表、事件系统 |
| `USER_GUIDE.md` | 用户使用教程、配置参考、常见模式 |
| `README.md` | 项目概述、快速开始、约束限制 |

### 铁律执行覆盖验证

2026-06-05 archgate 回归审阅判定 **PASS**：

| 层 | 铁律 #1 | 铁律 #2 | 铁律 #3 | 铁律 #4 |
|----|---------|---------|---------|---------|
| state-machine | ✅ transition() 封装 | ✅ isWorkflowTerminalStatus | ✅ emitEvent() | ✅ persist-first |
| scheduler | ✅ updateWorkerStatus | ✅ TERMINAL_WORKER_STATUSES | ✅ emit via rollback | ✅ rollback |
| group-manager | ✅ updateGroupStatus | ✅ isTerminalStatus | ✅ emit | ✅ Group 级 |
| worktree-manager | ✅ update | ✅ TERMINAL_WORKTREE_STATUSES | ✅ emit | ✅ rollback |
| session-service | ✅ getValidNextSession* 验证 | ✅ 终态返回[] | ✅ setEventBus + emit | ✅ DB 写入 |

事件系统已统一为 `state-machine/types.ts` 定义的 dot notation（`workflow.*` / `node.*`）。

---

*最后更新: 2026-06-05*
