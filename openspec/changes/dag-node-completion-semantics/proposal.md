## Why

The DAG execution core has a **completion-detection gap** that deadlocks every workflow the moment a node succeeds. This is the keystone flaw beneath the `dag-runtime-wiring-and-surfacing` change, which assumes the execution core works ("`startWorkflowScheduling()` already implemented, reused not modified") — but wiring a broken engine only moves the failure from "never starts" to "deadlocks after the first execution layer."

**The gap, concretely:**

`spawnNode` (`packages/opencode/src/dag/runtime/spawn.ts:98-116`) forks the child session's prompt **fire-and-forget** and wires only the failure branch:

```
Effect.forkDetach(
  semaphore.withPermits(1)(
    input.promptOps.prompt({ sessionID: childSession.id, ... }).pipe(
      Effect.catchCause((cause) => dag.nodeFailed(dagID, nodeID, ...))   // failure ✅
      // success branch MISSING — nothing publishes NodeCompleted ❌
    )
  )
)
return { childSessionID }   // returns immediately, completion never observed
```

The scheduling loop (`scheduling.ts`) subscribes to `NodeCompleted` to advance. Because a successful node never publishes `NodeCompleted`:

- the `done` set never fills for successful nodes,
- `maybeComplete`'s `allDone` check is never satisfied,
- downstream nodes never spawn,
- the workflow stays `running` forever with 4 leaked subscription fibers.

Verification: `dag.nodeCompleted` has exactly two references in the whole repo — its definition in `dag.ts:176` and one call in `recovery.ts:52` (crash recovery, itself never invoked). `spawnNode` calls only `dag.nodeStarted`, never `dag.nodeCompleted`. The comments at `spawn.ts:43` and `spawn.ts:97` claim completion is "inferred from child session lifecycle" — that bridge does not exist in code.

**Why now:** The `dag-runtime-wiring-and-surfacing` change is in progress (0/41). Its spec `dag-runtime-wiring` explicitly requires "`startWorkflowScheduling()` and `startScheduling()` internal logic MUST NOT be modified" and "`maybeComplete` state transitions MUST drive terminal states unchanged." That constraint is built on the false premise that the execution core is complete. This change must land **before** wiring, and it corrects that constraint: `spawn.ts` internals MUST change for completion to work.

## What Changes

This change defines and implements the **node completion contract** — the semantics of when a DAG node is "done" and what its "output" is. It mirrors the proven `task` tool model, which already solves the identical problem for single subagents.

**The completion model (from `task.ts:210-221`):** A `task` subagent completes when `ops.prompt()` resolves; its output is the final text part of the result:

```
const result = yield* ops.prompt({...})                        // awaited
const text = result.parts.findLast(p => p.type === "text")?.text ?? ""   // output
```

A DAG node **is** a task subagent. The only difference is that DAG runs N nodes concurrently, so `spawnNode` forks instead of awaiting — but forking does not require discarding the completion signal; the signal is published from inside the forked fiber.

- **Define node completion.** A node completes when its child session's `ops.prompt()` resolves successfully; it fails when `prompt()` fails (already handled). Completion is observed inside the forked execution fiber, preserving concurrency.

- **Define node output (Level 1 — control flow + text).** The node's output is the final text part of the prompt result (`result.parts.findLast(p => p.type === "text")?.text ?? ""`), the same extraction the `task` tool uses. This is the minimal contract that unblocks the deadlock: it enables ordered execution and text passing between nodes. Structured output (Level 2, for `input_mapping` / `condition`) is explicitly out of scope here and documented as a follow-up.

- **Modify `spawnNode` to bridge completion.** Add the missing success branch: on `prompt()` resolution, publish `NodeCompleted(dagID, nodeID, output)` from the forked fiber. Keep the fork, keep the semaphore, keep the existing failure branch. Replace `Effect.catchCause(...)` with a `matchCause`-style success/failure split.

- **Correct the wiring constraint.** The `dag-runtime-wiring` spec requirement "no modification to scheduling internals" is invalidated. This change documents that `spawn.ts` completion bridge is a prerequisite the wiring change assumed but did not provide.

## Capabilities

### New Capabilities

- `dag-node-completion`: the node completion contract — completion is derived from child-session `prompt()` resolution (success → `NodeCompleted`, failure → `NodeFailed`), output is the final text part (Level 1). This is the keystone that makes the scheduling loop actually advance; without it every workflow deadlocks after its first execution layer.

### Modified Capabilities

<!-- Neither dag-workflow-dev-integration nor dag-runtime-wiring-and-surfacing is archived, so their specs are not yet in openspec/specs/. This change's contract supersedes the "no modification to scheduling internals" requirement in the in-progress dag-runtime-wiring spec; that correction is captured in dag-node-completion's spec and must be reconciled when the wiring change is (re)validated. -->

## Impact

- **Changed code:** `packages/opencode/src/dag/runtime/spawn.ts` — the forked prompt gains a success branch that extracts the final text output and publishes `NodeCompleted`; the failure branch is preserved. The `NodeSpawnInput` contract and the surrounding scheduling loop are unchanged.
- **Reused, not modified:** the `task` completion model (`task.ts:210-221`), `SessionV1.WithParts` result shape (`{ info, parts }`), the `NodeCompleted` event (already defined in `dag-event.ts`, already projected in `projector.ts`), the semaphore-bounded fork.
- **No new tables, no new events, no new migrations.** `NodeCompleted` and its projection already exist; this change is the missing publisher.
- **Ordering dependency:** this change is a **prerequisite** for `dag-runtime-wiring-and-surfacing`. Wiring the scheduler without this fix produces a runtime that spawns first-layer nodes and then deadlocks. The wiring change's "no modification to scheduling internals" requirement must be relaxed to permit the `spawn.ts` completion bridge.
- **Out of scope (documented follow-ups):** structured output for `input_mapping`/`condition` (Level 2); multi-turn / steered node execution; durable/recoverable scheduler state (the saga-durability gap); the shared-mutable-Set concurrency race in `scheduling.ts`. These are separate concerns that this change surfaces but does not resolve.
