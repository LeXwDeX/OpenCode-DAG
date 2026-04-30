# Hook 1:1 Claude Code 兼容实现

> 目标：协议级 1:1 兼容 Claude Code。完成后 CC 用户的 `.claude/settings.json` 中所有 hook 配置可在 OpenCode 上零改动直接生效。

## 范围

| 维度 | Step 1（已完成） | Step 2（本轮） |
|---|---|---|
| 事件 | PreToolUse / PostToolUse | + UserPromptSubmit / Stop / SubagentStop / Notification / PreCompact / SessionStart / SessionEnd |
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
| `Notification` | `message` |
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
| `Notification` | `permission` 或 `question` 通道 | 等待用户输入时 |
| `PreCompact` | `session/compaction.ts` | compact() 入口 |
| `SessionStart` | `session/session.ts` | create / createNext / resume 路径 |
| `SessionEnd` | `session/session.ts` | finalizer / dispose |

## 实现拆分

- **Step 2a**：完整重写 `hook/settings.ts`（schema + loader + matcher + runner + Service），保留向后兼容的旧 trigger 签名
- **Step 2b**：更新 `prompt.ts` 改用新 trigger API + wire UserPromptSubmit/Stop
- **Step 2c**：wire 剩余 5 个事件到对应文件
- **Step 2d**：实现 `type: "mcp"` hook 解析与执行
