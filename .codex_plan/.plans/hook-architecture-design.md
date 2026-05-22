# Hook System Architecture — Fork-Friendly Extension Design

> **Status**: Design Document (Pre-Implementation)
> **Scope**: All functional hook development (non-UI, non-notification)
> **Constraint**: Must minimize cherry-pick conflict surface with upstream Claude Code

---

## 0. Critical Discovery: Tool Lifecycle Hooks Are Dead Code

**Before designing new features, we must address a foundational gap.**

### The Problem

The active tool execution path (`session/tools.ts` → `SessionTools.resolve`) fires **only** `plugin.trigger("tool.execute.before/after")`. It does **NOT** call `settingsHook.trigger()` for any tool lifecycle event.

The full PreToolUse / PostToolUse / PostToolUseFailure / FileChanged implementation exists in `session/prompt.ts` lines 543–889 (`SessionPrompt.resolveTools`), but this function is **never called** — it's dead code from a prior refactoring.

### Impact

| Hook Event | Schema | Trigger Call Site | Actually Fires? |
|---|---|---|---|
| `PreToolUse` | ✅ Defined | ❌ Dead code only | **NO** |
| `PostToolUse` | ✅ Defined | ❌ Dead code only | **NO** |
| `PostToolUseFailure` | ✅ Defined | ❌ Dead code only | **NO** |
| `FileChanged` | ✅ Defined | ❌ Dead code only | **NO** |
| `UserPromptSubmit` | ✅ Defined | ✅ prompt.ts:1817 | YES |
| `Stop` / `StopFailure` | ✅ Defined | ✅ prompt.ts:1913/1895 | YES |
| `PreCompact` / `PostCompact` | ✅ Defined | ✅ compaction.ts | YES |
| `PermissionRequest` / `Denied` | ✅ Defined | ✅ permission/index.ts | YES |
| `SessionStart` / `SessionEnd` | ✅ Defined | ⚠️ Partial | PARTIAL |
| `SubagentStart` / `SubagentStop` | ✅ Defined | ✅ task.ts | YES |
| `ConfigChange` | ✅ Defined | ✅ config-watcher.ts | YES |
| `WorktreeCreate` / `Remove` | ✅ Defined | ✅ worktree/index.ts | YES |
| `InstructionsLoaded` | ✅ Defined | ✅ prompt.ts:2134 | YES |
| `TaskCreated` / `TaskCompleted` | ✅ Defined | ✅ task.ts | YES |
| `TeammateIdle` | ✅ Defined | ❌ Never triggered | NO |
| `CwdChanged` | ✅ Defined | ❌ Never triggered | NO (see §6) |
| `Notification` | ✅ Defined | ❌ Never triggered | NO (not needed) |
| `Setup` | ✅ Defined | ❌ Never triggered | NO (low priority) |
| `Elicitation` / `ElicitationResult` | ✅ Defined | ❌ Never triggered | NO (depends on MCP) |

**Conclusion**: 4 of the 22 "fully wired" events are actually dead. This is the **P0 gap** — all other hook improvements build on tool lifecycle.

---

## 1. Architecture Overview

### 1.1 Design Principles

| Principle | Rule |
|---|---|
| **New files isolate** | All new functionality in `hook/extensions/` — upstream never has these files, cherry-picks **never conflict** |
| **Bridge points are shared** | One `ForkHooks` callback interface serves ALL fork extensions — settings.ts bridge surface is **fixed**, not growing |
| **Dependency is one-way** | `extensions/` imports types from `settings.ts`; `settings.ts` never imports from `extensions/`. Wiring happens in the Effect layer file |
| **Every bridge is marked** | `// [FORK:hook-ext]` comment on every bridge line |
| **FORK_POINTS.md is the map** | Living document listing every bridge point with intent + invariant + code snippet |

### 1.2 Directory Structure

```
src/hook/
├── settings.ts                 # Core engine (upstream-compatible + minimal bridges)
│   ├── ForkHooks interface     # ← NEW: ~15 lines, the only fork contract
│   ├── beforeRunEntry call     # ← NEW: 1 line in trigger()
│   └── afterRunEntry call      # ← NEW: 1 line in trigger()
│
├── extensions/                 # ← NEW: all fork extensions
│   ├── index.ts                # Assembles ForkHooks implementation
│   ├── condition-filter.ts     # if-condition evaluator
│   ├── hot-reload.ts           # Settings file hot reload
│   └── post-tool-batch.ts      # Batch tool completion tracker
│
├── session-hooks.ts            # Existing, no changes
├── agent-tools.ts              # Existing, no changes
└── start-context.ts            # Existing, no changes

src/session/
├── tools.ts                    # ← MODIFY: activate PreToolUse/PostToolUse hooks (P0)
└── prompt.ts                   # Dead code stays (reference for P0 port)
```

