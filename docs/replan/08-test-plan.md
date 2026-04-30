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

> 1:1 兼容 Claude Code 的 9 类事件：`PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Notification` / `Stop` / `SubagentStop` / `PreCompact` / `SessionStart` / `SessionEnd`。

| Commit | 模块 | 验证命令 | 验收标准 |
|---|---|---|---|
| `30a5f7dbc` | hook 骨架 + `SettingsHook.Service` | `bun test test/session/prompt.test.ts` | 现有 prompt.test.ts 全绿；`yield* SettingsHook.Service` 不出现在公共 API 的 R 通道 |
| `85609c5b9` | 9 事件 1:1 落地 | `bun test test/session/ test/permission/` | 全绿；docs/replan/07-hook-1to1.md 中"事件触发点"表格的源码行号能被 `rg` 命中 |
| `5bdf76454` | Layer 注入修补 | `bun test test/tool/ test/permission/ test/session/` | 不出现 `Service not found: SettingsHook` 错误；ToolRegistry 默认 layer 自包含 |
| `d3b2e1868` | prompt.test.ts 接入 | `bun test test/session/prompt.test.ts -t "hook"` | 现有覆盖路径不回退 |

**已知覆盖缺口**（写入"已知局限"，作为下一阶段 backlog）：
- 9 事件中目前仅 `UserPromptSubmit` 有完整集成测试（prompt.test.ts）
- 其他 8 事件缺独立单元测试，依赖上层会话集成路径间接验证
- 后续若要达到 release 级别置信度，需在 `test/hook/<event>.test.ts` 各起一个最小 fixture（settings.json → 事件触发 → assert exec/transform 副作用）

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

无自动化测试（依赖 `auth.json` + 网络 + Solid 渲染）；走手动清单：

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

1. `test/hook/<event>.test.ts` 8 文件：每事件单独 fixture（PreToolUse/PostToolUse/Notification/Stop/SubagentStop/PreCompact/SessionStart/SessionEnd）
2. TUI Quota 自动化：需 mock Solid render + 假 `auth.json` 注入；目前完全靠手测
3. 端到端冒烟脚本：可考虑用 `webapp-testing` skill / Playwright 包装 §6
