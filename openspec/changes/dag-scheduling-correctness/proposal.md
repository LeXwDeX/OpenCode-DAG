## Why

The DAG scheduling loop (`scheduling.ts`) has **six internal correctness defects** that cause data races, resource leaks, and semantic violations. None of these are exposed today because the entire runtime is dead code (zero callers), but they will all surface the moment the scheduler is wired. Each defect is independently reproducible once a workflow runs:

1. **Shared-mutable-Set race (concurrency hazard).** The 4 terminal-event subscriptions (`NodeCompleted`/`NodeFailed`/`NodeSkipped`/`NodeCancelled`) each fork an independent fiber. All 4 fibers mutate the same `done`/`failed`/`running` Sets. Each handler does `done.clear()` then re-reads from `store.getNodes()` (an async Effect). At the `await` point between `clear()` and re-population, another handler's fiber can interleave — reading a half-populated Set, double-spawning a node, or corrupting the `running` set.

2. **Replan does not rebuild the graph (F5).** `buildGraph(nodes)` runs once at scheduling start. When `dag.replan()` adds new nodes (publishing `NodeRegistered`), the scheduling loop's in-memory graph is stale — new nodes never appear in `graph.getExecutableNodes()`, so they are never spawned. `maybeComplete` uses `graph.getAllNodes()` which also excludes new nodes, so the workflow can be falsely marked complete.

3. **Terminal fibers never cleaned up (F6).** When a workflow reaches a terminal state (`maybeComplete` calls `dag.complete/cancel`), the 4 `forkDetach`ed subscription fibers are never interrupted. Each completed workflow permanently leaks 4 fibers that continue consuming events (filtered by dagID, so they no-op, but the fiber + PubSub subscription resources persist).

4. **Pause/Resume not honored (F4).** `dag.pause()` publishes `WorkflowPaused`, but the scheduling loop does not subscribe to it. After a pause, `spawnReadyNodes` continues spawning newly-ready nodes. Resume (`WorkflowResumed`) has no effect because the loop never stopped.

5. **No scheduling idempotency (F7).** There is no `Map<dagID, Fiber>` guard. If `startScheduling()` is invoked twice for the same `dagID` (e.g., the DagScheduler subscriber fires + the inline tool trigger fires, or a duplicate `WorkflowStarted` event), two independent scheduling loops run concurrently for the same workflow — double-spawning child sessions, double-publishing events.

6. **Spawn orphan window.** `spawnNode` creates the child session (`sessions.create(...)`) at step 3, then publishes `NodeStarted` at step 4. A crash between 3 and 4 leaves an orphaned child session with no `NodeStarted` event — the read model shows the node as `pending` (no `childSessionId`), but a real child session exists and may be consuming resources. `reconcileWorkflow` only checks `running` nodes (those with `childSessionId`), so this orphan is never cleaned up.

## What Changes

- **Serialize re-evaluation.** Replace the 4 independent `forkDetach` subscription fibers with a single serialized re-evaluation queue (or a `Semaphore(1)` / `Effect.zipPar`-style merge). Every terminal event triggers a re-evaluation, but re-evaluations do not interleave.

- **Rebuild graph on replan.** Subscribe to `WorkflowReplanned`; when received, re-read all nodes from the store and rebuild the `DependencyGraph`. Also re-check `maybeComplete` against the expanded node set.

- **Interrupt terminal fibers on workflow completion.** Track the 4 subscription fibers per workflow (in the scheduler's `Map<dagID, ...>`); when `maybeComplete` fires, interrupt all 4.

- **Honor pause/resume.** Subscribe to `WorkflowPaused`/`WorkflowResumed`. On pause, stop spawning new nodes (the terminal-event subscriptions stay active so in-flight nodes can still complete). On resume, resume spawning.

- **Idempotent scheduling.** The scheduler MUST maintain a `Set<dagID>` (or `Map<dagID, Fiber>`) of active scheduling loops. `startScheduling()` checks this before forking; if a loop already exists for the `dagID`, it is a no-op.

- **Close the spawn orphan window.** Either reorder (publish `NodeStarted` before `sessions.create` — but the event needs `childSessionId`), or add a `pending`-state orphan sweep to `reconcileWorkflow` that detects child sessions without corresponding `NodeStarted` events.

## Capabilities

### New Capabilities
- `dag-scheduling-correctness`: serialized re-evaluation, graph rebuild on replan, fiber cleanup on terminal, pause/resume honoring, idempotent scheduling, spawn orphan window closure.

## Impact

- **Changed code:** `packages/opencode/src/dag/runtime/scheduling.ts` (significant refactor of the subscription + re-evaluation model), `spawn.ts` (orphan window fix).
- **Risk:** moderate-high. The scheduling loop's core control flow changes. Each fix must be individually testable. The serialized re-evaluation model must not introduce deadlocks (e.g., a terminal event arriving while a re-evaluation is in progress must queue, not drop).
- **Depends on:** `dag-node-completion-semantics` (completion bridge must work before testing scheduling correctness).
- **Can run in parallel with:** `dag-scheduler-durability` (different concerns: this is correctness, that is persistence).