### 1.3 The ForkHooks Interface

This is the **single contract** between settings.ts and all fork extensions. It lives in `settings.ts` (upstream-compatible file) but is purely additive — upstream ignores it.

```typescript
// settings.ts — add after TriggerResult interface (~line 402)

/**
 * [FORK:hook-ext] Extension callback interface.
 * All fork-specific hook processing plugs in here.
 * settings.ts calls these at well-defined points; implementations
 * live in hook/extensions/ and are wired in the Effect layer.
 *
 * INVARIANT: Every field is optional. When undefined, behavior is
 * identical to upstream. This ensures forward-compat — if upstream
 * adds new hook features, they flow through without touching extensions.
 */
export interface ForkHooks {
  /**
   * Called BEFORE runEntry() for each matched hook entry.
   * Return false to skip this entry (e.g., `if` condition not met).
   * Return true (or undefined) to proceed.
   *
   * INTENT: Centralized pre-dispatch filtering for condition-filter,
   * future rate-limiting, logging, etc.
   */
  readonly beforeRunEntry?: (
    entry: HookCommand,
    envelope: Record<string, unknown>,
    event: HookEvent,
  ) => boolean

  /**
   * Called AFTER runEntry() for each executed hook entry.
   * Receives the handler result. Used for post-dispatch tracking
   * (batch counting, metrics, etc.).
   *
   * INTENT: Centralized post-dispatch observation. Never modifies
   * the result — that's the trigger reducer's job.
   */
  readonly afterRunEntry?: (
    entry: HookCommand,
    envelope: Record<string, unknown>,
    event: HookEvent,
    result: { json?: HookJSONOutput; exitBlock?: string },
  ) => void
}
```

### 1.4 Bridge Points in trigger()

Two lines added to the existing trigger() matcher loop:

```typescript
// settings.ts trigger() — inside the matcher loop, around line 1405

for (const entry of group.hooks) {
  // ... existing type guard (lines 1408-1415) ...

  // [FORK:hook-ext] Pre-dispatch filter
  if (forkHooks?.beforeRunEntry && !forkHooks.beforeRunEntry(entry, envelope, payload.event)) continue

  const { json, exitBlock } = yield* runEntry(entry, envelope, s.cwd, false)

  // [FORK:hook-ext] Post-dispatch observation
  forkHooks?.afterRunEntry?.(entry, envelope, payload.event, { json, exitBlock })

  // ... existing result aggregation (lines 1419-1474) ...
}
```

### 1.5 Layer Wiring

The ForkHooks implementation is assembled in the Effect layer (settings.ts line 1276+), which is already fork-modified:

```typescript
// settings.ts layer construction — add after handler registry (~line 1302)

// [FORK:hook-ext] Assemble fork middleware
const forkHooks: ForkHooks | undefined = buildForkHooks
  ? buildForkHooks({ sessionHooks })
  : undefined
```

The `buildForkHooks` factory is imported from `hook/extensions/index.ts` — a fork-only file that doesn't exist upstream.

---

## 2. P0: Activate Tool Lifecycle Hooks

### 2.1 Problem Statement

`session/tools.ts` (active path) wraps each tool's `execute` with `plugin.trigger("tool.execute.before/after")` but never calls `settingsHook.trigger()`. The dead code in `prompt.ts:543-889` has the full implementation.

### 2.2 Design: Port Hook Logic to Active Path

**Target file**: `session/tools.ts` (208 lines, fork-managed)

**Approach**: Add `settingsHook.trigger()` calls around `item.execute()` in the active `SessionTools.resolve`, porting the logic from the dead code.

**Changes to native tool execute** (around line 84-113):

