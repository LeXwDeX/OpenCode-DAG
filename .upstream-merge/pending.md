# Upstream Merge Plan

> Base: `3729fd57068445104ea464a952d41798ed30ea20` → Target: `upstream/dev`
> Generated: 2026-04-17
> Total commits: 330

## Summary

| Category | Count | Fork-conflict risk |
|----------|------:|---------------------|
| debug (P1) | 80 | 34 commits touch fork files |
| feature (P2) | 65 | 30 commits touch fork files |
| ui (P3) | 8 | 1 commit touches fork files |
| other (P4) | 177 | 42 commits touch fork files |
| **Total** | **330** | **107 risky** |

### High-risk fork files (most frequently touched)

| File | Touches |
|------|--------:|
| `packages/opencode/src/session/prompt.ts` | ~25 |
| `bun.lock` | ~25 |
| `packages/opencode/src/provider/provider.ts` | ~15 |
| `packages/opencode/src/session/llm.ts` | ~12 |
| `packages/opencode/src/tool/registry.ts` | ~10 |
| `packages/opencode/src/tool/bash.ts` | ~5 |
| `packages/opencode/src/plugin/index.ts` | ~6 |
| `packages/opencode/src/session/processor.ts` | ~7 |
| `packages/opencode/test/session/prompt-effect.test.ts` | ~12 |
| `packages/opencode/src/tool/tool.ts` | ~4 |

---

## debug (priority 1) — 80 commits

