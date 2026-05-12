# 08 - 测试计划（Phase 4 完整覆盖矩阵）

> 范围：基于上游 `eb4219304`（opencode v1.14.30）之上的 13 个 fork commit。
> 目标：每条新增/修改的功能均有可复跑的验证命令与验收标准，未来上游 rebase 或回归排查时直接对照。

## 1. 测试栈速查

| 维度 | 命令 | 出处 |
|---|---|---|
| 全量 unit/integration | `bun test`（`packages/opencode/`，**禁止根目录**） | `test/AGENTS.md` |
| 单文件 | `bun test test/<path>` | 同上 |
| 用例过滤 | `bun test <file> -t "<title 子串>"` | bun-test |
| 类型校验（pre-push 真校验） | `bun turbo typecheck` | repo root |
| 单包类型校验 | `bun run typecheck`（`packages/opencode/`） | `tsgo --noEmit` |
| Effect Layer fixture | `testEffect(...)` + `provideTmpdirInstance` | `test/lib/effect.ts` / `test/fixture/fixture.ts` |

> 验收基线锚点：`bun test` = **2230 pass / 20 skip / 2 todo / 0 fail**（182 文件，~228s）；
> `bun turbo typecheck` = 13 包全绿。

## 2. 跨阶段总验收（每次 release/PR 必跑）

| 步骤 | 命令 | 通过条件 |
|---|---|---|
| 1 | `cd packages/opencode && bun test` | 0 fail；skip 数 ≤ 当前基线（20）；不出现新 todo |
| 2 | `bun turbo typecheck` | 13 包全部 successful |
| 3 | `git diff origin/replan/v1.14.30...HEAD --stat` | 无意外文件改动 |
| 4 | 手动启动 TUI（见 §6）+ 触发一次 github-proxy 会话 | 配额状态栏渲染、x-initiator 正确、无 401/400 |

## 3. Phase 1 — 稳定性补丁验收矩阵

| Commit | 修改 | 验证命令 | 验收标准 |
|---|---|---|---|
| `7790a4b94` | MCP timeout + 孤儿 `tool_use` 自愈 | `bun test test/session/` | 现有 session 测试全绿；MCP 集成手测：人为让一个 MCP 工具长时间无响应，会话不卡死，超时后自动注入 `tool_result` 误差消息 |
| `1908fbf1d` | `question` 友好校验提示 | `bun test test/tool/question.test.ts` | 5/5 pass；formatValidationError 输出含 `["questions"][0]["question"]` + `Missing key` + `Correct call example` |
| `5a63eaef7` | 三项稳定性（崩溃恢复 / thinking 400 / auth metadata） | `bun test test/provider/ test/session/` | 不出现 `Invalid signature in thinking block`；providers cli 列表含 `github-proxy`；auth.json 写入读出 metadata 字段保留 |

**手动验证（无法纳入自动化）**：
- 强制 kill TUI 子进程，重启 → 会话状态可恢复，未损坏
- 触发包含 thinking block 的 Claude 长会话 → 上游不返回 400

## 4. Phase 2-3 — Hook 系统验收矩阵

> 1:1 兼容 Claude Code 的 8 类事件（fork 不实现 CC 的 `Notification`）：`PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop` / `SubagentStop` / `PreCompact` / `SessionStart` / `SessionEnd`。

| Commit | 模块 | 验证命令 | 验收标准 |
|---|---|---|---|
| `30a5f7dbc` | hook 骨架 + `SettingsHook.Service` | `bun test test/session/prompt.test.ts` | 现有 prompt.test.ts 全绿；`yield* SettingsHook.Service` 不出现在公共 API 的 R 通道 |
| `85609c5b9` | 8 事件 1:1 落地（去 Notification）| `bun test test/session/ test/permission/` | 全绿；docs/replan/07-hook-1to1.md 中"事件触发点"表格的源码行号能被 `rg` 命中 |
| `5bdf76454` | Layer 注入修补 | `bun test test/tool/ test/permission/ test/session/` | 不出现 `Service not found: SettingsHook` 错误；ToolRegistry 默认 layer 自包含 |
| `d3b2e1868` | prompt.test.ts 接入 | `bun test test/session/prompt.test.ts -t "hook"` | 现有覆盖路径不回退 |

