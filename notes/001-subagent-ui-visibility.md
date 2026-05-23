# 001 - 子 Agent 运行时 UI 可见性缺失

**日期**: 2026-05-24  
**分类**: UX / 子 Agent  
**严重程度**: 中（影响用户信任，非功能性 bug）

## 现象

主 agent 调度子 agent（如 `@explore`）后，TUI 显示 session 为 idle 状态，用户可以正常输入新消息。用户感知为"agent 停止工作了"，但实际上子 agent 在后台运行。

## 日志证据

**Session**: `ses_1aa2bf859ffe4mSQewgY9SVLIY`（主）→ `ses_1aa0594feffeOMVM2XT2EX2Reo`（explore 子 agent）

```
17:54:48  主 session → step=3 → exiting loop → session.idle  ← UI 显示空闲
17:55:35  子 agent 创建 (agent=explore)
17:55:37  子 agent step=0 → step=1 → ... → step=12           ← 12 步，持续工作
17:57:51  子 agent step=12 → exiting loop                     ← 子 agent 完成
17:57:59  主 session 恢复
```

子 agent 实际运行了 **2 分 16 秒**，执行了 **12 个 step**（每步都有工具调用），但 TUI 无任何指示。

## 根因

OpenCode 的 `task` 工具调度子 agent 后，主 session 的 run loop 退出（`exiting loop`），session 状态变为 `idle`。TUI 没有区分"真正空闲"和"等待子 agent 返回"两种状态。

## 影响

- 用户误以为 agent 停止工作
- 用户可能在子 agent 运行期间输入新消息，导致上下文混乱
- 降低用户对 agent 系统的信任

## 建议修复方向

1. TUI 在子 agent 运行期间显示状态指示器（如 spinner + "子 agent 运行中..."）
2. 子 agent 运行期间禁用或提示用户"当前有子任务在执行"
3. 在 session 状态中区分 `idle` 和 `waiting_for_subagent`

## 相关文件

- `packages/opencode/src/session/prompt.ts` — run loop，`exiting loop` 逻辑
- `packages/opencode/src/cli/cmd/tui/` — TUI 渲染层
- `packages/opencode/src/session/subagent.ts` — 子 agent 调度
