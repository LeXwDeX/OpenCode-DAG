## 1. Completion bridge in spawnNode

- [x] 1.1 In `packages/opencode/src/dag/runtime/spawn.ts`, replace the failure-only `Effect.catchCause(...)` on the forked prompt with a success/failure split (e.g. `Effect.matchCause`) inside the same `semaphore.withPermits(1)(...)` fork.
- [x] 1.2 In the failure branch, preserve the existing behavior: publish `dag.nodeFailed(dagID, nodeID, String(cause), "exec_failed")`.
- [x] 1.3 In the success branch, extract the output as `result.parts.findLast((p) => p.type === "text")?.text ?? ""` and publish `dag.nodeCompleted(dagID, nodeID, output)`.
- [x] 1.4 Confirm `spawnNode` still publishes `NodeStarted` before the fork and still returns `{ childSessionID }` immediately (no new awaits in the caller path).
- [x] 1.5 Update the stale comments at `spawn.ts:43` and `spawn.ts:97` so they describe the actual mechanism (completion published from the forked prompt's success channel), not a non-existent "child session lifecycle" bridge.

## 2. Verification of the completion signal

- [x] 2.1 Add a runtime test that spawns a single-node workflow with a stub `promptOps.prompt` resolving to a `SessionV1.WithParts` containing a text part, and asserts `NodeCompleted` is published with `output` equal to that text.
- [x] 2.2 Add a test where the stub result has no text part, and assert `NodeCompleted` is published with `output === ""` (node still completes).
- [x] 2.3 Add a test where the stub `prompt` fails, and assert `NodeFailed` is published and no `NodeCompleted` is published for that node.
- [x] 2.4 Add a two-node linear workflow test (B depends on A) where A's `prompt` resolves; assert A's `NodeCompleted` drives the scheduling loop to spawn B, and once B completes `maybeComplete` completes the workflow.
- [x] 2.5 Assert exactly one terminal event per node execution (no double completed+failed).

## 3. Boundary documentation

- [x] 3.1 Add a short code comment in `spawn.ts` (or `eval.ts`) noting the Level 1 boundary: output is plain text, so `input_mapping` field references (`nodeID.output.field`) resolve to `undefined` until Level 2 structured output is defined.
- [x] 3.2 Confirm no regression to `eval.ts` — `evaluateCondition` / `resolveInputMapping` remain unwired (zero callers); this change does not introduce a partial wiring.

## 4. Reconcile with the wiring change

- [x] 4.1 Update `dag-runtime-wiring-and-surfacing`'s `dag-runtime-wiring` spec: relax the requirement "`startWorkflowScheduling()` / `startScheduling()` internal logic MUST NOT be modified" and "`maybeComplete` unchanged" to explicitly permit (and depend on) the `spawn.ts` completion bridge from this change.
- [x] 4.2 Note in the wiring change's proposal/design that `dag-node-completion-semantics` is a prerequisite: the wiring integration test ("HTTP-created workflow spawns nodes and completes") depends on the completion bridge being present.

## 5. Validation

- [x] 5.1 Run `bun typecheck` from `packages/opencode` — green.
- [x] 5.1 Run the new completion tests from `packages/opencode` — green.
- [x] 5.1 Run `openspec validate dag-node-completion-semantics --strict` — passes.
