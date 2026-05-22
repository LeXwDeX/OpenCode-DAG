# Fork Bridge Points — Hook Extensions

> **Purpose**: Document every fork-specific injection point in the hook system.
> When cherry-picking upstream changes, search for `[FORK:hook-ext]` and
> `[FORK:tool-hooks]` tags to find all bridge points that must be preserved.

## Architecture Overview

```
settings.ts (upstream-compatible core)
  ├── ForkHooks interface          ← [FORK:hook-ext] exported type
  ├── buildForkHooks import        ← [FORK:hook-ext] single import
  ├── forkHooks variable           ← [FORK:hook-ext] in layer construction
  ├── beforeRunEntry bridge        ← [FORK:hook-ext] in trigger() loop
  └── afterRunEntry bridge         ← [FORK:hook-ext] in trigger() loop

hook/extensions/ (fork-only directory)
  ├── index.ts                     ← assembles ForkHooks, exports buildForkHooks
  ├── condition-filter.ts          ← if-condition evaluator
  ├── post-tool-batch.ts           ← batch tool execution tracker
  └── hot-reload.ts                ← settings file watcher

session/tools.ts (upstream-compatible core + fork hooks)
  ├── SettingsHook import          ← [FORK:tool-hooks]
  ├── Cause, Question imports      ← [FORK:tool-hooks]
  ├── settingsHook service         ← [FORK:tool-hooks] yield* acquisition
  ├── PreToolUse (native)          ← [FORK:tool-hooks] before item.execute
  ├── PostToolUseFailure (native)  ← [FORK:tool-hooks] Effect.tapCause
  ├── PostToolUse (native)         ← [FORK:tool-hooks] after item.execute
  ├── FileChanged (native)         ← [FORK:tool-hooks] for edit/write tools
  ├── PreToolUse (MCP)             ← [FORK:tool-hooks] before execute
  ├── PostToolUseFailure (MCP)     ← [FORK:tool-hooks] Effect.tapCause
  ├── PostToolUse (MCP)            ← [FORK:tool-hooks] after execute
  └── abort check relocation       ← moved before hooks to fix cancel race

session/prompt.ts (upstream-compatible core)
  ├── SettingsHook provideService   ← [FORK:tool-hooks] in SessionTools.resolve pipe
  └── runLoop type annotation       ← removed to expose dependency chain
```

## Search Tags

| Tag | Meaning | Files |
|-----|---------|-------|
| `[FORK:hook-ext]` | ForkHooks extension bridge | `settings.ts`, `extensions/*` |
| `[FORK:tool-hooks]` | Tool lifecycle hook activation | `tools.ts`, `prompt.ts` |

## Bridge Point Details

### BP-1: ForkHooks Interface (`settings.ts`)

**Location**: After `TriggerResult` interface, before `agentToPermissionMode`

**What**: Exported `ForkHooks` interface with two optional callbacks:
- `beforeRunEntry(entry, envelope, event) → boolean` — pre-dispatch filter
- `afterRunEntry(entry, envelope, event, result) → void` — post-dispatch observation

**Cherry-pick risk**: LOW. Additive type definition. Upstream won't touch this area.

### BP-2: buildForkHooks Import (`settings.ts`)

**Location**: Import section, after `SessionID` import

**What**: `import { buildForkHooks } from "./extensions"`

**Cherry-pick risk**: MEDIUM. Upstream may add imports nearby. Keep this as the last import.

### BP-3: forkHooks Variable (`settings.ts`)

**Location**: In `layer` construction, after `handlers` registry

**What**: Creates `forkHooks` from `buildForkHooks({ sessionHooks })` or `undefined`

**Cherry-pick risk**: LOW. Inserted between handler registry and `runEntry` function.

### BP-4: beforeRunEntry Bridge (`settings.ts`)

**Location**: In `trigger()` inner loop, after type guard, before `runEntry()`

**What**: `if (forkHooks?.beforeRunEntry && !forkHooks.beforeRunEntry(...)) continue`

**Cherry-pick risk**: HIGH. This is inside the trigger reducer loop. Upstream refactors
of the matcher loop may move or restructure this area. Always verify after cherry-pick.

### BP-5: afterRunEntry Bridge (`settings.ts`)

**Location**: In `trigger()` inner loop, immediately after `runEntry()` returns

**What**: `forkHooks?.afterRunEntry?.(entry, envelope, payload.event, { json, exitBlock })`

**Cherry-pick risk**: HIGH. Same area as BP-4. Keep both bridges adjacent.

### BP-6: Tool Lifecycle Hooks (`session/tools.ts`)

**Location**: Inside `resolve()` function, wrapping `item.execute()` for both native and MCP tools

**What**: Full PreToolUse → execute → PostToolUseFailure → PostToolUse → FileChanged chain

**Critical invariant**: The abort check (`options.abortSignal?.aborted`) MUST run
immediately after `item.execute()` returns, BEFORE any PostToolUse hooks. This prevents
a cancel race where the abort signal interrupts the hook Effect, skipping `completeToolCall`.

**Cherry-pick risk**: HIGH. The `resolve()` function is actively developed upstream.
Every cherry-pick must verify:
1. Abort check is immediately after `item.execute()`
2. `SettingsHook.Service` is in the `provideService` pipe in `prompt.ts`
3. `Cause` and `Question` imports are present

### BP-7: SettingsHook provideService (`session/prompt.ts`)

**Location**: In `runLoop`, inside `SessionTools.resolve(...).pipe(...)` chain

**What**: `Effect.provideService(SettingsHook.Service, settingsHook)`

**Cherry-pick risk**: MEDIUM. The pipe chain may gain new services upstream.
Keep this as the last `provideService` call.

### BP-8: Exported Types (`settings.ts`)

**Location**: `HookCommand` and `Settings` interfaces

**What**: Changed from `interface` to `export interface` for use by extensions

**Cherry-pick risk**: LOW. Upstream may or may not export these; if they do, no conflict.

## Extension Modules

### condition-filter.ts

Evaluates `if` field on HookCommand entries. Supports:
- `ToolName(arg_glob)` patterns (e.g., `Bash(npm install *)`, `Edit(*.ts)`)
- Wildcard `*` (always matches)
- Fail-open on malformed conditions (CC behavior)

### post-tool-batch.ts

Tracks tool executions per session. Provides:
- `recordToolExecution()` — called from `afterRunEntry`
- `getBatch(sessionID)` — query current batch state
- `resetBatch(sessionID)` — clear at step boundary
- `getBatchCount(sessionID)` — count tools in current batch

### hot-reload.ts

Watches settings files for changes using `fs.watch`. Features:
- 500ms debounce (human-driven edits)
- 1s minimum between reloads
- Fire-and-forget reload (errors logged, never crash)
- Watches all 6 layers of the settings chain

**Status**: Implemented but NOT yet wired into the layer. To activate:
1. Import `watchSettings` in `settings.ts` layer construction
2. Call `watchSettings(projectDir, reload, onReload)` after state init
3. In `onReload`, update the state atomically

## Testing

All changes verified with:
- `bun run typecheck` — 14/14 packages pass
- `bun test test/hook/ test/goal/ test/provider/transform.test.ts test/session/prompt.test.ts` — 390/390 pass

## Upstream Compatibility Notes

- The `ForkHooks` interface is **additive** — when `undefined`, behavior is identical to upstream
- The `extensions/` directory is **isolated** — no upstream file imports from it (except `settings.ts` via BP-2)
- Tool lifecycle hooks in `tools.ts` are **interleaved** with upstream code — highest cherry-pick risk
- The abort check relocation is a **bugfix** that upstream may independently discover and fix
