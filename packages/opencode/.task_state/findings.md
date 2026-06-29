# DAG 模块架构审阅 Findings

> 来源: archgate 全模块集成审阅 + 回归审阅
> 日期: 2026-06-05
> 初始判定: **BLOCKING** → 回归判定: **PASS** ✅（全部 5 BLOCKING 已解决）

---

## 已解决的 BLOCKING 问题

### ✅ BLOCKING-1: session-service 绕过状态机直接写 SQLite → 已修复
- **铁律**: #1 状态机不可绕过, #2 终态不可逆, #3 事件必须广播
- **修复**: session-service 新增 `getValidNextSessionWorkflowStatuses()` / `getValidNextSessionNodeStatuses()` 验证函数，`updateWorkflowStatus` / `updateNodeStatus` 执行 读→验证→写→emit 四步
- **代码**: `session-service.ts:40-78`（验证函数），`L289-341`（workflow 四步），`L464-530`（node 四步）
- **测试**: `session-service.test.ts:634-693` 覆盖全部验证分支
- **回归**: archgate 确认 ✅ 合规

### ✅ BLOCKING-2: session-service 无终态保护 → 已修复
- **修复**: 验证函数终态（`completed`/`failed`/`cancelled`/`archived`）返回空数组，阻断任何逆转尝试
- **代码**: `session-service.ts:48-54, 71-77`
- **回归**: archgate 确认 ✅ 合规

### ✅ BLOCKING-3: session-service 零事件广播 → 已修复
- **修复**: 模块级 `setEventBus(bus?: IEventBus)` 注入，`buildSessionWorkflowEvent()` / `buildSessionNodeEvent()` 构建事件并 `eventBus.emit()`。无 eventBus 时 graceful degradation
- **代码**: `session-service.ts:26-34`（注入+build），L337-340 / L526-529（emit 调用）
- **回归**: archgate 确认 ✅ 合规（事件类型匹配 state-machine dot notation）

### ✅ BLOCKING-4: 事件系统双轨制 → 已修复
- **修复**: `dag-events.ts` 和 `events/` 目录已删除（0 import 死代码清理）。dot notation（`state-machine/types.ts`）为唯一事件命名规范
- **回归**: archgate grep "dag-events" / "colon" 返回 0 结果 ✅

### ✅ BLOCKING-5: RequiredNodesMonitor 订阅不存在事件 → 已修复
- **修复**:
  - 订阅改为 `node.skipped`（真实事件），字段改为 `event.node_name` / `event.workflow_id`
  - `failed_with_violations` 映射为 `failed`（状态值对齐 WorkflowStatus 枚举）
  - `checkAllRequiredNodesCompleted` 移除 completed→failed 终态逆转，改为仅记录 violation
  - `handleNodeSkipped` 修复 node_name/node_id 语义混淆（改用 `listNodes` + `config.name` 匹配）
- **级联修复**: DAGWorkflowStatus 类型移除 `failed_with_violations`，TUI dag-console renderer/sidebar 相关 case 同步清理
- **回归**: archgate 确认 ✅ 合规

### ✅ BLOCKING-6: API.md 状态转移表与代码不一致 → 已修复
- **修复**: API.md PENDING→CANCELLED 改为 ❌，匹配 `getValidNextWorkflowStatuses(PENDING)` 返回 `[RUNNING]`

---

## 非 BLOCKING 问题状态

### ✅ WARN-2: group-manager Branch 级状态变更无持久化 — **已修复**
- **修复**: `updateBranchStatus` 在 emit 之前调用 `statePersister.saveGroupState(groupId, group)`（与 `updateGroupStatus` 模式一致——持久化整棵 group 含 branches Map）
- **文件**: `GroupManager.ts:362-402`，新增 4 行持久化调用
- **验证**: 396 pass / 0 fail

### ✅ WARN-3: persistence/schema.ts 字段命名 — **已修复** (WARN-9 一并解决)
- dagWorkflows/dagNodes/dagViolations 用 snake_case ✅
- dagWorkflowHistory/dagNodeLogs/dagSchemaVersions 原为 camelCase，已修复为 snake_case ✅
- 3 表仅 schema.ts 内部使用（无外部消费者），重命名字段名无 breaking change

### ✅ WARN-4: DAGQuery 依赖具体类 — **已修复**
- **修复**: 重命名 `interface DAGSessionService` → `interface IDAGSessionService`，符合项目 `I` 前缀接口命名约定
- **级联更新**:
  - `session-service.ts`: interface 重命名 + 11 处内部类型标注 + `satisfies` 更新；`const` 出口（含 `make` 方法）保持原名
  - `required-nodes-monitor.ts` / `violation-query.ts`: type-only import 更新
  - `dag-query.ts`: type-only import 更新
  - value 消费者 (`workflow-engine.ts` / `tool/dagworker.ts`) 不受影响（仍使用 const 对象 `DAGSessionService.make`）
