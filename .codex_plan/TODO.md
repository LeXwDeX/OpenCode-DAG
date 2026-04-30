# TODO：基于 upstream v1.14.30 重新规划 fork 模块

## 阶段 0 · 文档落地（当前阶段）
- [x] 调研当前基线（reset/upstream-1.14.30）与已保存的 reference 素材
- [x] 调研历史 fork-only fix 提交清单
- [x] 编写 docs/replan/00-overview.md
- [x] 编写 docs/replan/01-bug-inventory.md
- [x] 编写 docs/replan/02-hook-system.md
- [x] 编写 docs/replan/03-copilot-proxy.md
- [x] 编写 docs/replan/04-tui-quota-status.md
- [x] 编写 docs/replan/05-execution-order.md
- [x] 提交规划文档

## 阶段 1 · 上游基线确认（用户确认后启动）
- [ ] 把 `reset/upstream-1.14.30` 合并/重置进 dev（或新建 `replan/v1.14.30` 工作分支）
- [ ] 跑 `bun typecheck` + `bun test`，记录上游裸跑的失败清单
- [ ] 把上游裸跑失败 vs fork-only fix 清单对照，确定哪些需重打补丁

## 阶段 2 · BUG 回归（按 01-bug-inventory.md 优先级）
- [ ] P0 启动相关：cli lazyCmd $0、auth 路由冲突、storage migration marker
- [ ] P0 协议链路：thinking signature 链、orphan tool_use 修复、MCP 超时
- [ ] P1 稳定性：Hook EPIPE 屏蔽、TUI 粘贴 v2、tsgo typecheck

## 阶段 3 · Hook 系统（按 02-hook-system.md）
- [ ] HookConfig schema + 加载链（user/project/local 三层）
- [ ] HookRunner（stdin JSON、exit code 0/2/其他、stdout JSON 控制）
- [ ] 注入点：PreToolUse/PostToolUse/UserPromptSubmit/Stop/SubagentStop/Notification/PreCompact/SessionStart/SessionEnd
- [ ] 兼容层：读取 `~/.claude/settings.json`、`.claude/settings.json`、`.claude/settings.local.json`
- [ ] 单元测试 + 与 ClaudeCode hook 脚本互跑验证

## 阶段 4 · Copilot Proxy 集成（按 03-copilot-proxy.md）
- [ ] github-copilot 内置 plugin 重写（OAuth + Anthropic 路由 fix）
- [ ] github-proxy 内置 plugin 重写（proxyUrl 侧信道 + apiKey）
- [ ] auth.json metadata 持久化补丁（绕开上游 BUG）
- [ ] 计费铁律单测：一次回车 ≤ 1 次 upstream 请求

## 阶段 5 · TUI 配额条（按 04-tui-quota-status.md）
- [ ] feature-plugin 形态落到 `cli/cmd/tui/feature-plugins/github-proxy/`
- [ ] 复用 reference 的 `quota-status.tsx`，按当前 opentui API 适配
- [ ] 60s 轮询 + 占位符防 Slot 跳过
- [ ] 启用条件：检测到 github-proxy 或 github-copilot auth 才挂载

## 阶段 6 · 收尾
- [ ] 经验回写 `.memory/`（patterns + commands + architecture）
- [ ] 删除 `.codex_plan/`
