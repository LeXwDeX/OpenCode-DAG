# 执行顺序与验收

## 阶段时序

```
0. 文档落地（本次提交）
   └─ 等用户确认是否进入阶段 1

1. 上游基线推进
   ├─ 决策：reset/upstream-1.14.30 → dev（强推 / 合并 / 新建工作分支三选一，需用户确认）
   ├─ bun typecheck（packages/opencode）
   ├─ bun test（packages/opencode）
   └─ 输出：基线裸跑失败清单，与 01-bug-inventory.md 对照

2. P0 BUG 回归（依赖阶段 1 的失败清单）
   ├─ 启动类：cli lazyCmd $0、help/version、storage marker
   ├─ 协议类：MCP timeout、Hook EPIPE、thinking 末尾字符
   └─ 每条独立 commit，message 引用 fork 原 commit hash

3. Hook 系统（独立模块，与 plugin 系统并存）
   ├─ schema + loader + matcher + runner（先单元测试驱动）
   ├─ 9 个事件注入点逐个接入（每个独立 commit）
   ├─ CC 兼容性集成测试
   └─ 文档：packages/opencode/src/hook/README.md

4. Copilot Proxy（依赖阶段 2 的 auth 修复 + 阶段 3 的 Hook 不强相关）
   ├─ github-copilot plugin 重写
   ├─ github-proxy plugin 重写 + 侧信道 metadata
   ├─ chat.headers turn-id 注入
   └─ 计费铁律单测

5. TUI 配额条（依赖阶段 4 的 auth.json 形态稳定）
   ├─ feature-plugin 落地
   ├─ opentui Slot API 适配
   └─ 双模式（proxy / copilot 直连）E2E 验证

6. 收尾
   ├─ 经验回写 .memory/patterns/、.memory/commands/、.memory/architecture/
   ├─ P0 修复经验回写 .memory/errors/
   └─ 删除 .codex_plan/
```

## 阶段间提交规范

- 每阶段结束前**必须** typecheck + test 全绿；
- commit message 使用项目规范（功能/修复/文档/重构/测试/维护/优化/运维）；
- 重大节点（阶段完成）打 annotated tag，例如 `replan/phase-3-hooks`。

## 验收命令矩阵

| 阶段 | 命令 | 通过标准 |
|---|---|---|
| 1 | `cd packages/opencode && bun typecheck` | 0 error（或与基线对照不引入新 error） |
| 1 | `cd packages/opencode && bun test` | 0 fail（或仅基线已知 flaky） |
| 2 | `opencode --version`、`opencode --help`、`opencode`（裸启动） | 启动成功 + 进入 TUI |
| 2 | `opencode auth login github-copilot/github-proxy` | 流程顺畅，无重复密码提示 |
| 3 | `cd packages/opencode && bun test src/hook/` | 全部绿 |
| 3 | 用 CC 官方示例 hook 脚本绑定 PreToolUse 跑一次 chat | 脚本被 spawn，stdin/stdout 协议匹配 |
| 4 | `cd packages/opencode && bun test test/plugin/github-proxy/billing.test.ts` | 全绿 |
| 4 | 跑一次 chat，检查 proxy 后端日志 | turn-id 一致，N+1 HTTP 聚合为 1 条计费 |
| 5 | `opencode` 启动 TUI | 右下配额条出现，60s 内有真实数值 |

## 风险与回滚

| 风险 | 应对 |
|---|---|
| 上游基线 typecheck 不过 | 阶段 1 即上报，先修上游可见错误再继续 |
| Hook EPIPE 卡死主进程 | 严格遵守 02-hook-system.md §7 EPIPE 防护 |
| Copilot 计费意外多扣 | 阶段 4 上线前必须跑通计费铁律单测 + 实流量灰度 1 天 |
| TUI Slot 永久跳过 | 严格遵守 04-tui-quota-status.md §3 占位符规则 |
| `.upstream-merge/reference/` 与现网 plugin API 不兼容 | 视为参考实现，按当前 API 适配，不机械搬运 |

## 回滚策略

- 每阶段独立分支推进，验收失败回退到上阶段 tag；
- 不做 `git push --force` 到 dev/main；
- `.codex_plan/TODO.md` 全程跟踪状态，便于中断恢复。

## 不在本规划范围

- packages/sdk/web/console/desktop/app 的 fork 改造（按需另开规划）；
- 上游 PR 提交（缺陷规避先在本 fork 内消化，PR 单独排期）；
- Hook 系统的 `type: "mcp"` 支持（CC 自身在演进）；
- Copilot 计费后端实现（属于 github-copilot-proxy 项目，本仓只负责 client 端契约）。