- **验证**: typecheck 通过 + 396 pass / 0 fail

### ✅ WARN-5: workflow-engine WorkflowStatus 命名冲突 — **已修复**
- 重命名 `interface WorkflowStatus` → `interface WorkflowStatusSnapshot`
- 同步更新 `workflow-executor.ts` 和 `tool/dagworker.ts` 的 import

### ✅ WARN-6: handleNodeFailure 错误的 violation type — **已修复**
- `workflow-engine.ts:156` 改为 `type: 'required_node_failed'`（语义正确的值）

### ✅ WARN-7: 事件构建器硬编码占位符 — **已修复**
- `buildSessionWorkflowEvent()` 新增 `durationMs`/`accumulatedDiff`/`reason`/`failedNodes` 可选参数
- `buildSessionNodeEvent()` 新增 `opts?` 对象（`worktreePath`/`outputSummary`/`diffStats`/`triggerReason`/`upstreamFailedNode`）
- `updateWorkflowStatus` 调用点传入 `durationMs = now - started_at`
- `updateNodeStatus` 调用点传入 `outputSummary: input.outputData`

### ✅ WARN-8: workflow-executor 无限循环风险 — **已修复**
- 新增 `maxRuntimeMs` 参数（默认 10 分钟），超时自动 `cancelWorkflow()`
- 循环条件新增 `cancelled` 状态检查（与 completed/failed 相同退出逻辑）

### ✅ WARN-9: schema.ts vs schema.sql 结构偏差 — **已修复**
- schema.ts 3 表字段名 camelCase → snake_case（对齐项目 Style Guide）
- schema.sql `dag_node` 表重新对齐至 schema.ts 列定义（ts 为运行时真相）
- 移除 schema.sql 中已不存在的字段：`chat_session_id`/`node_name`/`node_type`/`input_data`/`output_data`/`error_message`/`error_stack`

---

## 新增模块: NodeStateMachine（WP1 + WP2, 2026-06-05）

### 交付内容

**WP1 + WP2 合并提交**（commit `badba28a8` on stable 分支）:
- 新增 `NodeStateMachine` 类（11 个公共方法 + 本地 `INodeStatePersister` 扩展）
- 45 tests GREEN（按 4 条铁律 + 核心功能分组，含 5 个 Shadow 节点集成测试）
- 完整 Iron Law 执行: #1 transition 验证、#2 终态不可逆、#3 事件广播、#4 持久化优先 + rollback

**关键设计改进**:
- 提取 `persistAndApply()` 私有 helper 消除 72 行重复代码（6 处调用）
- 扩展 `NodeEvent` union 加入 `node.reset` variant（移除 as unknown as 桥接，§0.4 合规）
- `NodeTransitionParams` 增加 5 个 optional payload 字段扩展点（fallbackTrigger/retryCount/abortReason/upstreamFailedNode/worktreePath）
- 移除 `getSchedulableNodes()` 方法 + 接口签名（职责归 Scheduler，YAGNI 原则）

### 关键设计决策（spec v2 → 实施）

| # | 决策 | 理由 |
|---|------|------|
| D1 | FAILED 作为半终态（允许 →RUNNING/ABORTED） | 地基代码 `errors.ts:500-501` 锚定 |
| D2 | 本地 `INodeStatePersister` 扩展 | 全仓 grep 验证无其他模块需要节点级持久化，接口隔离 |
| D5 | skipNode() 严格 from-status 验证（仅 PENDING/QUEUED → SKIPPED） | Iron Law #1 强制执行 |
| D6 | 方案 C 扩展 NodeEvent union 加入 node.reset | admin bypass 仍应发事件（保留 #3/#4） |
| D7 | 不提升 writeNodeState/readNodeState 到公共接口 | 接口隔离原则 |
| D8 | 移除 getSchedulableNodes | 职责归 Scheduler（ARCHITECTURE.md §4），接口无调用方 |

### 验收数据

| 指标 | WP1 后 | WP2 后 |
|------|--------|--------|
| NodeStateMachine.test.ts | 40 pass | **45 pass** |
| state-machine 模块 | 104 pass | **109 pass** |
| 全量 DAG | 436 pass | **439 pass**（零回归） |
| typecheck | 0 errors | 0 errors |
| `as any` in source | 0 | **0** |
| archgate | PASS (spec v2) | PASS |
| review | PASS (P1 修订后) | PASS (0 阻塞，4 INFO) |

### 后续待观察（INFO 级，不阻塞）

1. `INodeStatePersister` 仍在实现文件内部 → 待后续 WP 评估提升（当前仅 NodeStateMachine 使用）
2. Shadow 集成测试未显式验证 PAUSED/ABORTED/SKIPPED 拒绝 → `getValidNextNodeStatuses(SHADOW)` 静态表已有隐含保证
3. `types.ts:257` 历史 `node.completed.output_summary: any` → 类型系统历史定义，不在本次范围