```typescript
// session/tools.ts — native tool execute wrapper

execute(args, options) {
  return run.promise(
    Effect.gen(function* () {
      const ctx = context(args, options)

      // Plugin trigger (existing)
      yield* plugin.trigger(
        "tool.execute.before",
        { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
        { args },
      )

      // ── [FORK:tool-hooks] PreToolUse settings hook ──
      const settingsHook = yield* SettingsHook.Service
      const preHook = yield* settingsHook.trigger(
        { event: "PreToolUse", toolName: item.id, toolInput: args },
        { sessionID: ctx.sessionID, transcriptPath: "" },
      )

      // CC contract: deny/block/stop short-circuit before execution
      if (preHook.permissionDecision === "deny") {
        const reason = preHook.permissionDecisionReason ?? "Denied by hook"
        return { title: "", metadata: {}, output: `Hook denied: ${reason}` }
      }
      if (preHook.blocked) {
        return { title: "", metadata: {}, output: `Hook blocked: ${preHook.blocked.reason}` }
      }
      if (preHook.preventContinuation) {
        const reason = preHook.stopReason ?? "Hook requested stop"
        return { title: "", metadata: {}, output: `Hook stopped: ${reason}` }
      }

      // CC contract: updatedInput rewrites tool args
      const effectiveArgs = preHook.updatedInput ?? args

      // Execute tool (with PostToolUseFailure on error)
      const result = yield* item.execute(effectiveArgs, ctx).pipe(
        Effect.tapCause((cause) =>
          Effect.gen(function* () {
            const err = cause.reasons.find(Cause.isFailReason)?.error
            if (err === undefined) return
            if (err instanceof Permission.RejectedError || err instanceof Question.RejectedError) return
            yield* settingsHook.trigger(
              {
                event: "PostToolUseFailure",
                toolName: item.id,
                toolInput: effectiveArgs,
                error: err instanceof Error ? err.message : String(err),
              },
              { sessionID: ctx.sessionID, transcriptPath: "" },
            )
          }).pipe(Effect.ignore),
        ),
      )

      // ── [FORK:tool-hooks] PostToolUse settings hook ──
      const postHook = yield* settingsHook.trigger(
        {
          event: "PostToolUse",
          toolName: item.id,
          toolInput: effectiveArgs,
          toolResponse: result.output,
        },
        { sessionID: ctx.sessionID, transcriptPath: "" },
      )

      // ── [FORK:tool-hooks] FileChanged for edit/write ──
      if (item.id === "edit" || item.id === "write") {
        const filePath = (effectiveArgs as { filePath?: unknown }).filePath
        if (typeof filePath === "string") {
          yield* settingsHook
            .trigger(
              { event: "FileChanged", path: filePath, changeType: item.id },
              { sessionID: ctx.sessionID, transcriptPath: "" },
            )
            .pipe(Effect.ignore)
        }
      }

      // Aggregate hook additionalContexts
      const postContexts = postHook.preventContinuation ? [] : postHook.additionalContexts
      const hookContexts = [...preHook.additionalContexts, ...postContexts]

      const output = {
        ...result,
        output:
          hookContexts.length > 0
            ? result.output +
              hookContexts.map((c) => `\n<hook_additional_context>${c}</hook_additional_context>`).join("")
            : result.output,
        attachments: result.attachments?.map((attachment) => ({
          ...attachment,
          id: PartID.ascending(),
          sessionID: ctx.sessionID,
          messageID: input.processor.message.id,
        })),
      }

      // Plugin trigger (existing)
      yield* plugin.trigger(
        "tool.execute.after",
        { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
        output,
      )

      if (options.abortSignal?.aborted) {
        yield* input.processor.completeToolCall(options.toolCallId, output)
      }
      return output
    }),
  )
}
```

**Same pattern for MCP tools** (around line 125-201), with the addition of PreToolUse before `execute(args, opts)` and PostToolUse after.

### 2.3 Conflict Analysis

| File | Lines Changed | Conflict Risk | Notes |
|---|---|---|---|
| `session/tools.ts` | ~40 lines added | **LOW** | This file is fork-managed (not in upstream CC). Upstream doesn't have `SessionTools.resolve`. |
| `session/prompt.ts` | 0 (dead code stays as reference) | NONE | No changes to the dead code. |

### 2.4 Dependencies

- `session/tools.ts` needs to import `SettingsHook` from `@/hook/settings`
- `session/tools.ts` needs to import `Cause` from `effect`
- `session/tools.ts` needs to import `Permission.RejectedError` and `Question.RejectedError`

---

## 3. P1: Hot Reload (Settings File Watcher)

### 3.1 Problem Statement

Modifying any settings file (`.claude/settings.json`, `.opencode/settings.local.json`, etc.) requires restarting opencode for hooks to take effect.

### 3.2 Design

**New file**: `hook/extensions/hot-reload.ts` (~150 lines)

