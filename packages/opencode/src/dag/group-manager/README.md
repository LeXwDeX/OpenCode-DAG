<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
-->

# group-manager/ — 待退役（D-PLAN-RETIRE）

**Status**: 实现类批准退役（D-PLAN-RETIRE, ARCHITECTURE.md §8.e, 2026-06-09）。

`GroupManager` / `DependencyGraph` / `IGroupManager` / `IDependencyGraph` / `errors.ts` 当前无生产调用方。

**⚠️ 必留资产**：`group-manager/types.ts` 中的 `GroupEvent` 被 `state-machine/EventBus.ts:22` + `IStateMachine.ts:32` 传递引用，是 `IEventBus.emit()` 签名 union 的一部分（API.md §7 锚定），**不可删除**。

详见 [`../../ARCHITECTURE.md` §2 与 §12](../ARCHITECTURE.md)。退/留判定详见 `../../AGENTS.md` 退/留判定表。

---

*最后更新: 2026-06-09（D-PLAN-RETIRE）*
