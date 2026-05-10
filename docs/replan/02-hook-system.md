# Claude Code 兼容 Hook 系统设计

> 目标：在 OpenCode 内置 Hook 机制，使外部工具/脚本把 OpenCode 当 Claude Code 来 Hook，**协议级零改动兼容**。

## 1. 设计依据

参考 Claude Code Hook 协议（截至 2026-04 已知形态）：
- 配置位置：`~/.claude/settings.json`、`<project>/.claude/settings.json`、`<project>/.claude/settings.local.json`
- 配置 schema：`hooks: { <EventName>: [{ matcher?: string, hooks: [{ type: "command", command: string, timeout?: number }] }] }`
- 调用约定：spawn 子进程，stdin 收 JSON，stdout 可选 JSON 控制，exit code 决定阻断/放行；
- 事件名（fork 实现 8 个，去掉 CC 的 `Notification` —— 权限提示走内部 bus）：`PreToolUse`、`PostToolUse`、`UserPromptSubmit`、`Stop`、`SubagentStop`、`PreCompact`、`SessionStart`、`SessionEnd`。

## 2. 与现有 OpenCode plugin hook 的关系

| 维度 | 上游 plugin Hook | 本设计 CC Hook |
|---|---|---|
| 形态 | TS 模块函数 `(input, output) => Promise<void>` | 外部进程，stdin/stdout JSON |
| 注册 | `~/.config/opencode/plugin/*.ts` 或 `experimental.plugin` | `settings.json hooks` 字段 |
| 兼容对象 | OpenCode 自有插件作者 | Claude Code 用户 / 跨工具脚本 |
| 调用时机 | 由 `Plugin.trigger()` 在代码内显式触发 | 由本设计的 `HookRunner` 在生命周期固定点触发 |

**两者并存、互不替代**。本设计**不修改** plugin Hook 任何接口。

## 3. 模块布局

```
packages/opencode/src/hook/
  index.ts            # HookService 入口（Effect 服务，AppRuntime 注册）
  schema.ts           # HookConfig + Event payload schemas（Zod / Effect Schema）
  loader.ts           # 三层 settings 合并加载（user/project/local）
  matcher.ts          # matcher 字段的 glob/regex 匹配
  runner.ts           # spawn 子进程 + stdin JSON + 解析 exit code/stdout
  events/             # 每个事件一个 trigger 函数（类型严格）
    pre-tool-use.ts
    post-tool-use.ts
    user-prompt-submit.ts
    stop.ts
    subagent-stop.ts
    notification.ts
    pre-compact.ts
    session-start.ts
    session-end.ts
```

## 4. 配置加载链

合并优先级（后者覆盖前者的同 event 同 matcher）：
1. `~/.claude/settings.json`（兼容路径，与 CC 共用）
2. `~/.config/opencode/settings.json`（OpenCode 私有，可选）
3. `<project>/.claude/settings.json`
4. `<project>/.opencode/settings.json`（OpenCode 私有，可选）
5. `<project>/.claude/settings.local.json`
6. `<project>/.opencode/settings.local.json`（OpenCode 私有，可选）

**兼容策略**：CC 用户直接复用 `.claude/settings.json` 即可；OpenCode 增量配置写在 `.opencode/settings.json`，避免污染 CC 配置。

```jsonc
// 示例：.claude/settings.json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "/usr/local/bin/audit-bash.sh", "timeout": 5 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "echo prompt logged" }] }
    ]
  }
}
```

## 5. 事件 payload 与 stdin/stdout 协议

### 5.1 stdin 输入（统一信封）
所有事件 stdin 接收以下信封 JSON：
```ts
{
  hook_event_name: string,    // 与事件名一致
  session_id: string,         // OpenCode session ID
  transcript_path: string,    // 当前 session 的 transcript jsonl 路径（兼容 CC）
  cwd: string,
  // 事件特定字段（详见各事件）
}
```

### 5.2 各事件特定字段（与 CC 对齐）

