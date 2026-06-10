<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
-->

# state-machine/ — 实现类待退役（D-PLAN-RETIRE）+ 共享类型

**Status**: 实现类批准退役（D-PLAN-RETIRE, ARCHITECTURE.md §8.e, 2026-06-09）；types/EventBus/IStateMachine 为生产强依赖、**不可退**。

本模块分两部分：

## 必留：共享类型与基础设施（生产路径值级/类型级依赖）

- `types.ts` — `WorkflowStatus`、`NodeStatus`、`ShadowNodeStatus` 枚举，`WorkflowEvent`、`NodeEvent` 事件类型
- `EventBus.ts` — `IEventBus` 实现（layer.ts:9 `new EventBus()` 生产装配）
- `IStateMachine.ts` — `IEventBus` 接口（session-service.ts:27, workflow-engine.ts:40, bridge:19 引用）

## 可退：实现类 + errors.ts（零生产引用）

- `NodeStateMachine.ts` / `WorkflowStateMachine.ts` — 实现类，零生产引用，仅测试
- `errors.ts` — 状态转换函数 + 错误类，整文件零生产引用（session-service 有独立的 getValidNextSession* 实现）
- `index.ts` — 全仓零引用的桶文件

详见 [`../../ARCHITECTURE.md` §1 与 §12](../ARCHITECTURE.md)。退/留判定详见 `../../AGENTS.md` 退/留判定表。

---

*最后更新: 2026-06-09（D-PLAN-RETIRE + errors.ts 零生产引用确认）*
