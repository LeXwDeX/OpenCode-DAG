<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
-->

# state-machine/ — Capability Reservoir (实现类) + Shared Types

**Status**: 实现类为 Capability reservoir，types/errors/EventBus 被多模块共享。

本模块分两部分：

## 共享类型与基础设施（被生产路径引用）

- `types.ts` — `WorkflowStatus`、`NodeStatus`、`ShadowNodeStatus` 枚举，`WorkflowEvent`、`NodeEvent` 事件类型
- `errors.ts` — 状态转换合法性函数（`getValidNextWorkflowStatuses()` / `getValidNextNodeStatuses()`）
- `EventBus.ts` — `IEventBus` 共享事件总线
- `IStateMachine.ts` — 接口契约

这些被 Session 路径（`session-service`、`workflow-engine`）和 Core 路径实现类共同引用。

## Capability Reservoir 实现类（未装配到生产）

- `NodeStateMachine` — 节点级状态管理实现
- `WorkflowStateMachine` — 工作流级状态管理实现

当前无生产调用方。生产路径使用 `session-service` 独立维护简化状态转移（`getValidNextSessionWorkflowStatuses()` / `getValidNextSessionNodeStatuses()`）。

详见 [`../../ARCHITECTURE.md` §1 与 §11](../ARCHITECTURE.md)。

**装配判定**:
- 类型/枚举/接口（`WorkflowStatus`、`IEventBus`、`IStateMachine`）→ 可被引用 ✅
- 实例化（`new NodeStateMachine(...)`、`new WorkflowStateMachine(...)`）→ 禁止 ❌（除非经 archgate 审批）

---

*最后更新: 2026-06-07*
