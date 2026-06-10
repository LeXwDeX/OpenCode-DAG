<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
-->

# scheduler/ — 待退役（D-PLAN-RETIRE）

**Status**: 整目录零生产引用。实现类批准退役（D-PLAN-RETIRE, ARCHITECTURE.md §8.e, 2026-06-09）。

`Scheduler` 实现类当前无生产调用方。生产路径通过 `session/workflow-engine.ts` 调度节点执行。

退/留判定：整目录可退（含 IScheduler.ts / Scheduler.ts / errors.ts / types.ts）。无必留资产。

详见 [`../../ARCHITECTURE.md` §4 与 §12](../ARCHITECTURE.md)。

---

*最后更新: 2026-06-09（D-PLAN-RETIRE）*