```typescript
// hook/extensions/hot-reload.ts
// [FORK:hook-ext] Settings file hot reload — not in upstream

import { Effect } from "effect"
import { watch, type FSWatcher } from "fs"
import path from "path"
import { existsSync } from "fs"
import * as Log from "@opencode-ai/core/util/log"
import type { Settings, HookEvent } from "../settings"

const log = Log.create({ service: "hook.extensions.hot-reload" })

/**
 * All settings file paths that participate in the hook chain.
 * Mirrors the 6-layer chain in settings.ts loadChain().
 */
function settingsFiles(projectDir: string): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
  return [
    path.join(home, ".claude", "settings.json"),
    // Layer 2: opencode global config (resolved at runtime)
    path.join(projectDir, ".claude", "settings.json"),
    path.join(projectDir, ".opencode", "settings.json"),
    path.join(projectDir, ".claude", "settings.local.json"),
    path.join(projectDir, ".opencode", "settings.local.json"),
  ].filter((f) => existsSync(f) || existsSync(path.dirname(f)))
}

export interface HotReloadHandle {
  /** Stop watching all files */
  close(): void
}

/**
 * Watch all settings files for changes. On change, call the reload
 * callback which should re-run loadChain() and update the state.
 *
 * Uses Node.js fs.watch (not @parcel/watcher) because:
 * 1. Settings files are few and stable — no need for recursive watching
 * 2. fs.watch is simpler and has lower overhead for individual files
 * 3. Avoids coupling to the FileWatcher service lifecycle
 *
 * Debounce: 500ms. Settings edits are human-driven; no need for
 * sub-second responsiveness. Prevents double-fire from save-as-you-type
 * editors.
 */
export function watchSettings(
  projectDir: string,
  reload: () => Effect.Effect<Settings>,
  onReload: (newSettings: Settings, changedFile: string) => void,
): HotReloadHandle {
  const watchers: FSWatcher[] = []
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let lastReload = 0

  const files = settingsFiles(projectDir)
  log.info("watching settings files", { files })

  for (const file of files) {
    try {
      const watcher = watch(file, { persistent: false }, (eventType) => {
        if (eventType !== "change") return

        // Debounce: 500ms
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          const now = Date.now()
          if (now - lastReload < 1000) return // Min 1s between reloads
          lastReload = now

          log.info("settings file changed, reloading", { file })
          // Fire-and-forget: reload errors are logged but never crash
          Effect.runPromise(reload()).then(
            (settings) => onReload(settings, file),
            (err) => log.warn("settings reload failed", { file, error: String(err) }),
          )
        }, 500)
      })
      watchers.push(watcher)
    } catch {
      // File doesn't exist yet — that's fine, it might be created later
      log.debug("skipping non-existent settings file", { file })
    }
  }

  return {
    close() {
      if (debounceTimer) clearTimeout(debounceTimer)
      for (const w of watchers) w.close()
      watchers.length = 0
    },
  }
}
```

### 3.3 Bridge Point

**NOT in settings.ts.** The bridge is in the Effect layer wiring, which is already fork-managed:

```typescript
// settings.ts layer construction — after state initialization (~line 1292)

// [FORK:hook-ext] Hot reload for settings files
const hotReload = watchSettings(
  state.cwd,  // project directory from InstanceState
  () => Effect.sync(() => loadChain(state.cwd, state.worktree)),
  (newSettings, changedFile) => {
    state.settings = newSettings
    log.info("settings hot-reloaded", { file: changedFile, hookCount: countHooks(newSettings) })
  },
)
// Cleanup on layer finalization
yield* Effect.addFinalizer(() => Effect.sync(() => hotReload.close()))
```

### 3.4 Concurrency Safety

| Concern | Mitigation |
|---|---|
| In-flight trigger reads old settings | Acceptable. trigger() reads `s.settings` at entry (line 1334). A concurrent reload swaps the reference. The in-flight trigger completes with the old settings — this is the same semantics as CC (no locking). |
| Session-scoped hooks reference old config | No issue. Session hooks are in-memory (session-hooks.ts), not file-derived. They survive reloads unchanged. |
| Handler instances cache old MCP/HTTP config | No issue. Handlers are stateless functions — they read `entry` fields (command, url, headers) from the current settings on every invocation. No caching. |

### 3.5 Conflict Analysis

| File | Lines Changed | Conflict Risk |
|---|---|---|
| `hook/extensions/hot-reload.ts` | ~150 lines (NEW) | **NONE** — file doesn't exist upstream |
| `hook/settings.ts` layer | ~5 lines added | **LOW** — layer construction is already fork-divergent |

---

## 4. P2: `if` Condition Filtering

### 4.1 Problem Statement

The `if` field on `HookCommand` is accepted in the schema but never evaluated at runtime. CC uses it for fine-grained matching like `Bash(npm install *)` or `Edit(*.ts)`.

### 4.2 Design

**New file**: `hook/extensions/condition-filter.ts` (~200 lines)