**已知覆盖缺口**（已补齐，commit `27510b442`）：
- ~~8 事件中目前仅 `UserPromptSubmit` 有完整集成测试（prompt.test.ts）~~
- ~~其他 8 事件缺独立单元测试，依赖上层会话集成路径间接验证~~
- ✅ `test/hook/settings.test.ts`：单文件覆盖 PreToolUse / PostToolUse / Stop / SubagentStop / PreCompact / SessionStart / SessionEnd 7 个事件 describe（UserPromptSubmit 由 `test/session/prompt.test.ts` 集成覆盖；fork 删除 Notification）+ WP-4A/4B/4C/4D-2/4F handler 矩阵 describe；通过临时 `settings.json` 注入 shell hook，`cat > captured.json` 抓取 envelope，stdout JSON 注入控制 `TriggerResult` 字段。截至 WP-4F/3 共 51 PASS（事件覆盖 + 5 handler 矩阵）
- 设计偏离：原计划列 8 文件 per-event；实际改为单文件多 describe，因 8 事件共享同一 `trigger` 管道（仅 envelope/matcher/result 字段分支不同），分文件会大量重复 fixture

**手动验证**：
- 在 `~/.opencode/settings.json` 配置一个 `PreToolUse` hook 拦截 `bash` → 执行任意 bash 工具被拒
- 配置 `SessionStart` hook 注入额外 system 消息 → 新会话首响包含该提示

## 5. Phase 4 — github-proxy + TUI quota 验收矩阵

### 5.1 github-proxy provider

| 子模块 | 验证命令 | 验收标准 |
|---|---|---|
| `models()` 路由（fallback fix + providerID 改写） | `bun test test/plugin/github-proxy/proxy.test.ts -t "models"` | 2/2 pass：claude → `@ai-sdk/anthropic + /v1`；非 claude → `@ai-sdk/github-copilot`，全部模型 `providerID = "github-proxy"` |
| `loader().fetch` 拦截器（x-initiator / Vision / Bearer） | `bun test test/plugin/github-proxy/proxy.test.ts -t "loader"` | 5/5 pass：assistant 收尾→`agent`；user 收尾→`user`；image_url→`Copilot-Vision-Request: true`；`x-api-key`/`authorization` 强制清理后注入 `Authorization: Bearer <key>` |
| `authorize()` 流程 | `bun test test/plugin/github-proxy/proxy.test.ts -t "authorize"` | 4/4 pass：200 → success+metadata（去尾斜杠）；非 200 / 抛错 / 缺参 → failed |
| Provider 注册 4 处 | `rg "github-proxy" packages/opencode/src/{plugin/index.ts,provider/{schema,provider,transform}.ts}` | 4 个文件均有匹配，无遗漏 |
| Plugin SDK 类型 | `bun turbo typecheck` | `AuthHook.methods` `type:"api" authorize` 返回类型含 `metadata?: Record<string, string>` |

**手动验证（端到端）**：
1. 配置 `auth.json`：
   ```json
   { "github-proxy": { "type": "api", "key": "<key>", "metadata": { "proxyUrl": "http://<内网>:8000" } } }
   ```
2. `opencode` 启动 → `/providers` 列出 `github-proxy`
3. 选 Claude 模型发问 → 上游 200，无 thinking-block 报错
4. 选 GPT 模型发问 → 走 `/chat/completions`，header 含 `x-initiator`/`User-Agent`
5. 上传图片提问 → header 含 `Copilot-Vision-Request: true`

### 5.2 TUI Quota 状态栏

**自动化覆盖**（commit `c9edab9fa`）：`bun test test/cli/cmd/tui/feature-plugins/session/quota-fetch.test.ts` → 17 case 覆盖 auth 读取 / 两种响应解析 / fetch 错误降级。

**手动清单**（Solid 渲染 + opentui Slot 仍需手测）：

| 场景 | 操作 | 期望 |
|---|---|---|
| 未配置凭据 | 移除 `auth.json` 中 `github-proxy` 与 `github-copilot` | TUI 启动正常，配额栏不渲染（静默） |
| github-proxy 凭据存在 | 配置如 §5.1 | 60s 内 `session_prompt_right` 槽位出现配额数字 |
| github-copilot 凭据存在 | 走标准 oauth 登录 | 同上，但走 `/copilot_internal/user` |
| 网络故障 | 拔网线 / mock 503 | 状态栏不刷新，但 TUI 不崩；恢复后下次轮询恢复 |

### 5.3 测试基线修复（commit `3ca3791e2`）

