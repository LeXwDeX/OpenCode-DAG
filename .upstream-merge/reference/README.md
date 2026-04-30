# 参考素材（来自 fork dev @ 73f52b85d0，2026-04-30）

本目录下的代码**只读、用于重写参考**。新分支 `reset/upstream-1.14.30` 已重置回上游主干，
所有 fork 特性以**外部 plugin** 形态在 `packages/opencode/src/plugin/` 之外或独立包中重写。

## 目录说明

| 子目录 | 来源 | 用途 |
|---|---|---|
| `github-copilot/` | `packages/opencode/src/plugin/github-copilot/` | OAuth 登录、Anthropic 路由 fix()、isAgent/isVision 启发式 |
| `github-proxy/` | `packages/opencode/src/plugin/github-proxy/` | proxyUrl + apiKey 双字段登录、CopilotModels.get fallback |
| `tui-quota-status/` | `packages/opencode/src/cli/cmd/tui/feature-plugins/github-proxy/quota-status.tsx` | TUI 状态栏配额条、`/copilot/quota` 与 `/copilot_internal/user` 解析 |
| `auth-fix/` | `packages/opencode/src/cli/cmd/providers.ts` + `4b00e5996f.patch` | fork 修过的 metadata 透传 + 双重 password 询问规避；upstream 仍有这两个 bug，plugin 必须自洽规避 |

## 已知 upstream 缺陷（v1.14.30 仍在）

1. **`providers.ts:put()` 不透传 `metadata`**：`auth.json` 写入时 plugin authorize 返回的 `metadata` 字段被丢弃。
   → 规避：plugin 把 `proxyUrl` 写入侧信道 JSON（如 `~/.local/share/opencode/plugin-storage/github-copilot-proxy.json`）。
2. **`type: "api"` 路径强制 `prompts.password`**：即使 method.prompts 已采集 apiKey，会再弹 "Enter your API key"。
   → 规避：用 `type: "oauth"` + `method: "auto"` 假冒 OAuth，让 prompts 集中采集，绕开通用 password 提示。

## Copilot 计费铁律

按用户发起次数扣费 → plugin 端**禁止**任何形式的：
- 隐式重试（包括 5xx 自动重试）
- fanout / 并发探测 / 模型预热
- 心跳/keepalive 形式的"不计费"假设
- 静默 fallback 在两个不同 model 各发一次的逻辑

**一次用户回车 = 至多一次 upstream Copilot 请求**，否则用户钱包受损。