```typescript
// hook/extensions/condition-filter.ts
// [FORK:hook-ext] Hook if-condition evaluator — not in upstream

import type { HookCommand, HookEvent } from "../settings"

/**
 * Evaluate a hook entry's `if` condition against the runtime envelope.
 *
 * CC `if` syntax (subset we support):
 *
 * | Pattern                    | Matches when...                          |
 * |----------------------------|------------------------------------------|
 * | `Bash(npm install *)`      | tool_name="bash" AND command matches glob |
 * | `Edit(*.ts)`               | tool_name="edit" AND filePath matches glob |
 * | `Write(src/**)`            | tool_name="write" AND filePath matches glob |
 * | `Read(*.py)`               | tool_name="read" AND filePath matches glob |
 * | `*`                        | Always matches (wildcard)                |
 * | (empty/undefined)          | Always matches (no condition)            |
 *
 * The pattern is: `ToolName(arg_glob)` where ToolName is case-insensitive
 * and arg_glob is matched against the relevant tool_input field.
 *
 * For non-tool events (UserPromptSubmit, Stop, etc.), `if` is ignored
 * (always matches) — CC behavior.
 */
export function evaluate(
  entry: HookCommand,
  envelope: Record<string, unknown>,
  event: HookEvent,
): boolean {
  const condition = entry.if
  if (!condition || condition.trim() === "" || condition.trim() === "*") return true

  // Only tool events support condition filtering
  if (event !== "PreToolUse" && event !== "PostToolUse" && event !== "PostToolUseFailure") {
    return true
  }

  const toolName = (envelope.tool_name as string) ?? ""
  const toolInput = (envelope.tool_input as Record<string, unknown>) ?? {}

  // Parse: ToolName(arg_glob)
  const match = condition.match(/^(\w+)\((.+)\)$/)
  if (!match) {
    // Malformed condition — fail open (CC behavior: unknown conditions are truthy)
    return true
  }

  const [, condTool, condGlob] = match

  // Tool name match (case-insensitive)
  if (condTool.toLowerCase() !== toolName.toLowerCase()) return false

  // Arg glob match — depends on tool type
  const argValue = extractArgValue(toolName, toolInput)
  if (!argValue) return true // No extractable arg — fail open

  return globMatch(condGlob, argValue)
}

/**
 * Extract the primary argument value for glob matching.
 * - Bash/shell: the `command` field
 * - Edit/Write/Read: the `filePath` or `file_path` field
 * - Other tools: JSON.stringify of the entire input (best-effort)
 */
function extractArgValue(toolName: string, toolInput: Record<string, unknown>): string | undefined {
  const lower = toolName.toLowerCase()
  if (lower === "bash" || lower === "shell") {
    return (toolInput.command as string) ?? undefined
  }
  if (lower === "edit" || lower === "write" || lower === "read" || lower === "multiedit") {
    return (toolInput.filePath as string) ?? (toolInput.file_path as string) ?? undefined
  }
  // Fallback: stringify for glob matching
  return JSON.stringify(toolInput)
}

/**
 * Simple glob matching. Supports:
 * - `*` matches any sequence of non-separator characters
 * - `**` matches any sequence including separators
 * - `?` matches a single character
 *
 * This is a simplified implementation — CC uses a more sophisticated
 * glob engine, but this covers the 95% case.
 */
function globMatch(pattern: string, value: string): boolean {
  // Convert glob to regex
  let regex = "^"
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        regex += ".*"
        i++ // skip next *
      } else {
        regex += "[^/]*"
      }
    } else if (c === "?") {
      regex += "[^/]"
    } else if (".+^$|(){}[]\\".includes(c)) {
      regex += "\\" + c
    } else {
      regex += c
    }
  }
  regex += "$"
  try {
    return new RegExp(regex).test(value)
  } catch {
    return true // Invalid regex — fail open
  }
}
```

### 4.3 Bridge via ForkHooks

The condition filter plugs into `ForkHooks.beforeRunEntry`:

```typescript
// hook/extensions/index.ts

import { evaluate as evaluateCondition } from "./condition-filter"
import type { ForkHooks, HookCommand, HookEvent } from "../settings"

export function buildForkHooks(_deps: {
  sessionHooks: unknown
}): ForkHooks {
  return {
    beforeRunEntry(entry: HookCommand, envelope: Record<string, unknown>, event: HookEvent): boolean {
      // [FORK:hook-ext] if-condition filtering
      return evaluateCondition(entry, envelope, event)
    },
    // afterRunEntry: reserved for PostToolBatch (see §5)
  }
}
```

### 4.4 Conflict Analysis

| File | Lines Changed | Conflict Risk |
|---|---|---|
| `hook/extensions/condition-filter.ts` | ~200 lines (NEW) | **NONE** |
| `hook/extensions/index.ts` | ~20 lines (NEW) | **NONE** |
| `hook/settings.ts` | 0 additional lines | **NONE** — uses existing ForkHooks bridge |

---

## 5. P2: PostToolBatch

### 5.1 Problem Statement

When the LLM returns multiple tool_use blocks in a single response, the AI SDK executes them concurrently. Each tool fires `PostToolUse` individually, but there's no event for "all tools in this batch are done." Plugins that need batch-level visibility (e.g., "run lint after all file edits") have no hook point.

### 5.2 Design

**New file**: `hook/extensions/post-tool-batch.ts` (~120 lines)

```typescript
// hook/extensions/post-tool-batch.ts
// [FORK:hook-ext] Batch tool completion tracking — not in upstream

