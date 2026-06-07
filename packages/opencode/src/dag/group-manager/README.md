<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
-->

# group-manager/ — Capability Reservoir

**Status**: Capability reservoir. Not wired to production.

`GroupManager` 实现类当前无生产调用方。生产路径使用扁平节点列表（`session-service`），不维护层级结构。

本模块被保留用于未来场景（Group 级并发、层级依赖管理）。详见 [`../../ARCHITECTURE.md` §2 与 §11](../ARCHITECTURE.md)。

**装配判定**:
- 类型（`IGroupManager`、`IDependencyGraph`、`GroupEvent`、`GroupConfig`）→ 可被引用 ✅
- 实例化（`new GroupManager(...)`）→ 禁止 ❌（除非经 archgate 审批）

---

*最后更新: 2026-06-07*
