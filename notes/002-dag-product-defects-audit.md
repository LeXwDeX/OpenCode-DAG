# 002 — DAG 工作流引擎产品缺陷审计

> 审计时间：2026-06-17
> 审计范围：`packages/opencode/src/dag/`（workflow-engine.ts / recovery.ts / workflow-executor.ts / limits.ts / types.ts / templates/index.ts）+ 工具层（dagworker.ts / node_complete.ts / registry.ts）
> 审计视角：产品缺陷（用户可感知），非纯代码质量
> 状态：P0/P1 已修复（8 项），P2 deferred（5 项）。详见下方各项处置标记 + `.task_state/dag_backlog.md`
> 修复批次：2026-06-17 完成 P0 + P1，typecheck 0 error，1234 测试无回归（23 fail 全为 WorktreeManager 环境超时）

---

## 处置总览

| 缺陷 | 层级 | 处置 | 批次 |
|---|---|---|---|
| B3 成功通知缺失 | 可用性 | ✅ DONE | P0 |
| B1 模板降级 | 可用性 | ✅ DONE | P0 |
| B2 工具无条件注入 | 可用性 | ✅ DONE（dagworker 过滤；node_complete 保留） | P0 |
| C1 retry 死字段 + 默认值 | 配置 | ✅ DONE | P1 |
| C2 failure_handler.agent 校验 | 配置 | ✅ DONE | P1 |
| C3 timeout_ms 值域 | 配置 | ✅ DONE | P1 |
| D1 condition 求值留痕 | 可观察性 | ✅ DONE | P1 |
| A2 executor busy-polling | 可靠性 | ✅ DONE（降频 50x，保留安全网） | P1 |
| B4 list 进程生命周期 | 可用性 | ✅ DONE（审计订正：实为文档缺陷） | P1 |
| A1 进程重启恢复 | 可靠性 | ⏸ DEFERRED（工程量大，需重设计 timeout 持久化） | P2 |
| A3 timeout TOCTOU | 可靠性 | ⏸ DEFERRED（需 Effect.Ref 重构） | P2 |
| D2 input_mapping 告警 | 可观察性 | ⏸ DEFERRED | P2 |
| E1 单进程并发模型 | 架构 | ⏸ DEFERRED（看产品定位） | P2 |
| E2 全局 LLM 并发闸 | 架构 | ⏸ DEFERRED（看产品定位） | P2 |

---

## 一、严重可靠性缺陷（影响产品可用性）

### A1. 进程重启 = 运行态工作流实质不可恢复 ⏸ DEFERRED (P2)

**严重度**：critical
**处置**：deferred — timeout fiber 持久化需重新设计（基于 DB deadline 而非 setTimeout），工程量大

**现象**：重启 opencode 后，运行中的 DAG 工作流要么被标记 failed（legacy 路径），要么"恢复"了但 timeout 失效、可能永久卡死。`failure_handler.max_recoveries` 计数被偷偷清零。

**根因证据**：
- `workflow-engine.ts:157-186` 维护 6 个 module-level 内存 registry（engineRegistry / spawnedNodes / concurrencyRegistry / recoveryGenerationRegistry / recoveryAttemptsRegistry / stepMode / nodeSettledRegistry）。SQLite 只存状态字段，没存这些运行时元数据。
- `recoveryAttemptsRegistry`（L186）注释自认：*"module-level (not persisted) — acceptable since diagnosis is best-effort"*。但重启后 `failure_handler.max_recoveries` 计数归零，配置的 `max_recoveries: 3` 失效，可能无限重试。
- timeout fiber（L643 `setTimeout`）是纯内存的。recovery 重建 engine 后，`resetRunningNodes`（recovery.ts:261）只重置无 child session 的 running 节点；被 `recovery_preserved` 保留的 running 节点（recovery.ts:270-285）timeout fiber 已死，可能永久卡 running。

**修复方向**：timeout fiber 持久化（基于 DB 时间戳的 deadline 检查，而非 setTimeout）；recoveryAttemptsRegistry 持久化到 workflow metadata；或至少保证"恢复后的 running 节点有 timeout 保护"。

---

### A2. WorkflowExecutor 的 busy-polling 反模式 ✅ DONE (P1)

**严重度**：high
**处置**：done — 轮询频率 100ms→5s（`SAFETY_POLL_INTERVAL_MS`），50x 降负。主调度事件驱动，轮询降级为安全网兜底。`workflow-executor.ts`

**现象**：100 节点工作流跑 30 分钟 ≈ 18000 次全表扫描 × 2；存在两套并发调度路径竞态。