import type { HookCommand, HookEvent, HookJSONOutput } from "../settings"

interface BatchEntry {
  toolName: string
  success: boolean
  exitBlock?: string
}

/**
 * Tracks tool executions within a single LLM step and provides
 * batch-level visibility via ForkHooks.afterRunEntry.
 *
 * Architecture:
 * - The AI SDK executes tools concurrently within a single step
 * - Each tool fires PostToolUse individually through settings.ts trigger()
 * - This module counts PostToolUse events and exposes the batch state
 *
 * NOTE: This does NOT fire a synthetic "PostToolBatch" event (that would
 * require knowing when the batch ends, which the AI SDK doesn't expose).
 * Instead, it provides a queryable state that other fork extensions can
 * inspect.
 *
 * Future: If the AI SDK adds a "step complete" callback, we can fire
 * a real PostToolBatch event at that point.
 */

const batches = new Map<string, BatchEntry[]>()

export function recordToolExecution(
  sessionID: string,
  _entry: HookCommand,
  envelope: Record<string, unknown>,
  event: HookEvent,
  result: { json?: HookJSONOutput; exitBlock?: string },
): void {
  if (event !== "PostToolUse") return

  const toolName = (envelope.tool_name as string) ?? "unknown"
  const batch = batches.get(sessionID) ?? []
  batch.push({
    toolName,
    success: !result.exitBlock && result.json?.decision !== "block",
    exitBlock: result.exitBlock,
  })
  batches.set(sessionID, batch)
}

/** Get the current batch state for a session. */
export function getBatch(sessionID: string): readonly BatchEntry[] {
  return batches.get(sessionID) ?? []
}

/** Reset batch state (call at step boundary). */
export function resetBatch(sessionID: string): void {
  batches.delete(sessionID)
}
```

### 5.3 Bridge via ForkHooks

```typescript
// hook/extensions/index.ts — extended

import { recordToolExecution } from "./post-tool-batch"

