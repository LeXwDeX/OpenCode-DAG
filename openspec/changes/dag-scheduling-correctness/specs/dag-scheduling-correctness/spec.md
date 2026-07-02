## ADDED Requirements

### Requirement: Serialized re-evaluation of terminal events

The scheduling loop MUST NOT allow concurrent re-evaluations of the shared `done`/`failed`/`running` state. Terminal events from multiple subscription streams MUST be processed serially — either through a single merged stream, a `Semaphore(1)` guard around re-evaluation, or an equivalent serialization mechanism.

#### Scenario: concurrent terminal events do not interleave

- **WHEN** two terminal events arrive near-simultaneously (e.g., `NodeCompleted` for node A and `NodeFailed` for node B)
- **THEN** the re-evaluation triggered by the first event fully completes (store read, Set rebuild, spawn check, maybeComplete) before the second event's re-evaluation begins
- **AND** no node is double-spawned due to interleaved Set mutation

### Requirement: Graph rebuild on replan

The scheduling loop MUST rebuild its in-memory `DependencyGraph` when the workflow is replanned. Nodes added by `dag.replan()` MUST become visible to `getExecutableNodes()` and `maybeComplete`.

#### Scenario: replan adds a new node

- **WHEN** `dag.replan()` publishes `WorkflowReplanned` and new `NodeRegistered` events
- **THEN** the scheduling loop rebuilds its dependency graph from the current read model
- **AND** newly-added nodes whose dependencies are satisfied are spawned
- **AND** `maybeComplete` checks against the expanded node set

### Requirement: Terminal fiber cleanup on workflow completion

When a workflow reaches a terminal state (`completed`/`failed`/`cancelled`), the scheduling loop MUST interrupt all of its subscription fibers. No fiber from a completed workflow MAY remain active.

#### Scenario: completed workflow fibers are interrupted

- **WHEN** `maybeComplete` publishes `WorkflowCompleted` or `WorkflowCancelled`
- **THEN** all event-subscription fibers for that `dagID` are interrupted
- **AND** no further events for that `dagID` are processed by the scheduling loop

### Requirement: Pause and resume honored by the scheduling loop

The scheduling loop MUST subscribe to `WorkflowPaused` and `WorkflowResumed`. On pause, the loop MUST stop spawning new nodes. On resume, the loop MUST resume spawning.

#### Scenario: pause stops new spawns

- **WHEN** `WorkflowPaused` is received by the scheduling loop
- **THEN** `spawnReadyNodes` is not called until `WorkflowResumed` is received
- **AND** in-flight nodes continue running and their terminal events are still processed

#### Scenario: resume restarts spawning

- **WHEN** `WorkflowResumed` is received
- **THEN** the loop re-evaluates ready nodes and resumes spawning
- **AND** nodes that became ready during the pause are spawned

### Requirement: Idempotent scheduling per workflow

The scheduler MUST maintain a registry of active scheduling loops keyed by `dagID`. `startScheduling()` for a `dagID` that already has an active loop MUST be a no-op.

#### Scenario: duplicate WorkflowStarted does not double-schedule

- **WHEN** `WorkflowStarted` is received for a `dagID` that already has an active scheduling loop
- **THEN** no second loop is forked
- **AND** the existing loop continues uninterrupted

### Requirement: Spawn ordering closes the orphan window

`spawnNode` MUST NOT leave a window where a child session exists but no `NodeStarted` event has been published. Either the event and session creation MUST be atomic, or `reconcileWorkflow` MUST detect and clean up orphaned child sessions in `pending` state.

#### Scenario: crash between session create and NodeStarted

- **WHEN** the process crashes after `sessions.create()` but before `NodeStarted` is published
- **THEN** on restart, `reconcileWorkflow` detects the orphaned child session
- **AND** either publishes `NodeStarted` retroactively or marks the node as `failed`
