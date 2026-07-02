## ADDED Requirements

### Requirement: Node completion derived from child session prompt resolution

A DAG node MUST be treated as complete when its backing child session's `prompt()` Effect resolves successfully, and as failed when that Effect fails. Completion detection MUST NOT depend on a `node_complete` tool, agent self-declaration, or session-idle polling. This mirrors the `task` tool's subagent completion model (`task.ts:210-221`).

#### Scenario: successful prompt resolution completes the node

- **WHEN** a node's child session `prompt()` resolves successfully
- **THEN** the runtime publishes `NodeCompleted(dagID, nodeID, output)` for that node
- **AND** the completion is published from inside the forked execution fiber (concurrency is preserved; the scheduling loop is not blocked)
- **AND** exactly one terminal event is published for the node execution (either `NodeCompleted` or `NodeFailed`, never both)

#### Scenario: failed prompt completes the node as failed

- **WHEN** a node's child session `prompt()` fails
- **THEN** the runtime publishes `NodeFailed(dagID, nodeID, reason, "exec_failed")`
- **AND** no `NodeCompleted` event is published for that node execution

#### Scenario: completion advances the scheduling loop

- **WHEN** `NodeCompleted` is published for a node whose downstream dependents were blocked only on it
- **THEN** the scheduling loop's `NodeCompleted` subscription fires
- **AND** the node is added to the scheduler's `done` set
- **AND** newly-unblocked downstream nodes are spawned
- **AND** when all nodes reach a terminal state, `maybeComplete` completes or cancels the workflow

### Requirement: Node output is the final text part (Level 1)

A completed node's `output` MUST be the text of the final text part of the prompt result, extracted as `result.parts.findLast(p => p.type === "text")?.text ?? ""` — the same extraction the `task` tool uses. This is the Level 1 (control-flow + text-passing) contract.

#### Scenario: output extracted from final text part

- **WHEN** a node's `prompt()` resolves with a `SessionV1.WithParts` result containing one or more text parts
- **THEN** the published `NodeCompleted.output` is the text of the last text part in `result.parts`

#### Scenario: output defaults to empty string when no text part exists

- **WHEN** a node's `prompt()` resolves with a result containing no text part
- **THEN** the published `NodeCompleted.output` is the empty string `""`
- **AND** the node is still marked completed (absence of text is not a failure)

#### Scenario: structured field mapping is out of scope at Level 1

- **WHEN** a downstream node declares `input_mapping` referencing `upstreamNodeID.output.field`
- **THEN** at Level 1 the field reference resolves to `undefined` because the output is plain text, not a structured object
- **AND** this is a documented boundary, not a runtime error — control-flow ordering and whole-text passing still function

### Requirement: Concurrency and semaphore invariants preserved

The completion bridge MUST NOT change the concurrency model. The child prompt MUST remain forked under the existing concurrency semaphore, and `spawnNode` MUST continue to return immediately after publishing `NodeStarted`.

#### Scenario: node spawn does not block the scheduling loop

- **WHEN** `spawnNode` is called for a ready node
- **THEN** it creates the child session, publishes `NodeStarted`, forks the semaphore-bounded prompt, and returns `{ childSessionID }` immediately
- **AND** the scheduling loop continues evaluating and spawning other ready nodes without waiting for this node's prompt to resolve

#### Scenario: semaphore permit released on either terminal channel

- **WHEN** a forked node prompt resolves (success) or fails
- **THEN** the held semaphore permit is released when the forked fiber terminates
- **AND** the permit is released regardless of which terminal channel fired

### Requirement: Correction of the scheduling-internals constraint

This capability MUST supersede any requirement asserting that DAG scheduling internals (`spawn.ts`) may not be modified. Publishing `NodeCompleted` from `spawnNode` MUST be treated as a mandatory prerequisite for the scheduling loop to terminate; a wiring effort that starts the scheduler without this bridge produces a runtime that spawns the first execution layer and then deadlocks.

#### Scenario: wiring the scheduler requires the completion bridge

- **WHEN** a scheduler is wired to fork `startWorkflowScheduling()` on `WorkflowStarted`
- **THEN** the completion bridge in `spawnNode` MUST be present
- **AND** without it, any workflow containing at least one successful node stays `running` indefinitely with leaked subscription fibers