export function buildForkHooks(_deps: {
  sessionHooks: unknown
}): ForkHooks {
  return {
    beforeRunEntry(entry, envelope, event) {
      return evaluateCondition(entry, envelope, event)
    },
    afterRunEntry(entry, envelope, event, result) {
      // [FORK:hook-ext] PostToolBatch tracking
      recordToolExecution("sessionID-from-envelope", entry, envelope, event, result)
    },
  }
}
```

### 5.4 Limitations

- **No synthetic event**: We can't fire a real `PostToolBatch` event because we don't know when the AI SDK's concurrent batch ends. The AI SDK doesn't expose a "all tools done" callback.
- **Queryable state only**: Other fork extensions can call `getBatch(sessionID)` to inspect the current batch, but there's no push notification.
- **Future improvement**: If we switch to a custom tool execution orchestrator (instead of delegating to AI SDK), we can fire real batch events.

### 5.5 Conflict Analysis

| File | Lines Changed | Conflict Risk |
|---|---|---|
| `hook/extensions/post-tool-batch.ts` | ~120 lines (NEW) | **NONE** |
| `hook/extensions/index.ts` | ~5 lines added | **NONE** |
| `hook/settings.ts` | 0 additional lines | **NONE** |

---

## 6. Dropped: CwdChanged

### 6.1 Why This Is Not Applicable

After code analysis, **CWD never changes during an opencode session**:

1. **Bash tool** (`tool/shell.ts`): Spawns child processes with `cwd` option — the child's CWD is set per-process, the host process CWD is unchanged.
2. **All `process.chdir()` calls** are in CLI startup code (`thread.ts:135`, `attach.ts:61`, `run.ts:316`) — one-time operations before any session exists.
3. **No tool or hook** ever calls `process.chdir()`.

CC's `CwdChanged` event is designed for interactive terminal sessions where the user's shell CWD can change. opencode's architecture doesn't have this — each Bash invocation is an isolated child process.

### 6.2 Recommendation

Keep `CwdChanged` in the `HookEvent` schema (for forward-compat with CC configs) but do not implement triggering. If a future feature needs CWD tracking (e.g., a persistent shell session), the event is already defined.

---

## 7. Complete Hook Event Status (Post-Implementation)

After implementing P0 + P1 + P2:

| Event | Status | Notes |
|---|---|---|
| `PreToolUse` | ✅ **ACTIVE** (P0) | Fires before each tool execution |
| `PostToolUse` | ✅ **ACTIVE** (P0) | Fires after each tool execution |
| `PostToolUseFailure` | ✅ **ACTIVE** (P0) | Fires on tool execution error |
| `FileChanged` | ✅ **ACTIVE** (P0) | Fires after edit/write tools |
| `UserPromptSubmit` | ✅ Active | Already working |
| `Stop` / `StopFailure` | ✅ Active | Already working |
| `PreCompact` / `PostCompact` | ✅ Active | Already working |
| `PermissionRequest` / `Denied` | ✅ Active | Already working |
| `SubagentStart` / `SubagentStop` | ✅ Active | Already working |
| `ConfigChange` | ✅ Active | Already working |
| `WorktreeCreate` / `Remove` | ✅ Active | Already working |
| `InstructionsLoaded` | ✅ Active | Already working |
| `TaskCreated` / `TaskCompleted` | ✅ Active | Already working |
| `SessionStart` | ⚠️ Partial | Schema defined, trigger exists but may need verification |
| `SessionEnd` | ⚠️ Partial | Schema defined, trigger may need verification |
| `CwdChanged` | ⚪ Schema only | Not applicable (see §6) |
| `Notification` | ⚪ Schema only | Not needed (user confirmed) |
| `Setup` | ⚪ Schema only | Low priority (CI/script scenario) |
| `TeammateIdle` | ⚪ Schema only | Never triggered |
| `Elicitation` / `ElicitationResult` | ⚪ Schema only | Depends on MCP elicitation |
| `PostToolBatch` | 🔵 Tracked (P2) | Queryable state via extensions, no synthetic event |

---

## 8. Implementation Order & Effort

| Phase | Task | New Files | Modified Files | Lines | Effort |
|---|---|---|---|---|---|
| **P0** | Activate tool lifecycle hooks | 0 | `session/tools.ts` | +80 | 2-3 hours |
| **P0** | Add ForkHooks interface + bridges | 0 | `hook/settings.ts` | +20 | 30 min |
| **P1** | Hot reload | `extensions/hot-reload.ts` | `hook/settings.ts` layer | +155 | 2 hours |
| **P2** | Condition filter | `extensions/condition-filter.ts`, `extensions/index.ts` | 0 | +220 | 2-3 hours |
| **P2** | PostToolBatch tracker | `extensions/post-tool-batch.ts` | `extensions/index.ts` | +125 | 1 hour |
| **Doc** | FORK_POINTS.md | 1 | 0 | +100 | 30 min |

**Total**: ~700 lines of new code, ~100 lines of modifications to existing files.

---

## 9. FORK_POINTS.md Template

```markdown
# Fork Bridge Points — Hook System

> After cherry-picking upstream changes, search for `[FORK:hook-ext]` in
> modified files to find all bridge points. Use this document to verify
> they're still in place.

## Convention

Every bridge line is marked: `// [FORK:hook-ext] <description>`
The tag `hook-ext` covers all hook extension features (hot-reload,
condition-filter, post-tool-batch, tool-hooks).

## hook/settings.ts

### ForkHooks interface (~line 402)
- **What**: `export interface ForkHooks { beforeRunEntry?, afterRunEntry? }`
- **Why**: Single contract between settings.ts and all fork extensions
- **Invariant**: All fields optional. Undefined = upstream behavior.

### beforeRunEntry call (trigger(), inside matcher loop, before runEntry)
- **What**: `if (forkHooks?.beforeRunEntry && !forkHooks.beforeRunEntry(...)) continue`
- **Why**: Pre-dispatch filtering (if-conditions, future rate-limiting)
- **Invariant**: Must be BEFORE `runEntry()`. Must `continue` on false.

### afterRunEntry call (trigger(), inside matcher loop, after runEntry)
- **What**: `forkHooks?.afterRunEntry?.(entry, envelope, event, { json, exitBlock })`
- **Why**: Post-dispatch observation (batch tracking, metrics)
- **Invariant**: Must be AFTER `runEntry()`. Must NOT modify result.

### forkHooks variable (layer construction, after handler registry)
- **What**: `const forkHooks = buildForkHooks ? buildForkHooks({...}) : undefined`
- **Why**: Wires extensions into the trigger pipeline
- **Invariant**: Must be `undefined` when buildForkHooks is not provided.

### Hot reload (layer construction, after state init)
- **What**: `watchSettings(...)` + `Effect.addFinalizer(...)`
- **Why**: Settings file hot reload
- **Invariant**: Must call `close()` on layer finalization.

## session/tools.ts

### PreToolUse trigger (native tool execute, before item.execute)
- **What**: `yield* settingsHook.trigger({ event: "PreToolUse", ... }, ...)`
- **Why**: Settings-file hooks for tool events
- **Invariant**: Must check deny/block/stop BEFORE executing tool.

