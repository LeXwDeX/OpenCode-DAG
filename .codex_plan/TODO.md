# TODO：从上游 anomalyco/opencode v1.14.30 抽取价值变更

> 范围：`ac6aa43e3..upstream/dev`（v1.14.30 至今，377 commits）
> 策略：**只读对照上游 → 按本 fork 架构重新实现 → 每项 typecheck 验证**
> 严禁机械 cherry-pick

---

## Tier S — Provider/模型行为修复（最高价值，最小爆炸半径）
- [x] S0a Deepseek v4 flash variants 解禁（`9d6718131e`）
- [x] S0b Deepseek anthropic transform thinking 配置（`56fd16e5c0`）
- [x] S1 GPT-5 reasoning 变体对齐（`1cf8123bc`）
- [x] S2 Anthropic & Bedrock transform 修正（`4e14f7951`）
- [x] S3 Anthropic Opus 4.5 efforts 对齐（`e0396b809`）
- [x] S4 OpenAI deep research efforts 约束（`319498e2f`）
- [x] S5 含 reasoning block 时保留 assistant 内容（`233fc5b91`）
- [x] S6 Mistral medium 3.5 variants 配置（`576480b5d`）
- [x] S7 Anthropic SDK 在 Azure 下解析（`c1f607d20`）
- [x] S8 cf-ai-gateway providerOptions 路由（`ca77b8f8e`）
- [x] S9 providerOptions key 按点分割（`a12333310`）
- [x] S10 Bedrock reasoning 修复（`29ec07700`）
- ✅ 验证：`bun test test/provider/transform.test.ts test/session/message-v2.test.ts test/provider/amazon-bedrock.test.ts` → 186 pass / 0 fail

## Tier A — 核心稳定性 BUG（高价值）
- [x] A1 重试 server_is_overloaded（`25ecf0af6`）
- [x] A2 compaction 摘要顺序（`811954880`）— 26 行 + 4 处测试断言更新
- [~] A3 取消子任务 child sessions（`75d141b57`）— 延后；prompt.ts/task.ts 改造会破坏 bash 取消截断时序，与上游 task.test.ts 大改（-225+474）耦合，需独立深入排查
- [~] A4 vcs 批量 patch 边界（`6a5e32942`）— N/A，fork vcs.ts 用 `structuredPatch` 逐文件计算，从不解析 git 批量输出，bug 不存在
- [ ] A5 vcs diff 内存控制（`d1f597b5b`）— 延后（~332 行）
- [x] A6 sanitize surrogates（`6409aceb1`）
- [x] A7 tool 返回 image+空 text 错误（`563177c6a`）
- [x] A8 read 阻止不支持图片格式（`51e310c9c`）
- [x] A9 修复无 model 时恢复 messages 崩溃（`9bddf7f3e`）
- [x] A10 user config 优先于 plugin hooks 解析 model（`560baae15`）
- [ ] A11 bootstrap 后更新 provider store（`a5aa72bd7`）— packages/app（前端，延后）
- [x] A12 OPENCODE_DISABLE_CLAUDE_CODE_SKILLS 不影响外部 skills（`ffe0314c4`）
- ✅ 验证：`bun test test/provider/ test/session/message-v2.test.ts test/skill/ test/tool/read.test.ts` → 345 pass / 0 fail

## Tier B — 服务/Auth/Format 修复（合理价值）
- [x] B1 formatter stdout/stderr ignore 恢复（`293bb422f`）
- [x] B2 auth login stderr 继承（`8e016b470`）
- [ ] B3 保留 auth token credentials（`ca6150d6f`）— packages/app（前端，延后）
- [x] B4 task 子 session 保留 external_dir/deny 父权限（`d7701dbfb`）
- [~] B5 archived timestamp schema 用 finite（`16ddf5f55`）— N/A，fork 用 NonNegativeInt 已更严

## Tier C — 新功能（需先评估架构兼容）
- [ ] C1 shell-aware bash tool（bash/pwsh/cmd 上下文，`3f459819b`）— 延后（506+/177-，含 tui 大改）
- [x] C2 config 支持 well-known remote_config（`d9c18381a`）
- [x] C3 websearch 并行 provider rollout（`a43d3e0e1`）— 后端已应用，tui/ui 部分按 fork 规则跳过
- ✅ 验证：`bun test test/tool/websearch.test.ts test/config/config.test.ts` → 91 pass / 0 fail

---

## 显式跳过（与 fork 架构冲突 / 不适用）
- effectCmd 系列重构（25517/25507/25481/25429/25434/146ff8ad8/f8738c900）— 本 fork 已自有 CLI 抽象
- httpapi/server 大型重构（25547/25545/25074/25291/25527/25412/25417/25475/25449/26052/63a175b50/2dffdfff4）— fork 自有 server
- session warping (`22a4a9df8`) + copy file changes (`3c4b4d5fa`) — 大型新特性，需用户单独决策
- ACP modernize (`b2e3dc87e`) — 大型重构
- desktop electron 系列 — fork 用 Tauri + 独立 desktop-electron
- tui/console/web/share/storybook 系列 — 演化路径不同
- chore/sync/generate/typo/changelog 噪音
- 商业化 vendor：zen/go/honeycomb/free-tier/codex spark
- Codex OAuth (`ce89bcb8e`)、basic auth (`adb7cb103/8694c5b68/101566131/7a503de60`)、PTY tickets — 与本 fork auth 模型偏差

## 工作循环（每项）
1. `git show <sha>` 看上游意图
2. fork 中定位对应模块
3. 评估：直接适用 / 需调整 / 不适用
4. 实施修改 + `bun typecheck`
5. 更新本 TODO
