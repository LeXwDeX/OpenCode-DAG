## ADDED Requirements

### Requirement: Dag.defaultLayer in AppLayer

The main application runtime MUST resolve `Dag.Service` so that the ToolRegistry, agent execution path, and HTTP handlers can `yield* Dag.Service`.

#### Scenario: Dag.Service resolvable from AppLayer

- **WHEN** the application starts with the updated `app-runtime.ts`
- **THEN** `Dag.defaultLayer` is included in `Layer.mergeAll`
- **AND** any Effect run via `AppRuntime.runPromise` can `yield* Dag.Service` successfully
- **AND** no additional `Layer.provide` chain is needed (Dag.defaultLayer is self-contained)

### Requirement: DagScheduler service

A `DagScheduler` service MUST own the scheduling lifecycle for all workflows in its directory scope, using the same `init()` + `InstanceState` lifecycle pattern as `GoalLoop`.

#### Scenario: scheduler initialized by bootstrap

- **WHEN** `project/bootstrap.ts` runs for an instance
- **THEN** it resolves `DagScheduler.Service` with `Effect.serviceOption`
- **AND** calls `dagScheduler.init()` when the service is present
- **AND** missing scheduler service is treated as optional (same pattern as `GoalLoop`)

#### Scenario: newly-started workflow gets a scheduler

- **WHEN** a `WorkflowStarted` event is published for a `dagID` that has no active scheduler
- **THEN** `DagScheduler` forks `startWorkflowScheduling()` for that `dagID`
- **AND** the scheduler fiber is registered in the active-scheduler `Map<dagID, Fiber>`

#### Scenario: dedup against existing scheduler

- **WHEN** a `WorkflowStarted` event arrives for a `dagID` that already has an active scheduler
- **THEN** `DagScheduler` skips scheduling (no second fiber is forked)

#### Scenario: InstanceState-scoped cleanup

- **WHEN** the InstanceState for a directory is disposed
- **THEN** all active scheduler fibers in that directory's scope are interrupted

#### Scenario: InstanceState isolation

- **WHEN** two directories are open concurrently
- **THEN** each directory has its own `DagScheduler` state
- **AND** schedulers from one directory do not affect the other

### Requirement: promptOps construction from SessionPrompt

The `DagScheduler` MUST construct a `TaskPromptOps` adapter from `SessionPrompt.Service` without session-scoped context.

#### Scenario: promptOps delegates to SessionPrompt

- **WHEN** `DagScheduler` initializes in AppLayer context
- **THEN** it yields `SessionPrompt.Service`
- **AND** constructs a `TaskPromptOps`-satisfying object where `cancel`/`resolvePromptParts`/`prompt` delegate to the SessionPrompt service
- **AND** this adapter works for any `sessionID` passed to `prompt(input)`

### Requirement: crash recovery integration

The existing `recovery.ts` `reconcileWorkflow()` logic MUST integrate with `DagScheduler` so workflows left running after a restart get re-scheduled.

#### Scenario: running workflow re-scheduled on restart

- **WHEN** `dagScheduler.init()` materializes its InstanceState and finds workflows in `running` status
- **THEN** it calls `reconcileWorkflow()` for each
- **AND** workflows with still-running child sessions get a fresh `startWorkflowScheduling()` fork

#### Scenario: stalled workflow completed on restart

- **WHEN** `reconcileWorkflow()` finds a running workflow whose child sessions are all terminal
- **THEN** the workflow is completed or cancelled appropriately

### Requirement: DagScheduler layer composition

- `DagScheduler.defaultLayer` MUST self-provide `Dag.Service`, `EventV2Bridge.Service`, `SessionPrompt.Service`, and any transitive deps needed by `startWorkflowScheduling`.
- `DagScheduler.node` MUST list `[EventV2Bridge.node, Dag.node, SessionPrompt.node]` plus any direct construction deps.
- `DagScheduler.defaultLayer` MUST be added to `app-runtime.ts` with `Layer.provideMerge(DagScheduler.defaultLayer)`, matching the `GoalLoop.defaultLayer` placement family.

#### Scenario: DagScheduler resolvable from AppLayer

- **WHEN** the application starts with `Dag.defaultLayer` in the main merge and `DagScheduler.defaultLayer` provided via `provideMerge`
- **THEN** `yield* DagScheduler.Service` succeeds from any AppLayer Effect
- **AND** the scheduler does not subscribe until `init()` is called by bootstrap

### Requirement: no modification to Dag.Service; scheduling internals require completion bridge

- `Dag.Service.create()` MUST remain a pure event publisher.
- `startWorkflowScheduling()` and `startScheduling()` scheduling logic MUST NOT be modified.
- The `maybeComplete` state transitions MUST drive terminal states unchanged.
- **Exception:** `spawn.ts` completion bridge (`NodeCompleted` published from the forked prompt's success channel) is a mandatory prerequisite from `dag-node-completion-semantics`. This bridge MUST be present before the scheduler is wired; without it every workflow deadlocks after its first execution layer.

#### Scenario: create() stays pure

- **WHEN** `Dag.Service.create()` is called
- **THEN** it publishes `WorkflowCreated` → `NodeRegistered` → `WorkflowStarted` events
- **AND** returns the `dagID`
- **AND** does NOT call `startWorkflowScheduling()` itself
