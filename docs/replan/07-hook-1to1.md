# Hook 1:1 Claude Code 兼容实现

> 目标：协议级 1:1 兼容 Claude Code。完成后 CC 用户的 `.claude/settings.json` 中所有 hook 配置可在 OpenCode 上零改动直接生效。

## 范围

| 维度 | Step 1（已完成） | Step 2（本轮） |
|---|---|---|
| 事件 | PreToolUse / PostToolUse | + UserPromptSubmit / Stop / SubagentStop / PreCompact / SessionStart / SessionEnd（fork 不实现 CC 的 `Notification`，权限提示走内部 bus）|
| 类型 | `type: "command"` | + `type: "mcp"` |
| 加载链 | 单层 `<dir>/.opencode/settings.json` | 6 候选合并：`~/.claude/settings.json` → OpenCode global → `<proj>/.claude/settings.json` → `<proj>/.opencode/settings.json` → `<proj>/.claude/settings.local.json` → `<proj>/.opencode/settings.local.json` |
| stdin 信封 | `hook_event_name`/`tool_name`/`tool_input`/`cwd` | + `session_id` / `transcript_path` / 各事件特定字段全集 |
| stdout 控制 | `decision`/`continue`/`hookSpecificOutput.additionalContext` | + `stopReason`/`suppressOutput`/`systemMessage`/`permissionDecision`/`permissionDecisionReason`/`updatedInput` |
| Exit code | 0 放行 / 非 0 仅记日志 | + 严格区分 0 / 2(阻断+stderr→reason) / 其他(记日志不阻断) |

## stdin payload schema（按事件）

公共：`hook_event_name` / `session_id` / `transcript_path` / `cwd`

| 事件 | 特定字段 |
|---|---|
| `PreToolUse` | `tool_name`, `tool_input` |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_response` |
| `UserPromptSubmit` | `prompt` |
| `Stop` | `stop_hook_active` |
| `SubagentStop` | `stop_hook_active` |
| `Notification` | `message` _(removed in fork)_ |
| `PreCompact` | `trigger: "manual" \| "auto"`, `custom_instructions?` |
| `SessionStart` | `source: "startup" \| "resume" \| "clear" \| "compact"` |
| `SessionEnd` | `reason: "clear" \| "logout" \| "prompt_input_exit" \| "other"` |

## stdout 控制 JSON

```ts
{
  continue?: boolean
  stopReason?: string
  suppressOutput?: boolean
  systemMessage?: string
  decision?: "approve" | "block"
  reason?: string
  hookSpecificOutput?: {
    hookEventName?: string
    permissionDecision?: "allow" | "deny" | "ask"
    permissionDecisionReason?: string
    additionalContext?: string
    updatedInput?: Record<string, unknown>
  }
}
```

## type:"mcp" 实现

```jsonc
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Write",
      "hooks": [{ "type": "mcp", "command": "mcp__myserver__validate_write" }]
    }]
  }
}
```

- 解析 `command` → `mcp__<server>__<tool>`
- 通过 `MCP.Service.tools()` 查找对应 tool
- 用与 stdin JSON 相同的 payload 作为 `arguments` 调用 tool
- tool 返回的 content 第一段 JSON 作为响应解析（与 command type 同一处理逻辑）
- **再入保护**：trigger 内部置位 `inHook` 标志，type:mcp 调用 MCP tool 时不再触发 PreToolUse/PostToolUse 防递归

## 注入点

| 事件 | 文件 | 位置 |
|---|---|---|
| `PreToolUse`/`PostToolUse` | `session/prompt.ts` | ✅ Step 1 已完成（native + MCP 路径） |
| `UserPromptSubmit` | `session/prompt.ts` | chat 入口 |
| `Stop` | `session/prompt.ts` | runLoop 终止位置 |
| `SubagentStop` | `tool/task.ts` | task 子任务结束 |
| `Notification` | _removed in fork_ | 权限提示由 `Permission.Service` 通过内部 bus 上报，不外发为 hook 事件 |
| `PreCompact` | `session/compaction.ts` | compact() 入口 |
| `SessionStart` | `session/session.ts` | create / createNext / resume 路径 |
| `SessionEnd` | `session/session.ts` | finalizer / dispose |

## 实现拆分

- **Step 2a**：完整重写 `hook/settings.ts`（schema + loader + matcher + runner + Service），保留向后兼容的旧 trigger 签名
- **Step 2b**：更新 `prompt.ts` 改用新 trigger API + wire UserPromptSubmit/Stop
- **Step 2c**：wire 剩余 5 个事件到对应文件
- **Step 2d**：实现 `type: "mcp"` hook 解析与执行

## 阶段 5 协议补强（已实施）

针对 stdin/stdout 协议的 4 项 P0/P1 兑现：

- **stdin SessionStart `additional_context`**：fork 之前 silent drop；阶段 5 起经 `HookStartContext` 暂存，首轮 user message 注入 `<hook_additional_context>...</hook_additional_context>` 块（与 UserPromptSubmit 同款封装）。
- **stdout `{continue: false}`**：阶段 5 起在 `trigger` 主循环双层 break；4 个调用点（PreToolUse/PostToolUse/UserPromptSubmit/PreCompact）消费 `result.preventContinuation` early return。
- **stdout `suppressOutput`**：fork 默认不渲染 hook stdout 到 UI，schema 接受字段以保兼容，运行时 no-op（已在 `settings.ts` 注释固化）。
- **Session-scoped hooks（fork 扩展，非 CC 协议）**：新增 `SessionHooks` Service 支持运行时 `add/remove/list/clear`；`once:true` 自动清理；`ctx.isSubAgent === true` 时 `Stop` 事件查找翻译为 `SubagentStop`，保持上层 dispatcher 语义不变。

未实装：frontmatter parser（agent prompt 内联 hook 配置），独立 WP。

## 阶段 6 鲁棒性补强（已实施）

P1 鲁棒性收口，针对热路径性能、未来 trust 系统接入、plugin 目录 GC 竞态三项：

- **性能**：`trigger` 入口新增 O(1) 短路 — 当 settings 链与 SessionHooks 都没有当前事件的条目时，跳过 envelope 构建 / matcher 拼接 / regex 匹配热路径，直接返回空 `TriggerResult`。`SessionHooks` 同步新增 `hasForEvent(sessionID, event)` 探测 API。
- **trust**：`Settings` schema 新增 `allowUntrusted?: boolean` 字段以兼容未来配置；运行时**暂未接入** — fork 当前无 workspace-trust 基础设施（不存在 `Project.isTrusted` 等），trigger 短路之后留 TODO 注释块锁定接入点 + 契约（trust gate 失败必须 silent allow，禁止 throw/deny）。
- **plugin GC 竞态**：command handler 的 `execShell` 在 `child_process.spawn` 之前对 `entry.__sourceDir` 做 `existsSync` 预检；目录已被 GC（plugin 卸载、repo 清理等）时返回 `exitCode: 0` + 空 stdout 走 silent allow，而非让 shell 把 `python3 <missing>.py` 转成 exit 2 误判为 block。仅 command 类型受影响（agent/mcp/http/prompt 不依赖 plugin 物理目录）。
