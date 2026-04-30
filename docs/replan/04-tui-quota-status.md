# TUI Copilot 配额状态条

> 目标：在 opentui 底部 status bar 实时显示 Copilot premium request 剩余用量，**最小侵入**。
> 数据源：github-copilot-proxy 已暴露的 `/copilot/quota` 端点（用户已确认）。

## 1. 形态与位置

- **位置**：`session_prompt_right` slot（与 reference 一致），即输入框右侧
- **格式**：
  - github-proxy 模式（多账号聚合）：`[3/5 | 287/500]`（活跃账号/总账号 | 剩余/总额）
  - github-copilot 直连模式：`⊘ 287/500`（占位 + 剩余/总额）
  - 数据未就绪 / 鉴权缺失：`⊘ …`（占位符，**必须非空**）
- **配色**：>30% green，10–30% warning，<10% error（取自 theme）

## 2. 模块布局

```
packages/opencode/src/cli/cmd/tui/feature-plugins/github-proxy/
  quota-status.tsx     # 主组件（参考 .upstream-merge/reference/tui-quota-status/）
  index.ts             # 导出 plugin module
```

挂载方式：`cli/cmd/tui/plugin/runtime.ts` 的 INTERNAL_TUI_PLUGINS 数组追加该 plugin。

## 3. opentui Slot 关键约束

> 来自 reference 注释，反复踩过的坑：

**Slot 系统在初始渲染时检查输出是否为空。若初始渲染返回 `null` 或 `""`，该插件条目会被永久跳过，后续即便有数据也不再渲染。**

→ 解决：组件 mount 时立即返回 `<text>⊘ …</text>` 占位符；数据就绪后再 setState 更新。

## 4. 数据获取

### 4.1 auth.json 解析（启动一次）
按以下顺序探测：
1. `auth["github-proxy"].type === "api"` → 取 `metadata.proxyUrl` + `key` → quota URL = `${proxyUrl}/copilot/quota`，header `Authorization: Bearer ${key}`
2. `auth["github-copilot"].type === "oauth"` → 取 `refresh` token → quota URL = `${apiBase}/copilot_internal/user`，header `Authorization: token ${refresh}`
3. 都没有 → 返回空字符串，组件不显示（但 slot 占位仍存在）

### 4.2 轮询
- 间隔：60s（与 reference 一致）
- 超时：5s（AbortSignal.timeout）
- 失败处理：保留上次成功值，不弹错误，仅日志 debug

### 4.3 解析两种响应

**proxy 模式** (`/copilot/quota` 自定义协议)：
```json
{
  "remaining": 213,        // ⚠️ 后端语义实际是 used，组件需翻转：actual = entitlement - remaining
  "entitlement": 500,
  "accounts_active": 3,
  "accounts_total": 5
}
```

**copilot 直连** (`/copilot_internal/user`)：
```json
{
  "quotaSnapshots": {
    "premiumInteractions": {
      "percentRemaining": 95
    }
  }
}
```
转换为统一形态：`entitlement = 100, remaining = 100 - percentRemaining`，账号字段填 0。

## 5. 与 reference 的差异点

reference 的 `quota-status.tsx` 已基本可用，迁移时检查：
- ✅ opentui API 是否变更（`api.slots.register`、`<text>` 元素、`<span style={{ fg }}>` 写法）
- ✅ solid-js signals 是否仍是当前 TUI 框架的反应式 API
- ✅ `Global.Path.data` 路径常量是否仍然存在

如有变更，按当前 API 微调，**不重写整体逻辑**。

## 6. 启用条件

- 检测到 auth.json 中存在 github-proxy 或 github-copilot 条目才挂载；
- 完全无 Copilot 配置的用户启动 TUI 时**不显示**该 slot（不占位）。

## 7. 不做

- ❌ 不做点击展开详情面板（status bar 极简）
- ❌ 不做 quota 突破警告弹窗（仅配色提示）
- ❌ 不做手动刷新快捷键（60s 轮询足够）
- ❌ 不缓存 quota 到磁盘（重启重新拉取一次）

## 8. 验收

```bash
# 启动 TUI，确认底部 status bar 右侧出现配额条
opencode

# 数据未就绪场景：先保留 ⊘ … 占位，至多 60s 后变为真实数值
# 鉴权缺失场景：slot 不显示
# 触发 60s 轮询：等 1 分钟后数值刷新
```
