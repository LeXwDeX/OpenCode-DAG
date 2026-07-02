## ADDED Requirements

### Requirement: Startup-time scheduler rehydration

When the `DagScheduler` initializes, it MUST scan the read model for workflows in non-terminal status (`running`, `paused`) and fork a fresh scheduling loop for each, reconstructing the scheduler's in-memory state from persisted data rather than from live events.

#### Scenario: running workflow resumed after restart

- **WHEN** the process restarts and `DagScheduler.init()` runs
- **AND** the read model contains workflows with `status = "running"`
- **THEN** for each such workflow, the scheduler reconciles stale `running` nodes via `reconcileWorkflow()`
- **AND** forks `startScheduling()` with a freshly-built dependency graph from the read model
- **AND** the workflow resumes progressing toward completion

#### Scenario: paused workflow not auto-resumed

- **WHEN** the process restarts and the read model contains workflows with `status = "paused"`
- **THEN** the scheduler MUST NOT fork a scheduling loop until an explicit `resume` is requested
- **AND** the workflow remains paused in the read model

### Requirement: Stale running-node reconciliation before scheduling restart

Before forking a new scheduling loop for a recovered workflow, the scheduler MUST call `reconcileWorkflow()` to bring the read model to a consistent snapshot. Nodes left `running` by an unclean shutdown MUST be checked against their backing child session's actual state.

#### Scenario: completed child session reconciled

- **WHEN** `reconcileWorkflow()` finds a `running` node whose child session has since completed
- **THEN** a `NodeCompleted` event is published for that node
- **AND** the scheduling loop that starts afterward sees the node as `completed`

#### Scenario: orphaned running node without child session

- **WHEN** `reconcileWorkflow()` finds a `running` node with no `childSessionId` (spawn started but `NodeStarted` was never published)
- **THEN** a `NodeFailed` event is published with reason indicating the node was running but never spawned

### Requirement: No double-spawn for still-live child sessions

The scheduler MUST NOT spawn replacement child sessions for nodes that are still actively executing from a previous process instance.

#### Scenario: still-live child session left running

- **WHEN** a recovered workflow has `running` nodes whose child sessions are still actively executing in a concurrent process
- **THEN** the new scheduling loop does NOT spawn replacement child sessions for those nodes
- **AND** the nodes remain in the `running` set until their original child session reaches a terminal state