**根因证据**：`workflow-executor.ts:81-112`
- `while(true)` 每 100ms 调 `scheduleReadyNodes` + `getWorkflowStatus`，二者内部都 `listNodes` 全表扫。
- `scheduleReadyNodes` 已在 `handleNodeCompletion`(L1420)/`handleNodeFailure`(L1912) 事件驱动调用。executor 轮询是第二套路径，靠 `spawnedNodes.has()`(L1359) idempotency guard 兜底，本质是用 Set 去重掩盖设计冗余。
- executor 轮询的 schedule 与 completion 事件的 schedule 可能在同 tick 都过 `replanInFlight.has()`(L1266) guard，重复 fork。

**修复方向**：去掉 while 循环，改成纯事件驱动（completion/failure/replan 触发 schedule）；workflow 级超时用单独的 deadline timer 而非轮询检测。

---

### A3. timeout 的闭包变量竞态（TOCTOU） ⏸ DEFERRED (P2)

**严重度**：medium
**处置**：deferred — 需用 Effect.Ref/Deferred 替代闭包变量重构 timeout 竞态

**现象**：timeout 回调与 node fiber 结束之间存在 TOCTOU 窗口，靠多层 guard 兜底。

**根因证据**：`workflow-engine.ts:421`
- `nodeSettledFlag` 是普通闭包变量，非 `Effect.Ref`。
- timeout 回调（L644-747）：`if (nodeSettledFlag) return`（检查点 A）→ `Effect.runPromise(...)` → 内部多步 yield → `handleNodeFailure`。检查点 A 与 handleNodeFailure 之间，fiber 可能恰好结束置 flag。
- `handleNodeFailure` 的幂等 guard（L1613 `wasAlreadyFailed`、L1618 `wasAlreadyCompleted`）只覆盖部分情况，是在用多层 guard 对抗本应用原子操作解决的问题。

**修复方向**：用 `Effect.Ref` 或 `Deferred` 替代闭包变量；timeout 回调与 fiber 结束竞争同一原子状态。

---

## 二、产品可用性缺陷（用户直接踩到）

### B1. 模板系统名存实亡——专用 agent 被强制降级为 general ✅ DONE (P0)

**严重度**：high（直接削弱模板产品价值）
**处置**：done — 删除 `SAFE_BUILTIN_AGENTS` 降级，`mkNode` 透传真实 worker_type；8 个模板 requiredAgents/description 同步修正。`templates/index.ts`

**现象**：10 个模板里 8 个声明用 archgate/implement/verify/review/patcher，实际全部被降级为 general，流水线语义完全丢失。`requiredAgents` 元数据与实际 `worker_type` 不一致。

**根因证据**：`templates/index.ts:75-93`
```ts
const SAFE_BUILTIN_AGENTS = new Set(["general", "explore"])
function mkNode(id, workerType, ...) {
  const resolved = SAFE_BUILTIN_AGENTS.has(workerType) ? workerType : "general"
  return { ..., worker_type: resolved, worker_config: { agent: resolved, prompt } }
}
```
- `architecture-design`(L127) 声称"archgate → implement"流水线，实际两节点都是 general。
- `tdd-implementation-and-coverage`(L189) 期望 implement→verify，实际 general→general→general。
- 模板降级初衷是"避免引用未注册 agent 导致启动失败"，但 `validateWorkerTypes`(core-start.ts:80) 已存在启动期 fail-fast 校验，无需在生成阶段阉割。

**修复方向**：删除 `SAFE_BUILTIN_AGENTS` 降级逻辑，`mkNode` 透传 workerType；启动期由 `validateWorkerTypes` 决定成败，未注册 agent 给出明确错误。

---

### B2. node_complete / dagworker 工具无条件注入所有 agent ✅ DONE (P0)

**严重度**：medium（上下文污染 + 误用风险）
**处置**：done — `dagworker` 按 agent.mode 过滤，subagent 不再注入（省 ~30 行描述 + 防误用）。`node_complete` 保留注入所有 agent（接口签名无 sessionID 无法精确判断 DAG 子会话；误调时引擎安全 no-op）。`tool/registry.ts`

**现象**：所有 agent 的 system prompt 都背负 ~30 行 DAG 工具描述；普通对话中 LLM 可见 `node_complete` 并可能误调。

**根因证据**：`tool/registry.ts:258、286`
- `node_complete` 和 `dagworker` 在 `builtin` 数组无条件返回。
- `node_complete.ts:34-38` 靠 `WorkflowEngine.get(workflowId)` 判空兜底错误，但这本身就是"工具不该出现在这里"的症状。

