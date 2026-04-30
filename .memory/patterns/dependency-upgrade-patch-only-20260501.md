# patch-only 依赖批量升级模式

## 触发场景
- 用户要求"做完依赖升级就结束"或类似批量升级指令
- 本 fork 决策保守，但需把可控范围内的 patch 升级一次性应用

## 决策树（按 semver 风险分级）

| 级别 | 判定 | 默认动作 |
|---|---|---|
| PATCH | major+minor 相同，仅最后一段动 | 默认升级 |
| MINOR | major 相同，minor 动 | 默认跳过（除非用户明确要求 + 有迁移指南） |
| MAJOR | major 跨度 | 默认跳过 |
| beta→stable | 即使数字像 patch | 当成 minor/major 处理 |
| 被 patches/ 锁定 | `patchedDependencies` 中有条目 | 必须跳过，否则补丁失效 |
| dev nightly | 半年以上跨度 | 跳过（行为可能漂移） |

## 标准流程

```bash
# 1. 盘点 outdated（package 内运行）
cd packages/opencode && bun outdated
```

```bash
# 2. 用 awk 按 semver 分级（在 packages/opencode 下跑）
bun outdated 2>&1 | rg "^\|" | rg -v "Package|---|Current" | \
  awk -F '|' '{gsub(/ /,"",$2); gsub(/ /,"",$3); gsub(/ /,"",$5); print $2, $3, $5}' | \
  awk '{
    split($2,c,"."); split($3,l,".");
    if (c[1]==l[1] && c[2]==l[2]) print "PATCH:", $0;
    else if (c[1]==l[1]) print "MINOR:", $0;
    else print "MAJOR:", $0;
  }' | sort
```

## 应用版本变更：用 Python，**不要用** sed/perl

`@scope/pkg` 中的 `/`、`.` 在 shell+sed/perl 引号里非常容易爆掉。
最稳的路径是 JSON 解析后写回（保留格式）：

```python
# /tmp/bump-deps.py
import json, pathlib
PATCHES = {pkg: (frm, to) for pkg, frm, to in [line.split("|") for line in open("/tmp/patches.txt")]}
def walk(node, parent_key=None):
    if isinstance(node, dict):
        for k, v in list(node.items()):
            if isinstance(v, str) and k in PATCHES:
                frm, to = PATCHES[k]
                if v == frm:
                    node[k] = to
            else:
                walk(v, k)
    elif isinstance(node, list):
        for x in node: walk(x, parent_key)

for f in [pathlib.Path("package.json"), pathlib.Path("packages/opencode/package.json")]:
    data = json.loads(f.read_text())
    walk(data)
    f.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
```

> **重要**：opencode 的 package.json 用 2-space indent + 末尾换行，
> Python 的 `json.dumps(..., indent=2)` + 手动追加 `\n` 即可保留原格式。
> diff 应该只动版本号行，不动其他空白/字段顺序。

## 升级后必跑

1. `bun install` — 看 install summary，确认无 peer warning 爆增
2. `bun run typecheck` (单包) → 处理 stale `@ts-expect-error`：
   - 例：`@lydell/node-pty 1.2.0-beta.10 → beta.12` 自带类型，要删 `pty.node.ts:1` 的 `@ts-expect-error`
3. `bun test` (单包) — 全量回归
4. `git push` 触发 `bun turbo typecheck` (13 包)

## opencode 仓库特定坑

- `package.json` 用 pnpm-style `workspaces.catalog`，部分包版本在 root 而非 sub-package
- `patchedDependencies` 列出 3 包：`@npmcli/agent@4.0.0` / `@standard-community/standard-openapi@0.2.9` / `solid-js@1.9.10` — 升级前必须确认这些不在升级列表
- `bun outdated` 的 `Update` 列若等于 `Current`，意味着 package.json 用了精确 pin（无 caret），`bun update` 不会动，必须显式改 package.json

## 验证基线

opencode 在 v1.14.30 fork 基线上：
- `bun test` 应得 ~2274~2276 pass / 0~1 fail（runner.test.ts 5s 偶发 timeout 是环境性，单跑通过即非回归）
- `bun typecheck` 应完全干净
