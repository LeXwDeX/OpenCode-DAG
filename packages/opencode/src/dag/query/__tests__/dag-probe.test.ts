// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * @file DAG Probe Tests — RESERVED INTERFACE contract (D-PROBE-RESERVE)
 * @description 验证预留诊断探针骨架的契约：可实例化、占位 throw 正确、类型可 import。
 *   本任务是接口骨架奠基，测试针对「契约可编译 + 占位行为正确 + 防孤儿锚定」，
 *   非业务逻辑测试（实现刻意推迟，见 task_plan WP-4）。
 *
 * Acceptance:
 * - [x] DAGProbe 可实例化（mock sessionService）
 * - [x] 4 方法各自 reject 且错误信息含 'reserved' 与 'D-PROBE-RESERVE'
 * - [x] IDAGProbe 等类型可被 import（type-level，编译通过即证明）
 */

import { describe, test, expect } from "bun:test"
import { DAGProbe } from "../dag-probe"
import type {
  IDAGProbe,
  NodeBlockReason,
  TopologyLayer,
  TopologySnapshot,
  ExecutionSnapshot,
  CascadeImpact,
} from "../probe-types"
import type { IDAGSessionService } from "../../session/session-service"

// type-level 锚定：若任一类型导出缺失，本文件无法编译，测试套件即失败。
type _ProbeContract = IDAGProbe
type _Reason = NodeBlockReason
type _Layer = TopologyLayer
type _Topology = TopologySnapshot
type _Exec = ExecutionSnapshot
type _Cascade = CascadeImpact

describe("DAGProbe — RESERVED INTERFACE skeleton (D-PROBE-RESERVE)", () => {
  test("可实例化（构造注入 sessionService）", () => {
    const probe = new DAGProbe({} as IDAGSessionService)
    expect(probe).toBeInstanceOf(DAGProbe)
  })

  test("explainBlock 占位 reject，错误含 reserved + D-PROBE-RESERVE", async () => {
    const probe = new DAGProbe({} as IDAGSessionService)
    await expect(probe.explainBlock("wf-1")).rejects.toThrow(/reserved/)
    await expect(probe.explainBlock("wf-1")).rejects.toThrow(/D-PROBE-RESERVE/)
  })

  test("getTopology 占位 reject，错误含 reserved + D-PROBE-RESERVE", async () => {
    const probe = new DAGProbe({} as IDAGSessionService)
    await expect(probe.getTopology("wf-1")).rejects.toThrow(/reserved/)
    await expect(probe.getTopology("wf-1")).rejects.toThrow(/D-PROBE-RESERVE/)
  })

  test("getExecutionSnapshot 占位 reject，错误含 reserved + D-PROBE-RESERVE", async () => {
    const probe = new DAGProbe({} as IDAGSessionService)
    await expect(probe.getExecutionSnapshot("wf-1")).rejects.toThrow(/reserved/)
    await expect(probe.getExecutionSnapshot("wf-1")).rejects.toThrow(/D-PROBE-RESERVE/)
  })

  test("predictCascade 占位 reject，错误含 reserved + D-PROBE-RESERVE", async () => {
    const probe = new DAGProbe({} as IDAGSessionService)
    await expect(probe.predictCascade("wf-1", "node-1")).rejects.toThrow(/reserved/)
    await expect(probe.predictCascade("wf-1", "node-1")).rejects.toThrow(/D-PROBE-RESERVE/)
  })
})