**修复方向**：按 agent 上下文条件注入——DAG 子会话（parentID 且父是 DAG workflow）才注入 `node_complete`；main/规划类 agent 才注入 `dagworker`。

---

### B3. 工作流成功完成没有任何通知通道 ✅ DONE (P0)

**严重度**：high（体验不对称）
**处置**：done — `maybeFinalizeWorkflow` 新增 completed 分支 + `notifyParentOfCompletion`，对称复用失败通知的 wake 策略。`workflow-engine.ts`

**现象**：失败有 synthetic message 通知，成功要用户自己轮询。

**根因证据**：`workflow-engine.ts:1544` `notifyParentOfFailure` 只在 workflow 收敛到 `failed` 时注入。`maybeFinalizeWorkflow`(L1227) 的 `targetStatus === "failed"` 分支才通知；`completed` 分支无任何通知。`dagworker.txt:10` 说"execution runs in background"但未说完成后如何通知。

**修复方向**：maybeFinalizeWorkflow 增加 completed 分支，注入 `<dag_workflow_completed>` synthetic message；对称复用 notifyParentOfFailure 的 wake 策略。

---

### B4. list 只返回当前进程的工作流（审计订正）

**严重度**：~~medium~~ → 订正为文档缺陷（非功能缺陷）

**订正（2026-06-17 代码核查）**：审计报告原述"list 走 engineRegistry、只返回当前进程工作流"**有误**。`dagworker.ts:503` 的 list action 实际调用 `dagSessionService.listAllWorkflows()`（session-service.ts:814-837），直接 `SELECT * FROM dagWorkflows` 查全部 SQLite，含历史工作流。

**真实问题**：`dagworker.txt:15` 工具描述写 "in the lifetime of **this process**"，与实现（查全部 DB）不符。这是文档与实现不一致，误导了审计本身。

**修复**：已修正 `dagworker.txt` 和 `session/prompt/dag.txt` 的描述为 "all workflows persisted in the database"。

**原（错误）描述保留供审计完整性参考**：
> ~用户重启 opencode 后，之前的 DAG 工作流（即使持久化在 SQLite）从 list 里消失。~（实际不会消失）
> ~status/node_detail 仍然可以按 ID 查询（走 DB），但 list 的"进程生命周期"语义对用户是反直觉的。~（list 本就走 DB）

---

## 三、配置与校验缺陷

### C1. retry.delay_ms 是死字段，retry 默认值入口不一致 ✅ DONE (P1)

**严重度**：medium
**处置**：done — retry 循环重试前 `Effect.sleep(delay_ms)`（缺省 0 向后兼容）；createNode 默认 max_retries 统一为 0（原 session-service 默认 3 与 core-start 0 不一致）。`workflow-engine.ts` + `session-service.ts`

**现象**：`delay_ms` 配置了不生效；不同入口默认重试次数不同（0 vs 3）。

**根因证据**：
- `types.ts:215-216` 声明 `retry: { max_attempts, delay_ms }`，全代码库 `delay_ms` **无任何使用点**（只有类型声明）。workflow-engine.ts:951 重试循环立即重试，无 delay。
- 默认值不一致：
  - `core-start.ts:282`：`cfg.retry?.max_attempts ?? 0`（默认 0 次）
  - `session-service.ts:551、573`：`input.maxRetries ?? 3`（默认 3 次）

**修复方向**：实现 delay_ms（retry 循环加 `Effect.sleep(delay_ms)`）；统一默认值为 0（与 core-start 一致，显式优于隐式）；或从类型删除 delay_ms。

---

### C2. failure_handler.agent 不校验是否注册 ✅ DONE (P1)

**严重度**：medium
**处置**：done — `bootstrapWorkflowFromConfig` Step 2.5 启动期 registry 校验，与 worker_type 同级 fail-fast。`core-start.ts`

**现象**：配置错误启动时不报错，运行时才暴露，workflow 已被 pause。

**根因证据**：`limits.ts:306-308` `validateFailureHandler` 只校验 agent 是非空字符串，不校验 agent registry。对比 `worker_type` 有 `validateWorkerTypes`(core-start.ts:80) fail-fast，策略不一致。运行时 `handleNodeFailure`(workflow-engine.ts:1728) 才发现 agent 缺失，此时 workflow 已 paused(L1721)，fallback cascade。

**修复方向**：`bootstrapWorkflowFromConfig` 启动期对 `config.failure_handler.agent` 做与 worker_type 同级的 registry 校验。

