# Sandbox Tool — Design Spec

## 1. Goal

Add a built-in, prompt-driven **sandbox** tool that lets the model write, run, and
debug code in isolated scratch workspaces, in real time, across scripting and
compiled languages (Python, TypeScript/JS, Go, Rust, C, C++, …).

The tool is designed to drive the **orchestrator-workers + parallelization**
pattern (Anthropic, *Building Effective Agents*):

- The **main agent is the orchestrator**: it decomposes a large task and fans it
  out to many sandbox **workers** running concurrently.
- Each **sandbox is an isolated scratch/draft zone** — the worker writes code,
  runs it, and reads LSP diagnostics there.
- The orchestrator reviews each sandbox's output + diagnostics + run results,
  and only then **merges the verified code into real project files** with the
  existing `write` / `edit` tools.
- Sandbox code never lands in the project automatically. Merge is an explicit
  orchestrator step.

Performance target: opening ~100 sandboxes concurrently must be cheap
(millisecond-level start, no per-sandbox VM/container).

## 2. Decisions (locked)

| Topic | Decision |
| --- | --- |
| Host platforms | macOS, Linux, WSL. Windows-native not required. |
| Isolation vs perf | Performance-first, **light isolation** (trusted-code level). No microVM/container by default. |
| Backend | **Host process sessions**: per-sandbox working directory + fresh process per command, reusing host toolchains. |
| Lifecycle | **Stateful keep-alive**: `sandbox_id` reuses a persistent workdir. `ephemeral=true` deletes the workdir after the call. |
| Statefulness model (v1) | **Persistent workdir** (filesystem = state). Persistent process / PTY REPL memory deferred to v2. |
| Form factor | **Built-in core tool** under `packages/opencode/src/tool/sandbox/`, gated by an experimental flag. |
| Workspace location | `<project>/.opencode/sandboxes/<id>/` (inside project tree, gitignored) so the existing LSP picks it up with zero extra wiring. |
| Languages | Scripting (python/node/ts via bun or tsx) + compiled (go/rust/c/cpp), detected via `which`. |
| Env init | Model decides; persistent workdir lets it run `venv` / `npm i` / `cargo init` once and reuse. Optional `setup` param runs once on create. |
| LSP | Wire opencode LSP: `touchFile(file,"full")` + `diagnostics()` surfaced in tool output. |

## 3. Mental model & prompt strategy

`sandbox.txt` (the tool description) is the primary lever — per Anthropic's ACI
guidance, it gets as much engineering attention as the tool code itself.

It MUST encode:

1. **Mandatory concurrency for large tasks** — "When a task spans multiple
   files/modules, you MUST use the sandbox tool to write the parts concurrently
   (sectioning). Emit multiple sandbox calls in a single message to run them in
   parallel; do not write large multi-file work serially."
2. **Orchestrator discipline** — "You are the orchestrator. Inspect each
   sandbox's output and LSP diagnostics. Only merge verified code into real
   files with `write`/`edit`. Sandbox code does NOT enter the project on its
   own."
3. **ACI poka-yoke** — require absolute paths, give worked examples, name params
   so misuse is hard.
4. **Tool boundaries** —
   - `sandbox` = isolated draft/trial + run + diagnostics (scratch).
   - `write`/`edit` = land final code in real project files.
   - `task` = spawn a sub-agent for research/multi-step reasoning.
   - Single-file small edits → use `write`/`edit` directly, not sandbox.

## 4. Tool surface

### 4.1 `sandbox` parameters (effect `Schema.Struct`)

```
sandbox_id?  : string   // omit = create a new sandbox; provide = reuse a kept-alive one
language     : enum      // "python" | "node" | "ts" | "bash" | "go" | "rust" | "c" | "cpp" | ...
files?       : record    // { "<relpath>": "<content>" } written into the workspace before run
command      : string    // command to compile/run/debug inside the workspace
setup?       : string    // optional one-time init command, only on first create (venv/npm i/...)
ephemeral?   : boolean   // default false (keep-alive). true = destroy workspace after this call
background?  : boolean   // default false. true = async via BackgroundJob; poll with sandbox_status
timeout?     : PositiveInt // ms; default from RuntimeFlags (same default as shell)
diagnostics? : boolean   // default true. run LSP touchFile + diagnostics on written files
```

### 4.2 Output / metadata

```
output: combined stdout/stderr (truncated + spilled to file via Truncate),
        plus an <lsp_diagnostics> block listing type errors/warnings,
        plus sandbox_id (for reuse) and workspace path.
metadata: { sandbox_id, workspace, language, exit, diagnostics, truncated, outputPath? }
```

### 4.3 Companion tool `sandbox_status`

Mirror of `task_status`: `sandbox_status(sandbox_id, wait?)` to poll/await a
`background=true` run. Gated by the same experimental flag.

## 5. Architecture

