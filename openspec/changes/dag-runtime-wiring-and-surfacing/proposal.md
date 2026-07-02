## Why

The DAG workflow engine (`dag-workflow-dev-integration`, marked complete 62/62) is **functionally inert in the running system**. Every internal component — pure scheduling core, Effect-native runtime, prompt templates, HTTP route group, TUI plugins — is built and tested in isolation (80 tests green), but the layer that connects these components to the live process is missing. The result: no agent can call `workflow`, no HTTP client can create a workflow, and the TUI shows a blank inspector. The module is a fully assembled engine with no fuel line, no ignition, and no dashboard.

Investigation surfaced **three independent断裂** that all block end-to-end execution, plus a TUI data-flow gap that blocks observability:

1. **AppLayer not wired.** `app-runtime.ts` `Layer.mergeAll` does not include `Dag.defaultLayer`. The HTTP server's `LayerNode` list has `Dag.node`, but that is the server subsystem — the main runtime (ToolRegistry, agent execution, session runner) cannot `yield* Dag.Service`. The `workflow` tool hits `Effect.die("DAG service not wired")`.

2. **Scheduling never starts (deepest hidden break).** `Dag.Service.create()` publishes `WorkflowCreated` → `NodeRegistered` → `WorkflowStarted` and returns. It **never calls `startWorkflowScheduling()`**. `WorkflowTool.start` also only calls `create()`. So even after wiring AppLayer and registering the tool, a created workflow stays in `pending` forever — no node ever spawns. The task list's "DEFERRED" notes masked this: the scheduling code is complete, but nothing invokes it.

3. **No creation entry point.** The `workflow` tool is unregistered in `registry.ts` `builtin[]` (agent cannot reach it), and the HTTP API has no `POST /dag` create endpoint (external scripts cannot reach it). There is currently **no path** to create a workflow in the running system.

4. **TUI data-flow severed.** `sync.tsx` defines a `dag` store slice but nothing writes to it (the comment says "populated by plugin's createMemo calling HTTP"). `dag-inspector.tsx` `nodes()` returns a hardcoded `[]` ("until AppLayer wiring"). The `/dag` route opens but renders an empty page.

## What Changes

This change **does not build new DAG capabilities** — every scheduling/runtime/projection/template component already exists and is tested. It builds the **integration glue** that connects finished components to the live process, following the same wiring patterns as peer modules (`task`, `BackgroundJob`, `SessionPrompt`, `Todo`).

- **Wire `Dag.defaultLayer` into AppLayer.** Add `Dag.defaultLayer` to `app-runtime.ts` `Layer.mergeAll` so the main runtime can resolve `Dag.Service`. `Dag.defaultLayer` is already self-contained (self-provides EventV2Bridge + DagStore + DagProjector + Database) — no additional provide chain needed.

- **Add a `DagScheduler` service** that owns scheduling lifecycle, following the same service boundary as `GoalLoop`: an AppLayer-provided service with an explicit `init()` method activated from `project/bootstrap.ts`, `InstanceState`-scoped per directory, subscribing to `WorkflowStarted` events and forking `startWorkflowScheduling()` per workflow. It resolves `SessionPrompt.Service` (confirmed session-agnostic: `prompt(input)` takes an explicit `sessionID`, available in AppLayer) to construct the `TaskPromptOps` that `startWorkflowScheduling` requires — no tool/session-scoped context needed. This **decouples scheduling from the creation entry point**: both the `workflow` tool and HTTP `POST /dag` create records; the scheduler lifts them uniformly.

- **Register the `workflow` tool** in `registry.ts` `builtin[]`. The tool's `start` action additionally calls `startWorkflowScheduling()` using `ctx.extra.promptOps` (same pattern as `task.ts:196`), so tool-initiated workflows start immediately without waiting for the event subscription round-trip. The `DagScheduler` event subscription acts as the catch-all for HTTP-created workflows and crash-recovery scenarios.

