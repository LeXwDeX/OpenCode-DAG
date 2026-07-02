## Context

The DAG execution runtime spawns each node as a real child session (design principle D3: "node = real child session"). `spawnNode` (`packages/opencode/src/dag/runtime/spawn.ts`) creates the child session, publishes `NodeStarted`, then forks the child's prompt under a concurrency semaphore. The scheduling loop (`scheduling.ts`) subscribes to node terminal events (`NodeCompleted`/`NodeFailed`/`NodeSkipped`/`NodeCancelled`) and re-evaluates readiness after each, spawning newly-unblocked nodes and calling `maybeComplete` when all nodes reach a terminal state.

The forked prompt currently wires **only** the failure path:

```ts
// spawn.ts:98-116 (current)
yield* Effect.forkDetach(
  semaphore.withPermits(1)(
    input.promptOps.prompt({
      messageID: MessageID.ascending(),
      sessionID: childSession.id,
      model, agent: agent.name, parts: input.promptParts,
    }).pipe(
      Effect.catchCause((cause) =>
        dag.nodeFailed(input.dagID, input.nodeID, String(cause), "exec_failed")
      ),
    ),
  ),
)
return { childSessionID: childSession.id as string }
```

On success, the fiber simply ends. Nothing publishes `NodeCompleted`. The scheduling loop's `NodeCompleted` subscription never fires for successful nodes, so `done` never fills, `maybeComplete` never completes the workflow, and downstream nodes never spawn. Every workflow with at least one successful node deadlocks.

The `task` tool already solves the identical problem for a single subagent (`task.ts:210-221`): it awaits `ops.prompt()` and extracts the final text part as the subagent's result. The `prompt()` Effect resolves exactly when the subagent's turn ends (LLM stops requesting tools). `ops.prompt()` returns `SessionV1.WithParts = { info, parts }`; the output is `result.parts.findLast(p => p.type === "text")?.text ?? ""`.

The only structural difference between `task` and DAG is concurrency: `task` awaits one subagent inline; DAG runs N nodes in parallel and therefore forks. Forking is orthogonal to observing completion — the completion signal is available inside the forked fiber's success channel.

## Goals / Non-Goals

**Goals:**

- Define the node completion contract: a node completes when its child session's `prompt()` resolves; it fails when `prompt()` fails.
- Define the node output contract at Level 1: output is the final text part of the prompt result, using the same extraction as the `task` tool.
- Bridge completion in `spawnNode`: publish `NodeCompleted(dagID, nodeID, output)` from the forked fiber's success channel, preserving the existing fork, semaphore, and failure branch.
- Make the change surgical and localized to `spawn.ts` so it composes cleanly with the pending `dag-runtime-wiring-and-surfacing` change.

**Non-Goals:**

- **Structured output (Level 2).** Producing JSON output for `input_mapping` / `condition` resolution. Level 1 emits plain text; `input_mapping` referencing `nodeID.output.field` remains unresolved until a follow-up defines how agents emit structured output. This change does not wire `eval.ts` (`evaluateCondition` / `resolveInputMapping`).
- **Multi-turn / steered node execution.** This change treats one `prompt()` resolution as one node completion, matching `task`. Nodes that require multiple turns or mid-flight steering are a separate concern.
- **Durable/recoverable scheduler state.** The saga-durability gap (in-memory scheduler fibers lost on restart) is out of scope; `recovery.ts` integration belongs to the wiring change.
- **The scheduling.ts concurrency race.** The shared-mutable-Set race across the 4 terminal-event fibers is surfaced but not fixed here.

## Decisions

### D1: Completion is derived from `prompt()` resolution, not a `node_complete` signal

**Decision:** A node completes when `ops.prompt()` resolves successfully; it fails when `prompt()` fails. No `node_complete` tool, no agent self-declaration, no session-idle polling.

**Rationale:** This is exactly how the `task` tool defines subagent completion, and it is the meaning of DAG design principle D3 ("completion inferred from child session lifecycle"). `prompt()` resolving *is* the child session lifecycle terminating for that turn. Reusing this model keeps DAG nodes and task subagents semantically identical and avoids inventing a parallel completion protocol.

**Rejected alternative — subscribe to session status/idle events:** Would require mapping child sessionID → nodeID (available via `NodeStarted`), subscribing to a separate `SessionStatus`/idle stream, and disambiguating "idle because done" from "idle because waiting." `prompt()` resolution already collapses all of this into a single typed signal. More moving parts, same result.

