// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * DAG Internal Diagnostic Probe — RESERVED INTERFACE (D-PROBE-RESERVE, 2026-06-10)
 *
 * 有意预留的诊断探针骨架，不是死代码，禁止当作 "unused" 删除。
 * 接口定义见 ./probe-types.ts；实现刻意推迟（见 task_plan WP-4）。
 * 刻意不暴露给 AGENT：不进 dagworker action 枚举、HTTP 路由、MCP 工具清单、layer 装配。
 */

import type { IDAGSessionService } from '../session/session-service'
import type { IDAGProbe, NodeBlockReason, TopologySnapshot, ExecutionSnapshot, CascadeImpact } from './probe-types'
// 未来实现将复用 execution-core A 层纯函数（零 Effect/DB）：
//   areDependenciesSatisfied / getReadyNodes / detectCycle / findPendingDescendants / computeSpawnBudget
//   注意 detectCycle 接收 DAGNodeConfig[]（非 DAGNodeSession[]）——getTopology 实现时需先转换。

export class DAGProbe implements IDAGProbe {
  constructor(private sessionService: IDAGSessionService) {}

  async explainBlock(workflowId: string): Promise<NodeBlockReason[]> {
    throw new Error('IDAGProbe.explainBlock: reserved interface — not yet implemented (D-PROBE-RESERVE)')
  }

  async getTopology(workflowId: string): Promise<TopologySnapshot> {
    // 注意：未来实现复用 execution-core.detectCycle 时，其入参为 DAGNodeConfig[]（非 DAGNodeSession[]），需先转换。
    throw new Error('IDAGProbe.getTopology: reserved interface — not yet implemented (D-PROBE-RESERVE)')
  }

  async getExecutionSnapshot(workflowId: string): Promise<ExecutionSnapshot> {
    throw new Error('IDAGProbe.getExecutionSnapshot: reserved interface — not yet implemented (D-PROBE-RESERVE)')
  }

  async predictCascade(workflowId: string, nodeId: string): Promise<CascadeImpact> {
    throw new Error('IDAGProbe.predictCascade: reserved interface — not yet implemented (D-PROBE-RESERVE)')
  }
}