### PostToolUse trigger (native tool execute, after item.execute)
- **What**: `yield* settingsHook.trigger({ event: "PostToolUse", ... }, ...)`
- **Why**: Post-execution hooks for observation/modification
- **Invariant**: Must fire even if tool returned error.

### PostToolUseFailure trigger (native tool execute, in tapCause)
- **What**: `yield* settingsHook.trigger({ event: "PostToolUseFailure", ... }, ...)`
- **Why**: Error reporting hooks
- **Invariant**: Must be in Effect.tapCause, must use Effect.ignore.

### FileChanged trigger (native tool execute, after PostToolUse)
- **What**: `yield* settingsHook.trigger({ event: "FileChanged", ... }, ...)`
- **Why**: File mutation tracking
- **Invariant**: Only for edit/write tools. Must use Effect.ignore.

### Same 4 hooks for MCP tools (MCP tool execute wrapper)
- **What**: Same pattern as native tools
- **Why**: MCP tools participate in the same hook lifecycle
- **Invariant**: PreToolUse fires BEFORE permission check (CC behavior).
```

---

## 10. Testing Strategy

### 10.1 Unit Tests

| Module | Test Focus |
|---|---|
| `condition-filter.ts` | Glob matching, tool name matching, fail-open semantics |
| `hot-reload.ts` | Debounce, file creation/deletion, reload callback |
| `post-tool-batch.ts` | Batch accumulation, reset, session isolation |
| `ForkHooks` interface | beforeRunEntry skip, afterRunEntry observation |

### 10.2 Integration Tests

| Scenario | Expected |
|---|---|
| `settings.json` with PreToolUse hook → tool execution | Hook fires, can deny/block |
| `settings.json` with PostToolUse hook → tool execution | Hook fires, receives tool output |
| `settings.json` with `if: "Bash(npm *)"` → bash `npm install` | Hook fires |
| `settings.json` with `if: "Bash(npm *)"` → bash `git status` | Hook skipped |
| Edit `settings.json` while session active | Hooks update without restart |
| Tool execution error → PostToolUseFailure | Hook fires with error message |
| edit tool → FileChanged | Hook fires with file path |

### 10.3 Regression Tests

- All existing hook tests pass unchanged
- `plugin.trigger("tool.execute.before/after")` still fires (not replaced by settings hooks)
- Settings without `if` field behave identically to before

---

## 11. Fork Maintenance Guidelines

### 11.1 When Cherry-Picking Upstream Changes

1. **Run `git diff` on `hook/settings.ts`** — check if upstream modified the trigger() function or HookCommand type
2. **Search for `[FORK:hook-ext]`** in the merged file — verify all bridge points survived
3. **If a bridge point was removed by upstream**: Re-apply it using FORK_POINTS.md as reference
4. **If upstream added new hook events**: They flow through automatically (ForkHooks fields are optional)
5. **If upstream restructured trigger()**: Re-identify the "before runEntry" and "after runEntry" positions, re-insert bridges

### 11.2 When Adding New Fork Extensions

1. **Create a new file in `hook/extensions/`** — never add logic to settings.ts
2. **Plug into ForkHooks** — use `beforeRunEntry` or `afterRunEntry`
3. **If ForkHooks needs a new callback**: Add it to the interface (optional field), update FORK_POINTS.md
4. **Never import from `extensions/` in settings.ts** — wire in the Effect layer

### 11.3 When Upstream Adds a New Handler Type

1. **Add to HookCommand.type union** — this is an upstream change, will come via cherry-pick
2. **Implement handler** — add to `hook/extensions/` or settings.ts (depending on complexity)
3. **Register in handler registry** — add to the `handlers` table in layer construction
4. **Update type guard in trigger()** — add the new type to the known-types list

---

## 12. Summary

| Aspect | Design Decision |
|---|---|
| **Architecture** | Shared ForkHooks callback interface, not per-feature bridges |
| **settings.ts bridge surface** | Fixed at ~20 lines (interface + 2 calls + layer wiring) |
| **New code location** | `hook/extensions/` directory (never conflicts with upstream) |
| **Dependency direction** | One-way: extensions → settings types, never reverse |
| **P0 priority** | Activate dead PreToolUse/PostToolUse/PostToolUseFailure/FileChanged |
| **P1 priority** | Hot reload via fs.watch on settings files |
| **P2 priority** | if-condition filtering + PostToolBatch tracking |
| **Dropped** | CwdChanged (CWD never changes in opencode architecture) |
| **Conflict resilience** | 2 bridge points in trigger() + 1 interface definition = 3 lines to re-apply after any upstream merge |