### D2: Output is the final text part (Level 1)

**Decision:** `output = result.parts.findLast(p => p.type === "text")?.text ?? ""`, identical to `task.ts:221`.

**Rationale:** The `NodeCompleted` event's `output` field is `Schema.Unknown`, so it accepts a string. The final text part is the subagent's concluding response — the natural "result" of the node. This is the minimal contract that (a) unblocks the deadlock and (b) enables text passing between nodes (a downstream node's prompt can interpolate an upstream node's text).

**Explicit boundary:** `input_mapping` expects `output.field` (structured). With a plain-text output, `resolvePath("field", { output: "some text" })` returns `undefined`. That is acceptable for Level 1 — control-flow DAGs and text-passing DAGs work; data-flow DAGs with field-level mapping are deferred to Level 2. The proposal documents this so the boundary is a conscious contract, not a silent gap.

### D3: Bridge in the forked fiber via success/failure split, keep concurrency

**Decision:** Replace the current `Effect.catchCause(failure-only)` with a `matchCause`-style split that handles both channels inside the same forked, semaphore-bounded fiber:

```ts
// conceptual shape — not implementation
Effect.forkDetach(
  semaphore.withPermits(1)(
    input.promptOps.prompt({ ... }).pipe(
      Effect.matchCause({
        onFailure: (cause) =>
          dag.nodeFailed(input.dagID, input.nodeID, String(cause), "exec_failed"),
        onSuccess: (result) => {
          const output = result.parts.findLast((p) => p.type === "text")?.text ?? ""
          return dag.nodeCompleted(input.dagID, input.nodeID, output)
        },
      }),
    ),
  ),
)
```

**Rationale:** The fork is required for concurrency (N nodes under one semaphore); the scheduling loop must not block on any single node. Publishing completion from *inside* the forked fiber preserves concurrency while restoring the completion signal. `matchCause` (vs `catchCause` + a separate success tap) keeps both channels in one place and guarantees exactly one terminal event per node execution.

**Preserved invariants:** `spawnNode` still returns `{ childSessionID }` immediately after publishing `NodeStarted` (the scheduling loop's `running` bookkeeping is unchanged). The semaphore permit is held for the duration of the prompt and released when the fiber ends, regardless of channel.

### D4: This change precedes and corrects the wiring change

**Decision:** `dag-node-completion-semantics` is a prerequisite for `dag-runtime-wiring-and-surfacing`. The wiring change's requirement "no modification to scheduling internals / `maybeComplete` unchanged" is relaxed to permit the `spawn.ts` completion bridge.

**Rationale:** The wiring change starts the scheduler; this change makes the scheduler's loop actually terminate. Wiring without this fix yields a runtime that spawns the first execution layer and then deadlocks — strictly worse to debug than "never starts," because the read model shows `running` with partial progress. Landing completion first means the wiring change's integration test ("HTTP-created workflow spawns nodes and completes") can actually pass.

## Risks / Trade-offs

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `prompt()` resolution does not mean "node's task is done" for multi-turn agents | Medium | Level 1 defines one `prompt()` = one node execution, matching `task`. Multi-turn nodes are an explicit Non-Goal; documented for a follow-up. |
| Plain-text output breaks `input_mapping` expectations silently | Medium | Documented as the Level 1 / Level 2 boundary in both proposal and design. `input_mapping` is already unwired (`eval.ts` has zero callers), so nothing regresses; the gap is made explicit, not introduced. |
| Semaphore permit leak if `matchCause` mis-handles a channel | Low | `withPermits(1)` wraps the whole `prompt().pipe(matchCause)`; the permit releases when the fiber completes on either channel. Both branches return an Effect, so the fiber always terminates cleanly. |
| Double terminal event (both completed and failed) for one node | Low | `matchCause` fires exactly one branch. The prior `catchCause` + implicit success end could not double-fire either, but `matchCause` makes the exclusivity explicit. |
| Change conflicts with in-progress wiring change edits to nearby code | Low | The bridge is localized to `spawn.ts:98-116`. The wiring change does not touch `spawn.ts` (it adds `scheduler.ts` + AppLayer wiring). Ordering: land completion first, then wiring. |
