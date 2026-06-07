<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
-->

# scheduler/ — Capability Reservoir

**Status**: Capability reservoir. Not wired to production.

`Scheduler` 实现类当前无生产调用方。生产路径通过 `session/workflow-engine.ts` 调度节点执行。

本模块被保留用于未来场景（影子执行、工具路径、dry-run、Group 级并发调度）。详见 [`../../ARCHITECTURE.md` §4 与 §11](../ARCHITECTURE.md)。

**装配判定**:
- 类型（`IScheduler`、`SchedulerError`、`NodeExecutor` 接口）→ 可被引用 ✅
- 实例化（`new Scheduler(...)`）→ 禁止 ❌（除非经 archgate 审批）

---

*最后更新: 2026-06-07*
