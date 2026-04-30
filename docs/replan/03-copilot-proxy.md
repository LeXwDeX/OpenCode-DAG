# GitHub Copilot Proxy 集成方案

> 目标：保留现有 github-copilot-proxy 代理模式，在干净基线上以**内置 plugin** 形态重新落地，规避上游 v1.14.30 的 2 个 auth 缺陷，遵守 Copilot 计费铁律。

## 1. 双 Plugin 架构

| Plugin | 路径 | 用途 |
|---|---|---|
| `github-copilot` | `packages/opencode/src/plugin/github-copilot/` | OAuth 直连官方 Copilot API |
| `github-copilot-proxy`（暂名 github-proxy） | `packages/opencode/src/plugin/github-proxy/` | 通过自建代理 proxyUrl + apiKey 转发，支持配额聚合 |

两者都注册为 `INTERNAL_PLUGINS`，启动时按 auth.json 中是否存在对应条目决定是否激活。

## 2. 上游缺陷规避

### 2.1 缺陷 A：`providers.ts:put()` 不透传 metadata
- **现象**：plugin authorize 返回 `{ metadata: { proxyUrl: ... } }`，写入 auth.json 时该字段被丢弃。
- **规避**：plugin 把 `proxyUrl` 写入侧信道 JSON：
  ```
  ~/.local/share/opencode/plugin-storage/github-copilot-proxy.json
  ```
  读取时优先看 auth.json metadata，缺失则回落到侧信道。

### 2.2 缺陷 B：`type: "api"` 强制 `prompts.password`
- **现象**：即使 plugin 已采集 apiKey，`providers.ts` 会再弹一次 "Enter your API key"。
- **规避**：plugin 用 `type: "oauth"` + `method: "auto"` 形式假冒 OAuth，让 prompts 走 plugin 集中采集，绕开通用 password 提示。

> 长期：考虑给上游 PR 修复这两个 BUG（不在本期，仅记录）。

## 3. github-copilot Plugin 设计

### 3.1 职责
- OAuth device flow 登录（与 Copilot 官方 API）
- 把 Anthropic 协议请求 fix() 为 Copilot 兼容形态
- isAgent / isVision 模型能力启发式判定
- enterpriseUrl 场景的 API base 切换
- 模型 snapshot（含 fork 自有的 `claude-opus-4.7` 等）

### 3.2 关键 fix 复刻
| 原 fork commit | 修复点 | 在新 plugin 中位置 |
|---|---|---|
| `8321e38464` | Claude 模型不要 fallback 到 chat/completions | model fix() 路径分支 |
| `b89482bb2c` | enterprise URL pathname 拼接错误 | apiBase 构造函数 |
| `6e470e46b1` | thinking signature 链 不要因 models 解析失败而断 | 错误恢复路径 |
| `af2808f32c` | claude-opus-4.7 模型快照 | models.ts |

### 3.3 不做
- ❌ 任何形式的隐式重试（5xx 直接返回错误，由 ai-sdk/上层决定）
- ❌ fanout / 并发探测
- ❌ 心跳 keepalive 假设不计费
- ❌ 静默 fallback 在两个 model 各发一次

## 4. github-copilot-proxy Plugin 设计

### 4.1 职责
- 用户登录时采集 `proxyUrl` + `apiKey` 双字段
- 把所有请求转发到 proxyUrl，header 带 `Authorization: Bearer <apiKey>`
- 注入 `x-opencode-turn-id`（= last user message id）+ `x-opencode-step`，供后端按 turn 聚合 usage
- 提供 `/copilot/quota` 端点协议契约（供 04-tui-quota-status.md 消费）

### 4.2 turn-id 注入位置
通过 `chat.headers` plugin hook 追加，对应 `.memory/architecture/opencode-chat-http-shape-20260430.md` 的协议契约：
```ts
chat.headers: ({ messages }) => {
  const lastUser = [...messages].reverse().find(m => m.role === "user")
  return {
    "x-opencode-turn-id": lastUser?.id ?? "",
    "x-opencode-step": String(currentStep),
  }
}
```

### 4.3 计费铁律单测
新增 `packages/opencode/test/plugin/github-proxy/billing.test.ts`：
- 模拟 proxy 后端记账
- 跑一次 chat（带 N 个 tool call）
- 断言：N+1 条 HTTP，**1 条按 turn 聚合的计费记录**
- 断言：5xx 不重试

## 5. Auth schema 与 prompts

### 5.1 github-copilot
```ts
{
  type: "oauth",
  method: "auto",  // 假装 OAuth 绕过 password 提示
  prompts: [
    { name: "deviceCode", action: "show" },  // 展示 device flow
  ],
}
```

### 5.2 github-copilot-proxy
```ts
{
  type: "oauth",
  method: "auto",
  prompts: [
    { name: "proxyUrl", placeholder: "https://your-proxy.example.com" },
    { name: "apiKey", placeholder: "sk-..." },
  ],
}
```

## 6. 启用条件

启动时 `plugin/install.ts` 检查 auth.json：
- 存在 `github-copilot` entry → 加载 github-copilot plugin
- 存在 `github-proxy` entry → 加载 github-proxy plugin
- 都不存在 → 都不加载（启动零开销）

## 7. 与上游 OAuth 模块的边界

- **不修改** `provider/auth.ts`、`provider/provider.ts`、`cli/cmd/providers.ts` 上游核心；
- 全部 fix 通过 plugin authorize 内部消化；
- 唯一例外：若上游 `providers.ts` 的双重 password 提示在本期复测仍存在且无法用 `type: "oauth"` 绕开，则提交一个**最小 hunk** 局部补丁，commit message 标注 `（待上游 PR）`。

## 8. 验收命令

```bash
# 登录
opencode auth login github-copilot
opencode auth login github-proxy
# 应只弹必要提示，不出现重复 "Enter your API key"

# 检查侧信道持久化
cat ~/.local/share/opencode/plugin-storage/github-copilot-proxy.json
# 应包含 proxyUrl

# 计费铁律
cd packages/opencode && bun test test/plugin/github-proxy/billing.test.ts
```
