## Why

The DAG scheduler is an **ephemeral saga**: its state (which nodes are done/failed/running, the dependency graph, the 4 event subscriptions) lives entirely in forked in-memory fibers. When the process restarts — planned or crash — all of this is gone. The durable EventV2 events and read-model tables survive, but **nothing reconstructs the scheduler from them**. Every in-flight workflow freezes permanently: the read model says `running`, nodes are `pending`/`running`, but no engine drives them forward.

This is not a bug in the current code — it is a **structural gap**: the codebase has no mechanism to restart scheduling for workflows that were active before a restart. `recovery.ts` (`reconcileWorkflow`) exists as dead code (zero callers); even if wired, it only reconciles *node* statuses against child-session state — it does not restart the scheduling *loop* that drives new spawns and `maybeComplete`.

Meanwhile, `EventV2.subscribe` is a live-only in-memory PubSub (`event.ts:455`): `Stream.fromPubSub(pubsub)`. It does not replay past events. A `DagScheduler` subscriber that starts after `WorkflowStarted` was published will never see it. The durable-replay API (`EventV2.durable(aggregateID)`) exists but is unused by the DAG system.

## What Changes

- **Startup-time workflow recovery.** When `DagScheduler.init()` materializes its `InstanceState`, it MUST scan for workflows in non-terminal status (`running`/`paused`) and fork a fresh `startScheduling()` for each. This is the "rehydration" path: the scheduler reconstructs its in-memory state from the read model instead of from events.

- **Reconcile stale `running` nodes.** Before restarting scheduling, call the existing `reconcileWorkflow()` logic for each recovered workflow: nodes left `running` by an unclean shutdown are checked against their backing child session's actual state (`completed` → `NodeCompleted`, `failed` → `NodeFailed`, still-alive → leave running). This brings the read model to a consistent snapshot *before* the new scheduling loop starts.

- **Evaluation of durable-replay as an alternative trigger.** Investigate whether `EventV2.durable(aggregateID=dagID)` can drive scheduling instead of (or alongside) the `subscribe`-based loop. Durable replay would survive restarts by design, but it has different semantics (per-aggregate, not global) and needs evaluation against the multi-workflow scheduling model.

## Capabilities

### New Capabilities
- `dag-scheduler-recovery`: startup-time reconstruction of active schedulers from the read model + stale-node reconciliation.

### Modified Capabilities
- `dag-runtime-wiring` (from `dag-runtime-wiring-and-surfacing`): the `DagScheduler.init()` scenario MUST include the recovery scan, not just `WorkflowStarted` subscription.

## Impact

- **Changed code:** `packages/opencode/src/dag/runtime/recovery.ts` (wire `reconcileWorkflow`, currently dead code), `scheduler.ts` (the `DagScheduler` from the wiring change — add recovery scan to `init()`).
- **Reused:** `reconcileWorkflow()` logic (already implemented, just unwired), `DagStore.listByStatus("running")` (already exists), `startScheduling()` (already exists).
- **Risk:** moderate. The rehydration path must handle the window where a child session is still actively running from the previous process — the new scheduler must not double-spawn nodes that already have live child sessions.
- **Depends on:** `dag-node-completion-semantics` + `dag-runtime-wiring-and-surfacing` being implemented first (the scheduler must exist and must be able to complete nodes before recovery is meaningful).
