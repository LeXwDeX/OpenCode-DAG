# 任务计划：为 opencode 实现 /goal 持久化目标命令

> 职责边界（先读）：
> - 本文件 `- [ ]` 是阶段级 milestone（粗粒度，跨多次工具调用）
> - 分步动作清单（每条 = 一次工具调用 / 一次 sub-agent 调度）走 opencode TodoWrite，不写在这里
> - 一个 milestone 可对应多条 TodoWrite 动作；TodoWrite 全 completed 后才能勾掉 milestone checkbox
> - 单向同步：TodoWrite 是源，milestone 是汇总

## 目标（Goal）

在 `packages/opencode/src/goal/` 下实现独立的 `/goal` + `/subgoal` 命令模块，复刻 hermes-agent Ralph-loop 模式：跨轮持久目标 + 自动续跑 + 评判模型 + 预算保险丝。模块尽量自包含，对既有代码的改动最小化。

## 成功标准（Success Criteria）

- [ ] SC-1：`src/goal/` 目录含 state.ts / goal.sql.ts / prompts.ts / judge.ts / events.ts / goal.ts 六个模块，各自 self-reexport
- [ ] SC-2：`bun typecheck`（在 packages/opencode 下）零错误通过
- [ ] SC-3：GoalState Schema 可序列化/反序列化；缺少 subgoals 字段的旧 payload 默认 []
- [ ] SC-4：Judge 解析覆盖：正常 JSON / markdown 围栏 / 非 JSON / 空 → 全部 fail-open
- [ ] SC-5：GoalManager 状态机覆盖：set/pause/resume/clear/mark_done + subgoal CRUD
- [ ] SC-6：/goal 和 /subgoal 在 Command.Service 中注册为内建命令
- [ ] SC-7：七条不变量（I1-I7）在代码层面全部映射（见设计文档 §4）

## 当前阶段
阶段 1（理解现有代码模式 → 快速进入实施）

---

## 各阶段

### 阶段 1：理解既有代码模式
- [ ] milestone：摸清 Effect Service / Schema.Class / Bus event / Command 注册 / Session status 的模式
- [ ] milestone：关键发现落盘 findings.md
- 状态：in_progress

### 阶段 2：确认方案
- [ ] milestone：WP 顺序 + 具体实施方案写入决策段
- 状态：pending

### 阶段 3：实现 + 验证循环（WP-1 到 WP-6）
- [ ] milestone：WP-1 GoalState + goal.sql.ts 完成
- [ ] milestone：WP-2 Auxiliary 服务完成（注：可能简化为直接用 Provider）
- [ ] milestone：WP-3 Judge + prompts 完成
- [ ] milestone：WP-4 GoalManager + events 完成
- [ ] milestone：WP-5 session.idle hook 完成
- [ ] milestone：WP-6 Command 注册完成
- [ ] milestone：bun typecheck 零错误
- 状态：pending

### 阶段 4：装配交付
- [ ] milestone：全量 typecheck 通过
- [ ] milestone：mempalace 写入决策摘要
- 状态：pending

---

## 关键问题
1. session.idle 事件是否在 abort 路径也触发？→ 需验证
2. Auxiliary 是否需要独立服务层？→ 待决策（R2）
3. prompt cache 是否被 continuation 影响？→ 低风险，I1 保证

## 已做决策

| ID | 时间 | 决策 | 理由 | 影响范围 | 触发回流时回到此处审视 |
|----|------|------|------|---------|------|
| D-001 | 2026-05-15 | 独立模块优先：src/goal/ 自包含，对现有文件改动 ≤3 处 | 用户明确要求"独立模块" | 全局 | 若发现必须大改现有代码则回审 |
| D-002 | 2026-05-15 | 立刻修复 BLOCKER：SessionPrompt.command 入口拦截 goal/subgoal → Goal.dispatch | 审计 A 发现命令通路实际未连通；用户决策"立刻委派 @implement" | session/prompt.ts | 若 implement 报告需要更大改动则回审 |
| D-003 | 2026-05-15 | dispatch 的 type:"message" 走"info part 注入当前会话"通道 | 用户决策；最贴近 TUI 用户感知；无需 SDK 类型再生 | session/message-v2.ts 可能需新增 part 变体；TUI 渲染 | 若 implement 发现需要新增 Schema 部件且影响 SDK ABI 则回审 |
| D-004 | 2026-05-15 | Tier-4 全修：B1+B2+A1+A2 代码修复 + P2 文档化 + B3 补 7 个测试 | 用户拍板；I5/I6/I7 不变量必须闭合；公告投喂 LLM 是真 BUG；测试矩阵设计 §13 强制要求 | session/status.ts schema 扩展 + SDK 再生；session/prompt.ts 拦截层；goal/* 全模块；test/goal/* 新增 | 若 SessionStatus schema 改动牵连面过大则回审拆分 |

## 错误台账（三次失败协议）

| ID | 错误摘要 | 第几次 | 尝试方案 | 解决/状态 | 关联审计行 | 关联决策 |
|----|------|---------|---------|---------|---------|---------|
| E-001 | 任务C 审计 FAIL：3 BLOCKER (B1 I6 abort→pause 未实现 / B2 kick.text 错把公告投喂 LLM / B3 test/goal/** 7 文件全缺) + 3 P1 (A1 I7 fiber 不取消 / A2 I5 busy 不检查 / A3 文案错置) + 4 P2 (continuation 模板扩写、subgoal add 别名、clear 别名、resume 重置 parse_failures) | 1 | 待用户决策修复范围 | OPEN | 2026-05-15T02:00 verify 行 | 待 D-004 |

## 备注
- 设计文档：`.plans/goal-command-design.md`（600 行，17 节）
- WP-7（TUI 徽标）和 WP-8（文档）本次不实施，聚焦核心功能模块
- 阶段状态流转：pending → in_progress → complete
