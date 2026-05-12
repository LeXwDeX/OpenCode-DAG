# Air-gapped / 内网部署指南

本 fork 的 release 包已为内网/无外网环境做了开箱即用准备。
关键策略：把构建期可拿到的东西打包进二进制，把运行期会触发外网的开关交给配置。

## release 已经替你做了什么

1. **models.dev 快照已内嵌**
   `script/generate.ts` 在 build 时拉一次 `https://models.dev/api.json`，
   写到 `src/provider/models-snapshot.js`，编译到二进制内。
   运行时 `src/provider/models.ts` 会优先使用网络版本，拉取失败时回退到 snapshot。

2. **ripgrep 二进制已并排打包**
   `script/prefetch-ripgrep.ts` 在 CI 里把对应平台的 `rg`（Windows 上是 `rg.exe`）
   放进 `dist/opencode-<plat>/bin/`，与 `opencode` 同目录。
   运行时 `src/file/ripgrep.ts` 第一步 `which("rg")` 即命中，跳过 GitHub 下载。

## 部署清单

### 1. 解压并把 bin 加入 PATH

```bash
tar -xzf opencode-linux-x64.tar.gz -C /opt/opencode
export PATH="/opt/opencode:$PATH"   # bin 内同时有 opencode 和 rg
```

Windows：解压 `opencode-windows-x64.zip` 后把目录加到系统 PATH。

> ⚠️ 不要单独拷贝 `opencode` 而把 `rg` 丢掉。`which("rg")` 找不到时
> `Global.Path.bin/rg` 也找不到，就会发起 GitHub 下载并失败。

### 2. opencode.json 关闭主动外网

放在工程根目录或 `~/.config/opencode/config.json`：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": false,           // 关闭升级检查（installation 自动更新）
  "share": "disabled"            // 关闭 share，避免连 opncd.ai / app.opencode.ai
}
```

`autoupdate` 也可设为 `"notify"`，只提示不下载。

### 3. 环境变量（按需）

| 变量 | 作用 |
|---|---|
| `OPENCODE_DISABLE_MODELS_FETCH=1` | 禁用运行时每小时拉取 models.dev，强制使用内嵌 snapshot |
| `OPENCODE_DISABLE_AUTOUPDATE=1` | 等价于 `autoupdate: false` |
| `OPENCODE_DISABLE_LSP_DOWNLOAD=1` | 禁用 LSP server 按需下载（你本机应已手动装好 LSP） |
| `OPENCODE_MODELS_URL=https://内网网关/models` | 把 models.dev 指向内网镜像（覆盖 snapshot fallback） |
| `OPENCODE_MODELS_PATH=/path/to/api.json` | 直接读本地 api.json |

POSIX 系统建议在 `/etc/profile.d/opencode.sh` 或部署脚本里统一注入。

### 4. AI Provider 走内网网关

所有需要联网的 provider（OpenAI/Anthropic/Bedrock 等）在 opencode.json
的 `provider.<id>.options.baseURL` 中显式指向内网网关。详见
[官方 provider 配置](https://opencode.ai/docs/providers)。

未在配置里出现的 provider 不会被加载，因此不会产生连接。

## 还会发起外连的场景（请按业务判断）

- **Copilot / Codex OAuth**：登录流程仍要访问微软/OpenAI 域名。内网环境一般用 API key 而非 OAuth，关掉即可。
- **MCP web search 等用户自定义 MCP**：完全取决于你启用的 MCP，与本 fork 无关。
- **AI 推理调用**：本身就是 provider 网关流量，不在"无网络"讨论范围。

## 校验是否真的不外连

部署后跑一遍：

```bash
# 在断开外网的机器上
opencode --version
opencode run "hello"            # 触发 ripgrep 索引、models.dev 加载、provider 推理
```

如果任何一步阻塞超过 5 秒并报 `fetch failed` / `ENOTFOUND`，就是上面某项没配齐。
建议在测试机抓一次 `strace -f -e trace=connect`（Linux）或 Wireshark
确认实际出站连接清单与上文一致。

## 重新自打 release

如果需要为非官方平台或私有版本号重打：

```bash
# 在有外网的机器
cd packages/opencode
bun run script/build.ts --single --skip-install   # 生成 dist/opencode-<plat>/
bun run script/prefetch-ripgrep.ts                # 注入 rg
# 然后参照 .github/workflows/fork-release.yml 的 Package artifacts 步骤打包
```

`prefetch-ripgrep.ts` 支持的参数：

- `--only <dirName>`：只处理某一个 `dist/opencode-*` 目录
- `--version 15.1.0`：覆盖 ripgrep 版本（默认与 `src/file/ripgrep.ts` 中的常量一致）