| 事件 | 特定字段 | 说明 |
|---|---|---|
| `PreToolUse` | `tool_name`, `tool_input` | 可阻断；exit 2 → block + reason 写 stderr |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_response` | 仅观察；exit 2 → 提示信息回填 |
| `UserPromptSubmit` | `prompt` | 可阻断；可通过 stdout JSON `{decision: "block", reason}` 阻止提交 |
| `Stop` | `stop_hook_active` | session 即将停止 |
| `SubagentStop` | `stop_hook_active` | 子 agent 完成 |
| `Notification` | `message` | _未实现 (removed in fork)_ — 权限提示通过内部 bus 暴露 |
| `PreCompact` | `trigger`, `custom_instructions?` | 上下文压缩前 |
| `SessionStart` | `source` | `startup` / `resume` / `clear` |
| `SessionEnd` | `reason` | `clear` / `logout` / `exit` |

### 5.3 stdout 控制 JSON（可选）
hook 进程可向 stdout 写一行 JSON：
```ts
{
  // 通用
  continue?: boolean,           // false → 停止后续 hook + 当前流程
  stopReason?: string,
  suppressOutput?: boolean,     // 不在 transcript 显示该 hook 输出
  systemMessage?: string,       // 注入一条 system message

  // PreToolUse 专用
  decision?: "approve" | "block",
  reason?: string,

  // hookSpecificOutput
  hookSpecificOutput?: {
    hookEventName: string,
    permissionDecision?: "allow" | "deny" | "ask",
    permissionDecisionReason?: string,
    additionalContext?: string,
  }
}
```

### 5.4 Exit code 语义（与 CC 一致）
- `0`：放行，stdout 视为信息或控制 JSON；
- `2`：阻断，stderr 内容作为 reason 反馈给 LLM 或用户；
- 其他非 0：错误，记日志，**不阻断**（避免 hook 故障杀死主流程，对应 fork-only fix `0f3017f33a`）。

## 6. 注入点（在 OpenCode 源码的位置）

| 事件 | 注入位置（packages/opencode/src/...） |
|---|---|
| `SessionStart` | `session/session.ts` 创建/恢复后 |
| `SessionEnd` | `session/session.ts` 显式 end / process exit |
| `UserPromptSubmit` | `session/prompt.ts` 进 runLoop 之前 |
| `PreToolUse` | `session/prompt.ts` 调用 tool 之前（permission 检查同位） |
| `PostToolUse` | `session/prompt.ts` 收到 tool result 之后 |
| `Notification` | _removed in fork_ — 不接入，由内部 permission bus 兜底 |
| `Stop` | runLoop 终止 |
| `SubagentStop` | task / scout agent 结束 |
| `PreCompact` | session compaction 前 |

## 7. 实现纪律

- **零侵入**：所有注入点用 `HookService.trigger(event, payload)`，触发器内部判断"无 hook 注册则零开销直接返回"；
- **EPIPE 防护**：runner 内部 catch EPIPE 与 spawn 失败（参考 `0f3017f33a`），不抛到主流程；
- **超时**：默认 60s，可在配置 `timeout` 字段覆盖（秒），超时 SIGTERM；
- **并发**：同一事件下多个 hook 默认串行执行（与 CC 一致），matcher 过滤后逐条跑；
- **环境**：spawn 子进程继承当前 env，额外注入 `CLAUDE_PROJECT_DIR`（cwd 别名）以兼容 CC 脚本对该变量的依赖。

## 8. 测试策略

- 单元：matcher 匹配、stdin payload 形态、exit code 解析、stdout JSON 解析；
- 集成：用一个 echo hook 脚本验证全部 9 个事件触发；
- 兼容性：用 Claude Code 官方文档示例脚本（带空格 / 含 jq 处理）原样跑通；
- 故障：hook 脚本崩溃 / 超时 / EPIPE → 主流程不受影响。

## 9. 不做的事

- ❌ 不实现 `type: "mcp"` hook（CC 在演进中，本期仅 `type: "command"`）；
- ❌ 不实现 hook 配置热重载（启动时加载一次，与 CC 行为一致）；
- ❌ 不内置 hook 脚本仓库（用户自带）；
- ❌ 不做 hook 的可视化配置 UI（CLI / 配置文件即可）。

## 10. 后续可选

- `--hook-debug` flag：打印每次 hook 调用的 stdin/stdout/exit code；
- `opencode hook list/test` 子命令：诊断当前 hook 配置加载情况。

## 11. 阶段 5 已实施（hook 协议补强 P0/P1）

| WP | 内容 | 落点 |
|---|---|---|
| WP-5A | `SessionStart` 返回的 `additionalContexts` 真注入到首轮 user message（之前 silent drop） | 新建 `src/hook/start-context.ts`（InstanceState 暂存）+ `share/session.ts` 改 `Effect.exit` append + `prompt.ts` 首轮 drain |
| WP-5B | stdout 控制 JSON `{continue: false}` 真短路：trigger 双层 break + 4 调用点（PreToolUse/PostToolUse/UserPromptSubmit/PreCompact）消费 `preventContinuation` early return | `settings.ts` trigger 主循环；`prompt.ts` / `compaction.ts` 调用点 |
| WP-5C | `suppressOutput` schema 兼容（接受字段，运行时 no-op，因 fork 默认不渲染 hook stdout） | `settings.ts` 6 行 docstring |
| WP-5D | Session-scoped hook 动态注入：`SessionHooks` Service（add/remove/list/clear）+ `once:true` 自动清理 + `ctx.isSubAgent` 时 `Stop→SubagentStop` 翻译 | 新建 `src/hook/session-hooks.ts`；`settings.ts` trigger 内合并 + Layer.provide |

剩余工作（独立 WP，未阻塞 fork.1）：
- frontmatter parser 对接（agent prompt 内联 hook 配置）
- `SessionHooks.clear` 在 `SessionEnd` / `Session.delete` 时调用以避免长会话泄漏

测试基线：阶段 5 净增 +9 测试（≥8 spec 门禁），全量 2361 PASS / 0 回归。