```
packages/opencode/src/tool/sandbox/
  id.ts        // ToolID = "sandbox", permission key
  prompt.ts    // parameterSchema + render(); imports sandbox.txt
  sandbox.txt  // the prompt (concurrency mandate + orchestrator discipline + ACI)
  manager.ts   // SandboxManager Effect Service (the pool)
  index.ts     // SandboxTool = Tool.define(...)  + SandboxStatusTool
```

### 5.1 `SandboxManager` service (models `background/job.ts`)

```
State = {
  sandboxes: SynchronizedRef<Map<string, LiveSandbox>>
  scope: Scope.Scope            // long-running fibers (background runs) live here
}
LiveSandbox = {
  id: string
  workspace: string             // <project>/.opencode/sandboxes/<id>
  language: string
  created_at: number
  last_used_at: number
  initialized: boolean          // setup ran?
}
```

- Held in `InstanceState.make<State>` → keyed per project `directory`, auto-
  invalidated (disposer) when the instance closes, so workspaces are reclaimed.
- `SynchronizedRef.modifyEffect` keeps Map mutations atomic under ~100 concurrent
  creates.
- API: `create / get / run / runBackground / destroy / list / gc`.
- `gc`: LRU cap + idle TTL to bound disk/handles when the model opens many.

### 5.2 Execution (models `shell.ts`)

- `ChildProcessSpawner` spawns a fresh process per `command`, `cwd = workspace`.
- Stream stdout/stderr → `ctx.metadata` for live progress.
- `ctx.abort` → kill tree (reuse `Shell.killTree`).
- `Truncate` → cap output, spill full log to file.
- `timeout` race → kill on expiry (same logic as shell `run`).

### 5.3 Env init flow

1. On create: `mkdir -p` workspace.
2. If `setup` provided and `!initialized`: run it once, mark `initialized`.
3. Write `files` into workspace (absolute path = `path.join(workspace, rel)`).
4. Run `command`.
5. If `diagnostics`: for each written file, `lsp.touchFile(file,"full")` then
   `lsp.diagnostics()`, filter to workspace files, append `<lsp_diagnostics>`.
6. If `ephemeral`: `rm -rf workspace` and drop from the Map.

### 5.4 LSP integration

- Workspace lives inside the project worktree, so existing LSP clients cover it.
- Use `LSP.Service`: `hasClients(file)` → skip if none; else `touchFile` +
  `diagnostics()`.
- Reuse `assertExternalDirectoryEffect` semantics; since workspace is in-tree,
  no external-dir prompt is needed.
- For compiled languages a minimal project marker (`go.mod`, `Cargo.toml`,
  `tsconfig.json`) created via `setup` improves diagnostics quality; the prompt
  guides the model to do this.

### 5.5 Background mode (reuses `BackgroundJob.Service`)

- `background=true` → `background.start({ id: sandbox_id, type:"sandbox", run })`,
  return immediately with `sandbox_id`. `sandbox_status` polls via
  `background.wait`.

### 5.6 Permission

- New string permission key `"sandbox"`.
- `ctx.ask({ permission:"sandbox", patterns:[language, command], always:[`${language} *`], metadata })`.
- Users can allow via config (`permission: { sandbox: "allow" }`).

## 6. Registration & rollout (`registry.ts`)

- `import { SandboxTool } from "./sandbox"` (+ `SandboxStatusTool`).
- `Tool.init` in the `Effect.all({...})` block.
- Add to `builtin[]` behind `flags.experimentalSandbox`
  (`OPENCODE_EXPERIMENTAL_SANDBOX=true`), like `experimentalLspTool`.
- `SandboxManager` gets a layer + `defaultLayer`, provided into the registry's
  `defaultLayer` (add to the `Layer.provide(...)` chain).

## 7. Gitignore

Ensure `.opencode/sandboxes/` is ignored (workspaces are scratch). Add to the
project `.gitignore` (or write the directory under a path already ignored).

## 8. Phasing

- **v1**: persistent workdir + fresh-process-per-command, all listed languages,
  LSP diagnostics, concurrent fan-out, background mode, prompt-driven
  orchestration. No persistent process.
- **v2**: optional persistent process / PTY (`node-pty`) for REPL in-memory state
  (`python -i`, node REPL); sentinel protocol for command completion + exit code.
- **v3 (optional)**: pluggable strong-isolation backend (container/microVM) behind
  the same `SandboxManager` interface for untrusted code.

## 9. Open items to confirm during implementation

- Exact `language` enum + runtime detection table (`which` probes + fallbacks,
  e.g. ts → `bun` then `tsx` then `ts-node`).
- LRU cap / idle TTL defaults for `gc`.
- Whether `sandbox_status` ships in v1 or only with background mode enabled.
- Diagnostics wait strategy (LSP diagnostics are async/push; may need a short
  settle window after `touchFile` before `diagnostics()`).