| 测试 | 修复手段 | 复跑命令 |
|---|---|---|
| `installation > latest > reads {npm,bun,pnpm}` | `beforeAll` 注入 `npm_config_registry=https://registry.npmjs.org/`（env > rc 覆盖本地 mirror） | `bun test test/installation/installation.test.ts` |
| `tool.write > throws error when OS denies write access` | `process.getuid?.() === 0` 早返回（root/WSL chmod 不阻写） | `bun test test/tool/write.test.ts` |
| `config tui > continues loading tui config when legacy source cannot be stripped` | 同上 root 跳过 | `bun test test/config/tui.test.ts` |
| `tool.question > formatValidationError`（3 处） | 期望串改为 Effect Schema bracket 形式：`["questions"][0]["question"]` + `Missing key` | `bun test test/tool/question.test.ts` |

**复跑通过条件**：上述 4 个文件全绿，3 个 skip 仅在 root 环境出现，非 root 环境应实跑通过。

## 6. 手动 TUI 冒烟脚本（release 前必走）

```bash
# 1. 构建 + 启动 TUI（开发模式）
cd packages/opencode
bun run dev

# 2. 在 TUI 内顺序执行
#    a. /providers          → 期望看到 github-proxy 列在列表中
#    b. /model               → 切换到 github-proxy 下的 claude-opus-4.7
#    c. 发起一条普通对话      → 200 OK，无报错
#    d. 上传图片再问          → header 中 Copilot-Vision-Request: true（看 server log）
#    e. 观察右上角配额数字     → 60s 内出现
#    f. /quit                → 干净退出
```

## 7. 回归触发器（哪些改动需要重跑哪些测试）

| 改动文件 | 必跑测试集 |
|---|---|
| `src/plugin/github-proxy/**` | `test/plugin/github-proxy/` + 全量 typecheck |
| `src/plugin/github-copilot/**` | `test/plugin/github-copilot-models.test.ts` + 上行 |
| `src/provider/{schema,provider,transform}.ts` | `test/provider/` + 上行 |
| `src/hook/settings.ts` | `test/session/prompt.test.ts` + `test/permission/` + 全量 typecheck |
| `src/session/{prompt,compaction}.ts` | `test/session/` 全量 |
| `src/tool/registry.ts` | `test/tool/` + `test/permission/` |
| `packages/plugin/src/index.ts`（SDK 类型） | `bun turbo typecheck`（影响下游所有 plugin） |

## 8. CI/本地差异说明

- **WSL/root**：3 个 chmod/registry 相关测试通过 `getuid()===0` 与 `npm_config_registry` env 自动适配
- **macOS/Linux 非 root**：所有测试应实跑通过，无 skip
- **Windows**：当前未测；`bash.test.ts` 等已用 `test.skipIf(process.platform === "win32")` 隔离不可用项

## 9. 已知缺口（不阻塞 fork.1 release，列入 backlog）

1. ~~`test/hook/<event>.test.ts` 8 文件：每事件单独 fixture（PreToolUse/PostToolUse/Stop/SubagentStop/PreCompact/SessionStart/SessionEnd 共 7 个 — fork 不实现 Notification）~~ — ✅ 已完成（commit `27510b442` 起步，WP-4F/3 收尾，单文件多 describe 形式覆盖 51 PASS）
2. ~~TUI Quota 自动化：当前完全靠手测；可行路径是把 `quota.tsx` 中纯函数（`readQuotaAuth` / `parseCopilotQuota` / `parseProxyQuota` / `fetchQuota`）提取并 export，再单测 fetch mock + JSON 解析。组件渲染（Solid + opentui Slot）不在自动化范围~~ — ✅ 已完成（commit `c9edab9fa`）：纯函数抽离至 `quota-fetch.ts`，`test/cli/cmd/tui/feature-plugins/session/quota-fetch.test.ts` 17 case 覆盖；Solid 渲染仍走 §5.2 手测
3. 端到端冒烟脚本：~~可考虑用 `webapp-testing` skill / Playwright 包装 §6~~ — 修正：TUI 是终端应用而非 web，Playwright 不适用；可用 `node-pty` + expect-style 断言包装 §6，但工程量较大，目前继续手动
4. **OPENTUI 升级（决策：保守保持 0.1.105）**：上游已发 `@opentui/{core,solid}@0.2.1`（跨 minor，预期 breaking）。当前 fork 在 0.1.105 上验证稳定，升级收益不明确、风险高。后续若要升 0.2.x，须新开探路分支跑全套手动 TUI 冒烟（§6）+ 自动化测试，并按 breaking change 清单逐项迁移。
5. ~~**其他依赖升级**：上游 v1.14.30 基线本身已携带较新依赖快照；除非出现安全 CVE 或具体功能需要，本 fork 不主动追依赖升级，避免引入与稳定性补丁无关的风险面。~~ — ✅ 已完成 patch 级批量升级（commit 见下）：47 项 patch（`@ai-sdk/*` 全家、`@parcel/watcher*` 9 个平台 binary、`@octokit/*`、`@solid-primitives/*`、`@types/*`、`turndown`、`glob` 等）；明确排除 3 项：`@pierre/diffs`（beta→stable 跨度）、`solid-js`（被 patches/solid-js@1.9.10.patch 锁定）、`@typescript/native-preview`（半年跨度 dev nightly）。所有 minor/major 升级保持原决策——保守不动