- **Add HTTP `POST /dag` create endpoint** to `DagApi` + handler, accepting the existing `WorkflowGraphSchema` as body. The handler calls `dag.create()` and returns the `dagID`. Scheduling is lifted by `DagScheduler` — the handler needs no `promptOps`, staying cleanly outside session context (same shape as other mutation handlers).

- **Fix the OpenTUI data flow using existing TUI boundaries.** `sync.tsx` becomes the only writer for `sync.data.dag`, just like todo/goal/LSP state. The sidebar plugin remains read-only and continues to use `api.state.session.dag(sessionID)`. The full-page inspector follows `diff-viewer.tsx`: route-local `createResource` calls `api.client.dag.*` for workflow/node detail, and route-local commands are registered inside the component via `useBindings()` so `dag.enter` can close over selected-node state. Existing durable `DagEvent.Definitions` are added to the public event manifest so `sync.tsx` can refresh summaries on `dag.*` events; no plugin writes internal sync state.

## Capabilities

### New Capabilities

- `dag-runtime-wiring`: the `DagScheduler` service (scheduling lifecycle ownership, WorkflowStarted subscription, SessionPrompt-backed promptOps construction) + `Dag.defaultLayer` in AppLayer. This is the "ignition" — makes any created workflow actually execute.
- `dag-entry-surfaces`: two equivalent creation paths — the registered `workflow` tool (agent-facing, session-context, immediate scheduling via `ctx.extra.promptOps`) and the HTTP `POST /dag` endpoint (script/external-facing, session-external, scheduling lifted by DagScheduler). Both converge on the same `Dag.Service.create()` + `DagScheduler`.
- `dag-tui-data-flow`: OpenTUI-aligned state flow for DAG summaries (`sync.tsx` writer → `api.state.session.dag` reader), route-local HTTP resources for inspector detail, and a component-local `dag.enter` command. Makes the already-built TUI plugins observable without crossing plugin API boundaries.

### Modified Capabilities

- None. The prior `dag-workflow-dev-integration` change's three capabilities (`workflow-execution-core`, `workflow-tool-surface`, `workflow-tui-panel`) are **code-complete but unwired**; this change wires them without modifying their internal logic.

## Impact

- **New/changed code:** `packages/opencode/src/dag/runtime/scheduler.ts` (DagScheduler service, `GoalLoop`-style `init()` + InstanceState), `app-runtime.ts` (Dag + scheduler layers), `project/bootstrap.ts` (optional scheduler init), `registry.ts` (workflow tool registration), `groups/dag.ts`/`handlers/dag.ts` (route params fixed, create + summary endpoint), `event-manifest.ts` (expose existing `DagEvent.Definitions` to TUI event types), `context/sync.tsx` (DAG summary hydration/refresh), `dag-inspector.tsx` (createResource + useBindings), SDK regeneration, and httpapi-exercise coverage.
- **Reused, not modified:** `Dag.defaultLayer` (self-contained), `startWorkflowScheduling()` (already implemented), `SessionPrompt.Service` (session-agnostic prompt), `WorkflowGraphSchema` (existing tool schema, reused as HTTP body), `TaskPromptOps` (existing interface, constructed from SessionPrompt). **Prerequisite:** `dag-node-completion-semantics` MUST be implemented first — it adds the `NodeCompleted` success bridge to `spawn.ts` that this wiring change depends on.
- **No new tables, no new durable events, no new migrations.** The schema, EventV2 event inventory, and projector are complete from the prior change. This change only exposes existing `DagEvent.Definitions` through the public event manifest and generated SDK types.
- **Risk:** moderate-low. Backend wiring follows `GoalLoop`/`SessionPrompt`/`task` patterns directly. The highest-risk area is TUI integration because the previous implementation used placeholders; the final plan avoids plugin-boundary violations by making `sync.tsx` the store writer and using `createResource`/`useBindings` exactly like existing OpenTUI route plugins.