---

### C3. timeout_ms 值域未校验 ✅ DONE (P1)

**严重度**：low
**处置**：done — normalize 新增 `validateTimeoutMs`，拒绝 0/负数/非整数/NaN；覆盖工作流级、节点级、normalizeDagNode（replan 路径）。`normalize.ts`

**现象**：`timeout_ms: 0` → setTimeout(fn,0) 立即超时；`timeout_ms: -1` → 行为未定义。

**根因证据**：`limits.ts` 有 `validateTimeoutPolicy`（校验字符串），但 timeout_ms 数值无校验函数。`normalize.ts` 只校验 max_concurrency，不碰 timeout_ms。

**修复方向**：normalize 或 limits 增加 timeout_ms 正整数校验。

---

## 四、可观察性缺陷

### D1. condition 求值过程不留痕 ✅ DONE (P1)

**严重度**：medium
**处置**：done — condition-skip violation details 补充 `ref_node_id`、`ref_node_output`（截断 500 字符）、`declared_value`、`evaluated_result` + `truncateForAudit` helper。`workflow-engine.ts`

**现象**：排查"节点为何 skipped"只能看到配置，看不到运行时实际值。

**根因证据**：`workflow-engine.ts:1296-1338` condition=false 时 violation `details` 只存 `skipNode.config.condition`（配置），不存 ref_node 实际 output 值与比较结果。

**修复方向**：condition 求值时把 ref_node output 快照、比较结果写入 violation.details 或 node_log。

---

### D2. input_mapping 注入失败静默吞掉 ⏸ DEFERRED (P2)

**严重度**：medium
**处置**：deferred

**现象**：上游 output 格式漂移导致 ref_path 解析失败，下游照常执行但缺关键输入，无告警。

**根因证据**：prompt-inject 设计"missing/null/path-not-found → audit as skipped; node not auto-failed, just injected without that key"。audit 只在 node_log，不上升到用户/parent session。

**修复方向**：input_mapping 注入失败时，向 parent session 或节点 prompt 注入显式告警块（类似 timeout notify 的 `<dag_input_missing>`）。

---

## 五、架构层面的产品风险（中长期）

### E1. 单进程并发模型，无法水平扩展 ⏸ DEFERRED (P2)

**严重度**：架构债（看产品定位）
**处置**：deferred — 看产品定位决定是否投入

**证据**：`workflow-engine.ts:142-155` 注释明确不可移植到多线程。DAG 不能跨进程/跨机器执行，100 节点大工作流的 LLM 吞吐是单进程硬瓶颈。

---

### E2. max_concurrency 是 DAG 内计数，无全局 LLM 并发闸 ⏸ DEFERRED (P2)

**严重度**：架构债
**处置**：deferred — 看产品定位决定是否投入

**证据**：`computeSpawnBudget` 统计单 DAG 内 spawnedNodes。3 个 `max_concurrency:10` 的 DAG 并行 = 30 个并发 LLM 请求，打爆 provider rate limit。引擎层无全局并发闸。

---

## 修复优先级建议

| 序号 | 缺陷 | 改动量 | 用户价值 | 建议批次 |
|---|---|---|---|---|
| B3 | 成功通知缺失 | 小 | 高 | P0 |
| B1 | 模板降级 | 小 | 高 | P0 |
| B2 | 工具无条件注入 | 中 | 中 | P0 |
| C1 | retry 不一致 + delay_ms 死字段 | 小 | 中 | P1 |
| A2 | executor busy-polling | 中 | 中（性能+竞态） | P1 |
| C2 | failure_handler.agent 校验 | 小 | 中 | P1 |
| D1 | condition 求值留痕 | 小 | 中 | P1 |
| A1 | 进程重启恢复 | 大 | 高（但工程量大） | P2 |
| B4 | list 走 DB | 小 | 中 | P1（随 A1） |
| A3 | timeout TOCTOU | 中 | 低 | P2 |
| C3 | timeout_ms 值域校验 | 极小 | 低 | P1 |
| D2 | input_mapping 告警 | 小 | 低 | P2 |
| E1/E2 | 架构债 | — | — | 看产品定位 |

---

*审计人：coding agent（2026-06-17）。证据均来自代码行号，可在仓库定位。*
*台账闭环（2026-06-17）：P0/P1 共 8 项修复完成并补测试（新增 22 断言），typecheck 0 error，无回归。P2 5 项 deferred，择期处理。修复明细见 `.task_state/dag_backlog.md`。*