| SHA | Message | Fork files touched |
|-----|---------|-------------------|
| 39342b0e75 | tui: fix Windows terminal suspend and input undo keybindings | — |
| cb18f2ef40 | fix: ensure azure sets prompt cache key by default (#22957) | — |
| dbe2ff52b2 | fix tui otel profiling | — |
| 9db40996cc | fix build script | — |
| 86c54c5acc | fix(tui): minor logging cleanup (#22924) | — |
| ae584332b3 | fix: uncomment import (#22923) | — |
| 610c036ef1 | fix(opencode): use low reasoning effort for GitHub Copilot gpt-5 models (#22824) | — |
| 26af77cd1e | fix(core): fix detection of local installation channel (#22899) | — |
| 25a9de301a | core: eager load config on startup for better traces and refactor npm install for improved error reporting | — |
| 1c33b866ba | fix: remove 10 more unnecessary `as any` casts in opencode core (#22882) | `session/prompt.ts` |
| 5e650fd9e2 | fix(opencode): drop max_tokens for OpenAI reasoning models on Cloudflare AI Gateway (#22864) | — |
| 6c3b28db64 | fix: ensure that double pasting doesnt happen after tui perf commit was merged (#22880) | — |
| 2fe9d94470 | fix: remove 8 more unnecessary `as any` casts in opencode core (#22877) | — |
| bf4c107829 | fix: remove 7 unnecessary `as any` casts in opencode core (#22840) | — |
| 9afbdc102c | fix(test): make plugin loader theme source path separator-safe (#22870) | — |
| c60862fc9e | fix: add missing glob dependency (#22851) | `bun.lock` |
| c5deeee8c7 | fix: ensure azure has store = true by default (#22764) | — |
| b28956f0db | fix(core): better global sync event structure (#22858) | — |
| 305460b25f | fix: add a few more tests for sync and session restore (#22837) | — |
| 8c0205a84a | fix: align stale bot message with actual 60-day threshold (#22842) | — |
| cc7acd90ab | fix(nix): add shared package to bun install filters (#22665) | — |
| 2b1696f1d1 | Revert "tui: fix path comparison in theme installer to handle different path formats" | — |
| 8ab17f5ce0 | tui: fix path comparison in theme installer to handle different path formats | — |
| ef90b93205 | fix: restore .gitignore logic for config dirs and migrate to shared Npm service (#22772) | — |
| e2c0803962 | Fix desktop download asset names for beta channel (#22766) | — |
| 9f4b73b6a3 | fix: clean up final 16 no-unused-vars warnings (#22751) | `script/postinstall.mjs`; `session/llm.ts` |
| bd29004831 | feat: enable type-aware no-misused-spread rule, fix 8 violations (#22749) | — |
| 8aa0f9fe95 | feat: enable type-aware no-base-to-string rule, fix 56 violations (#22750) | `tool/apply_patch.ts` |
| 0e20382396 | fix: resolve circular sibling imports causing runtime ReferenceError (#22752) | `session/processor.ts`; `session/prompt.ts` |
| 80f1f1b5b8 | feat: enable type-aware no-floating-promises rule, fix all 177 violations (#22741) | `bun.lock`; `script/postinstall.mjs`; `test/session/prompt-effect.test.ts`; `test/session/snapshot-tool-race.test.ts` |
| 702f741267 | feat: enable oxlint suspicious category, fix 24 violations (#22727) | `script/postinstall.mjs`; `session/prompt.ts`; `tool/read.ts`; `tool/tool.ts` |
| cf423d2769 | fix: remove 10 unused type-only imports and declarations (#22696) | `test/session/prompt-effect.test.ts` |
| cce05c1665 | fix: clean up 49 unused variables, catch params, and stale imports (#22695) | `session/prompt.ts`; `tool/registry.ts` |
| 34213d4446 | fix: delete 9 dead functions with zero callers (#22697) | `script/postinstall.mjs` |
| d6b14e2467 | fix: prefix 32 unused parameters with underscore (#22694) | `provider/schema.ts`; `test/session/prompt-effect.test.ts` |
| f7d4665e40 | fix: resolve oxlint warnings — suppress false positives, remove unused imports (#22687) | `session/processor.ts`; `tool/edit.ts`; `tool/task.ts`; `tool/webfetch.ts`; `test/session/prompt-effect.test.ts`; `test/session/snapshot-tool-race.test.ts` |
| 6d42f97644 | fix: revert "core: move plugin initialisation to config layer override" (#22686) | — |
| 307251bf3c | fix: bash memory usage (#22660) | `tool/bash.ts`; `test/session/prompt-effect.test.ts` |
| 4ca809ef4e | fix(session): retry 5xx server errors even when isRetryable is unset (#22511) | — |
| a554fad232 | fix(tui): Don't overwrite the agent that was specified on the command line (#20554) | — |
| 672ee28635 | fix(opencode): avoid org lookup during config startup (#22670) | — |
| d2ea6700aa | fix(core): Remove dead code and documentation related to the obsolete list tool (#22672) | — |
| 348a84969d | fix: ensure tool_use is always followed by tool_result (#22646) | — |
| 9640d889ba | fix: register OTel context manager so AI SDK spans thread into Effect traces (#22645) | `bun.lock` |
| f1751401aa | fix(effect): add effect bridge for callback contexts (#22504) | `bun.lock`; `plugin/index.ts`; `provider/provider.ts`; `session/llm.ts`; `session/prompt.ts` |
| 47af00b245 | zen: better error | — |
| 5069cd9798 | fix(ui): disable accordion items for binary files and improve disabled state styling (#22577) | — |
| a992d8b733 | fix(snapshot): avoid ENAMETOOLONG and improve staging perf via stdin pathspecs (#22560) | — |
| 8d89c3417b | fix: prevent tooltip reopen on trigger click (#22571) | — |
| e24d104e94 | fix: update prompt input submit handler (#22566) | — |
| be3be32bf1 | fix(observability): handle OTEL headers with '=' in value (#22564) | — |
| 66de7bef89 | fix: add left padding to session title input (#22556) | — |
| 4246368a88 | fix(bootstrap): await plugin initialization | — |
| f44aa02e26 | fix(desktop): chdir to homedir on macOS to fix ripgrep issues (#22537) | — |
| 1ca9804604 | fix(desktop): start tauri shell commands from home directory (#22535) | — |
| f73ff781e7 | fix(opencode): export AI SDK telemetry spans (#22526) | `bun.lock`; `session/llm.ts` |
| 2c36bf9490 | fix(app): avoid bootstrap error popups during global sync init (#22426) | — |
| f6409759e5 | fix: restore instance context in prompt runs (#22498) | `session/prompt.ts`; `test/session/prompt-effect.test.ts` |
| f9d99f044d | fix(session): keep GitHub Copilot compaction requests valid (#22371) | `session/llm.ts` |
| aeb7d99d20 | fix(effect): preserve logger context in prompt runs (#22496) | `session/prompt.ts` |
| 3cf7c7536b | fix(question): restore flat reply sdk shape (#22487) | — |
| a53fae1511 | Fix diff line number contrast for built-in themes (#22464) | — |
| 4626458175 | fix(mcp): persist immediate oauth connections (#22376) | — |
| 9a5178e4ac | fix(cli): handlePluginAuth asks for api key only if authorize method exists (#22475) | — |
| ff60859e36 | fix(project): reuse runtime in instance boot (#22470) | — |
| a8f9f6b705 | fix(acp): stop emitting user_message_chunk during session/prompt turn (#21851) | — |
| d312c677c5 | fix: rm effect logger from processor.ts, use old logger for now instead (#22460) | `session/processor.ts` |
| 5b60e51c9f | fix(opencode): resolve ripgrep worker path in builds (#22436) | — |
| c2403d0f15 | fix(provider): guard reasoningSummary injection for @ai-sdk/openai-compatible providers (#22352) | — |
| a06f40297b | fix grep exact file path searches (#22356) | `tool/glob.ts`; `tool/grep.ts` |
| 79cc15335e | fix: dispose e2e app runtime (#22316) | `script/seed-e2e.ts` |
| cb1a50055c | fix(electron): wait until ready before showing the main window (#22262) | — |
| 34f5bdbc99 | app: fix scroll to bottom light mode style (#22250) | — |
| 0b4fe14b0a | fix: forgot to put alibaba case in last commit (#22249) | — |
| 26d35583c5 | sdk: throw error if response has text/html content type (#21289) | — |
| ae17b416b8 | fix(cli): auth login now asks for api key in handlePluginAuth (#21641) | — |
| 264418c0cd | fix(snapshot): complete gitignore respect for previously tracked files (#22172) | — |
| fa2c69f09c | fix(opencode): remove spurious scripts and randomField from package.json (#22160) | — |
| 113304a058 | fix(snapshot): respect gitignore for previously tracked files (#22171) | — |
| 8b9b9ad31e | fix: ensure images read by agent dont count against quota (#22168) | — |

---

## feature (priority 2) — 65 commits

| SHA | Message | Fork files touched |
|-----|---------|-------------------|
| c0bfccc15e | tooling: add unwrap-and-self-reexport + batch-unwrap-pr scripts (#22929) | — |
| a8d8a35cd3 | feat(core): pass auth data to workspace (#22897) | — |
| e0d71f124e | tooling: add collapse-barrel.ts for single-namespace barrel migration (#22887) | — |
| 8b1f0e2d90 | core: add documentation comments to plugin configuration merge logic | — |
| 378c05f202 | feat: Add support for claude opus 4.7 xhigh adaptive reasoning effort (#22833) | — |
| 6b20838981 | feat: unwrap provider namespaces to flat exports + barrel (#22760) | `provider/provider.ts`; `session/llm.ts`; `session/prompt.ts` |
| 5011465c81 | feat: unwrap tool namespaces to flat exports + barrel (#22762) | **20 fork files** (all tool/*.ts, session/prompt.ts, test files) |
| f6cc228684 | feat: unwrap cli-tui namespaces to flat exports + barrel (#22759) | — |
| c802695ee9 | docs: add circular import rules to namespace treeshake spec (#22754) | — |
| 509bc11f81 | feat: unwrap lsp namespaces to flat exports + barrel (#22748) | — |
| f24207844f | feat: unwrap storage namespaces to flat exports + barrel (#22747) | — |
| 1ca257e356 | feat: unwrap config namespaces to flat exports + barrel (#22746) | `session/prompt.ts` |
| d4cfbd020d | feat: unwrap effect namespaces to flat exports + barrel (#22745) | `session/prompt.ts`; `tool/skill.ts` |
| 581d5208ca | feat: unwrap share namespaces to flat exports + barrel (#22744) | — |
| a427a28fa9 | feat: unwrap project namespaces to flat exports + barrel (#22743) | — |
| 343a564183 | feat: unwrap 11 util namespaces to flat exports + barrel (#22739) | `provider/provider.ts`; `session/llm.ts`; `session/processor.ts`; `session/prompt.ts`; `tool/bash.ts`; `tool/registry.ts`; `test/*` |
| b0eae5e12f | feat: bridge permission and provider auth routes behind OPENCODE_EXPERIMENTAL_HTTPAPI (#22736) | — |
| 665a843086 | feat: unwrap Archive namespace to flat exports + barrel (#22722) | — |
| 1508196c0f | feat: bridge question routes from Hono to Effect HttpApi (#22718) | — |
| 379e40d772 | feat: unwrap InstanceState + EffectBridge namespaces (#22721) | `provider/provider.ts`; `session/llm.ts`; `session/prompt.ts`; `tool/glob.ts`; `tool/grep.ts`; `tool/registry.ts` |
| 60c927cf4f | feat: unwrap Pty namespace to flat exports + barrel (#22719) | — |
| 62ddb9d3ad | feat: unwrap uskill namespace (#22714) | — |
| 0b975b01fb | feat: unwrap ugit namespace (#22704) | — |
| bb90aa6cb2 | feat: unwrap uworktree namespace (#22717) | — |
| ce4e47a2e3 | feat: unwrap uformat namespace (#22703) | — |
| e3677c2ba2 | feat: unwrap upatch namespace (#22709) | — |
| a653a4b887 | feat: unwrap usync namespace (#22716) | — |
| f7edffc11a | feat: unwrap uglobal namespace (#22705) | — |
| dc16488bd7 | feat: unwrap uide namespace (#22706) | — |
| d7a072dd46 | feat: unwrap usnapshot namespace (#22715) | — |
| 5ae91aa810 | feat: unwrap uplugin namespace (#22711) | `plugin/index.ts` |
| 18538e359b | feat: unwrap usession namespace (#22713) | — |
| 47577ae857 | feat: unwrap upermission namespace (#22710) | — |
| d22b5f026d | feat: unwrap unpm namespace (#22708) | — |
| 26cdbc20b2 | feat: unwrap ufile namespace (#22702) | — |
| 360d8dd940 | feat: unwrap uinstallation namespace (#22707) | — |
| 426815a829 | feat: unwrap ucommand namespace (#22700) | — |
| c6286d1bb9 | feat: unwrap uenv namespace (#22701) | — |
| 710c81984a | feat: unwrap uauth namespace (#22699) | — |
| a1dbfb5967 | feat: unwrap uaccount namespace (#22698) | — |
| 5eae926846 | add experimental provider auth HttpApi slice (#22389) | `bun.lock` |
| 6625766350 | feat: unwrap MCP namespace (#22693) | — |
| 1d81335ab5 | feat: unwrap Provider namespace + improved automation script (#22690) | `provider/provider.ts`; `session/llm.ts`; `session/processor.ts`; `session/prompt.ts`; `tool/plan.ts`; `tool/registry.ts`; `test/*` |
| bbdbc107ae | feat: unwrap Config namespace (#22689) | `plugin/index.ts`; `provider/provider.ts`; `session/llm.ts`; `session/processor.ts`; `tool/registry.ts`; `tool/task.ts`; `test/*` |
| 02f2cf439e | feat: namespace → flat export migration (Bus proof-of-concept) (#22685) | — |
| 074ef032ee | feat(core): add fence to make all methods strongly consistent when syncing (#22679) | — |
| a147ad68e6 | feat(shared): add Effect-idiomatic file lock (EffectFlock) (#22681) | — |
| 3d6f90cb53 | feat: add oxlint with correctness defaults (#22682) | `bun.lock`; `provider/provider.ts`; `session/prompt.ts`; `tool/bash.ts` |
| 6bed7d469d | feat(opencode): improve telemetry tracing and request spans (#22653) | — |
| 250e30bc7d | add experimental permission HttpApi slice (#22385) | — |
| 5fc656e2a0 | docs(opencode): add instance context migration plan (#22529) | — |
| 685d79e953 | feat(opencode): trace tool execution spans (#22531) | `tool/tool.ts` |
| af20191d1c | feat(core): sync routes, refactor proxy, session restore, and more syncing (#22518) | — |
| 467e5689ec | feat(server): extract question handler factory | — |
| fba752a501 | feat(server): extract question httpapi contract | — |
| 60b8041ebb | zen: support alibaba cache write | — |
| 6706358a6e | feat(core): bootstrap packages/server and document extraction plan (#22492) | `bun.lock` |
| 3695057bee | feat: add --sanitize flag to opencode export (#22489) | — |
| f2525a63c9 | add experimental question HttpApi slice (#22357) | `tool/question.ts` |
| 34e2429c49 | feat: add experimental.compaction.autocontinue hook (#22361) | — |
| 43b37346b6 | feat: add interactive burst to the TUI logo (#22098) | `bun.lock` |
| bf50d1c028 | feat(core): expose workspace adaptors to plugins (#21927) | `plugin/index.ts` |
| 6fdb8ab90d | refactor(file): add ripgrep search service (#22295) | `tool/grep.ts` |
| 7230cd2683 | feat: add alibaba pkg and cache support (#22248) | `bun.lock`; `provider/provider.ts` |
| 3c0ad70653 | ci: enable beta branch releases with auto-update support | — |

---

## ui (priority 3) — 8 commits

No fork-file conflicts except:

| SHA | Message | Fork files touched |
|-----|---------|-------------------|
| 06afd33291 | refactor(tui): improve workspace management (#22691) | — |
| 0a8b6298cd | refactor(tui): move config cache to InstanceState (#22378) | — |

All 8 ui commits are low-risk. None touch fork-protected files directly.

Other ui commits (no fork conflict):
- `d6af5a686c` tui: convert TuiConfig namespace to ES module exports
- `79732ab175` refactor: unwrap UI namespace + self-reexport (#22951)
- `bfffc3c2c6` tui: ensure TUI plugins load with proper project context
- `e16589f8b5` tweak(ui): session spacing (#20839)
- `c98f616385` ui: update accordion styles and session review component (#22582)
- `3eb6508a64` refactor: share TUI terminal background detection (#22297)

---

## other (priority 4) — 177 commits

### Fork-conflict risk commits (42 total):

| SHA | Message | Fork files touched |
|-----|---------|-------------------|
| 266fb93422 | chore: generate | `session/prompt.ts` |
| 51d8219c46 | refactor: unwrap session/ tier-2 namespaces (#22973) | `session/llm.ts`; `session/processor.ts`; `session/prompt.ts` |
| cde105e7a8 | refactor: unwrap CopilotModels namespace (#22947) | `plugin/github-copilot/models.ts` |
| 5d47ea0918 | refactor: unwrap ConfigMCP namespace (#22948) | `provider/provider.ts`; `tool/tool.ts` |
| 9f201d6370 | release: v1.4.7 | `bun.lock` |
| 2638e2acfa | refactor: collapse plugin barrel (#22914) | `plugin/index.ts` |
| 370770122c | chore: generate | `bun.lock` |
| 143817d44e | chore: bump ai sdk deps for opus 4.7 (#22869) | `bun.lock` |
| 8b3b608ba9 | chore: generate | `bun.lock` |
| 97918500d4 | app: start migrating bootstrap data fetching to TanStack Query (#22756) | `bun.lock` |
| 675a46e23e | CLI perf: reduce deps (#22652) | `bun.lock`; `provider/provider.ts`; `session/llm.ts` |
| c8af8f96ce | chore: generate | `tool/registry.ts`; `tool/tool.ts` |
| 6c7e9f6f3a | refactor: migrate Effect call sites from Flock to EffectFlock (#22688) | — |
| 7baf998752 | chore: generate | `provider/provider.ts` |
| 4dd0d1f67e | refactor(opencode): use AppFileSystem path helpers (#22637) | `tool/edit.ts` |
| 4ae7c77f8a | migrate: move flock and hash utilities to shared package (#22640) | `bun.lock`; `provider/provider.ts` |
| be9432a893 | shared package (#22626) | `bun.lock` + **14 fork files** (tool/*.ts, session/*.ts, plugin/index.ts, test/*) |
| 627159acac | delete all e2e tests (#22501) | `bun.lock`; `script/e2e-local.ts`; `script/seed-e2e.ts`; `provider/provider.ts`; `tool/registry.ts` |
| d215188e4c | chore: generate | `bun.lock` |
| fb92bd470c | chore: generate | `bun.lock` |
| 7659321990 | release: v1.4.6 | `bun.lock` |
| dfc72838d7 | release: v1.4.5 | `bun.lock` |
| d25a7fbb2c | chore: bump ai sdk pkgs (#22539) | `bun.lock` |
| f73ff781e7 | (already in debug) | — |
| bddf830083 | release: v1.4.4 | `bun.lock` |
| 68384613be | refactor(session): remove async facade exports (#22471) | `script/seed-e2e.ts`; `session/prompt.ts`; `test/session/prompt-effect.test.ts` |
| 4f967d5bc0 | improve bash timeout retry hint (#22390) | `tool/bash.ts` |
| 020c47a055 | refactor(project): remove async facade exports (#22387) | `script/seed-e2e.ts` |
| d6840868d4 | refactor(ripgrep): use embedded wasm backend (#21703) | `bun.lock`; `session/prompt.ts`; `tool/glob.ts`; `tool/grep.ts`; `tool/skill.ts` |
| 6a99079012 | kit/env instance state (#22383) | `provider/provider.ts`; `tool/registry.ts`; `test/*` |
| a2cb4909da | refactor(plugin): remove async facade exports (#22367) | `plugin/index.ts` |
| e8471256f2 | refactor(session): move llm stream into layer (#22358) | `session/llm.ts` |
| d199648aeb | refactor(permission): remove async facade exports (#22342) | `session/llm.ts` |
| dcbf11f41a | refactor(session): remove summary async facades (#22337) | `session/processor.ts`; `session/prompt.ts`; `test/*` |
| 14ccff4037 | refactor(agent): remove async facade exports (#22341) | `tool/registry.ts` |
| f7c6943817 | refactor(config): remove async facade exports (#22325) | `script/seed-e2e.ts` |
| 663e798e76 | refactor(provider): remove async facade exports (#22320) | `provider/provider.ts`; `test/*` |
| 79cc15335e | fix: dispose e2e app runtime (#22316) | `script/seed-e2e.ts` |
| 9ae8dc2d01 | refactor: remove ToolRegistry runtime facade (#22307) | `script/seed-e2e.ts`; `tool/registry.ts` |
| 94f71f59a3 | core: make InstanceBootstrap into an effect (#22274) | `script/seed-e2e.ts` |
| 6fdb8ab90d | refactor(file): add ripgrep search service (#22295) | `tool/grep.ts` |
| 321bf1f8e1 | refactor: finish small effect service adoption cleanups (#22094) | `provider/provider.ts` |
| 8ffadde85c | chore: rm git ignored files (#22200) | `provider/models-snapshot.d.ts`; `provider/models-snapshot.js` |
| 6ce5c01b1a | ignore: v2 experiments | `.opencode/.gitignore`; `bun.lock` |

Remaining 135 "other" commits are low-risk (no fork files touched). Major themes:
- ~45 `chore: generate` / `chore: update nix node_modules hashes`
- ~40 `refactor: unwrap * namespace` / `collapse * barrel`
- ~10 `release: v1.4.*`
- ~10 `refactor(*): remove async facade exports`
- Misc: zen, sync, docs, ci, ignore, tweak

---

## Merge Strategy Notes

1. **Highest conflict zone**: The namespace unwrap wave (`feat: unwrap *`) systematically rewrites imports across all fork files. Commit `5011465c81` alone touches **20 fork files**. These should be applied as a batch after rebasing fork changes.

2. **`bun.lock`**: Touched by ~25 commits. Do NOT cherry-pick — regenerate after merge by running `bun install`.

3. **`session/prompt.ts`** and **`provider/provider.ts`**: Most heavily touched fork files. Manual 3-way merge required.

4. **`shared package` (`be9432a893`)**: Major structural change touching 14+ fork files. Apply early as foundation.

5. **Recommended batch order**:
   - Batch 1 (debug P1): Safe fixes first — skip bun.lock-only, prioritize runtime fixes
   - Batch 2 (feature P2): Namespace unwrap wave as a single batch
   - Batch 3 (other P4): Refactor + chore (most are auto-mergeable)
   - Batch 4 (ui P3): Low risk, apply last
   - Final: `bun install` to regenerate `bun.lock`