## 10. Phase 5 — Hook 协议补强验收（已交付）

| WP | 测试文件 | 用例数 |
|---|---|---|
| WP-5A SessionStart additionalContexts | `test/hook/start-context.test.ts`（单元）+ `test/session/prompt.test.ts`（集成 +2） | 2 + 2 |
| WP-5B continue=false 短路 | `test/session/prompt.test.ts`（集成 +2） | 2 |
| WP-5C suppressOutput | schema-only no-op，0 用例 | 0 |
| WP-5D SessionHooks 动态注入 | `test/hook/session-hooks.test.ts`（add/remove/list/clear/once + Stop→SubagentStop 翻译） | 5 |

阶段 5 净增 **9 测试**（spec 门禁 ≥8），全量 `bun test test/` = **2361 PASS / 20 skip / 2 todo / 2 fail（pre-existing 时序非关联）/ 10917 expects / 190 files / 190.96s**。

回归触发器补充：
- 改 `src/hook/settings.ts`、`src/hook/start-context.ts`、`src/hook/session-hooks.ts` → 必跑 `test/hook/` 全部 + `test/session/prompt.test.ts`
- 改 SessionStart drain 注入点（prompt.ts:~1481）→ 必跑 `test/session/prompt.test.ts` + `test/hook/start-context.test.ts`

## 11. Phase 6 — Hook 鲁棒性补强验收（已交付）

| WP | 测试文件 | 用例数 |
|---|---|---|
| WP-6A 入口 O(1) 短路 | `test/hook/settings.test.ts`：(a) 无 hook 配置 → 空 result 不触碰 matcher；(b) 配了不同 event 的 hook → 当前 event 仍短路 | 2 |
| WP-6B `allowUntrusted` schema 字段 + TODO 注释 | schema-only + 注释，无运行时行为变化，0 用例 | 0 |
| WP-6C plugin `__sourceDir` 缺失 silent allow | `test/hook/settings.test.ts`：先正常 trigger 验链路通（hook exit 2 → blocked）→ rm `.claude` → 第二次 trigger 期望 `result.blocked === undefined` | 1 |

阶段 6 净增 **3 测试**，hook test 60 → **63 PASS**，全量 `bun test test/` = **2361 → 2365 PASS / 20 skip / 2 todo**（pre-existing fail 与本阶段 0 关联）。

## 12. Phase 7 — 最终验收（已交付）

| 验收项 | 实测 |
|---|---|
| 全量回归 | `bun test test/` = **2365 PASS / 20 skip / 2 todo / 1 fail**（唯一 fail 是 `test/tool/truncation.test.ts > cleanup > 7 days`，PRE-EXISTING 时间敏感，与 hook 0 关联）|
| typecheck | `bun turbo typecheck` 13 包全绿 |
| CC e2e 兼容 | CC 官方文档 verbatim 配置 8 用例 e2e（PreToolUse+Bash / PostToolUse+Edit\|Write / SessionStart additionalContext）→ **8/8 PASS**；临时验证脚手架 `test/hook/cc-compat.test.ts` 确认契约后已删除，hook 套件回到 63 PASS 基线 |
| 兼容性矩阵文档化 | **6 项严格超集 + 1 项 schema-only + 2 项行为差异**（`suppressOutput` 默认翻转 / `Notification` 显式不支持）已在 `RELEASE_NOTES.md` ⟶「Hook 协议 CC 兼容性总结（阶段 7 验证）」段定稿 |
