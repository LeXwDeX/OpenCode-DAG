# ADR 002: DAG Control Mutations via HTTP POST

## Status
**Accepted** — 2026-06-07

## Context

### Problem
P2 (pause/resume control surface) reveals an architecture conflict:
- **Core layer**: state-machine has full pause/resume support (PAUSED status, DAG_PAUSE/DAG_RESUME transitions, workflow.paused/resumed events)
- **Session layer**: DAGWorkflowStatus explicitly omits 'paused' (ARCHITECTURE.md:198: "Session 层省略 PAUSED / ARCHIVED（DB 无需区分暂停/归档）")
- **HTTP API**: §9.a mandates all DAG endpoints are read-only, no state mutation
- **TUI**: console-route.tsx:12 declares "TUI 只读：任何写必须经 server API"
- **Tool actions**: dagworker cancel/replan is the established mutation pattern (bypasses HTTP)

### User requirement
Expose pause/resume controls across all three surfaces:
1. Tool action: `dagworker {action: "pause", workflow_id: "..."}`
2. HTTP endpoint: `POST /dag/pause/:workflowId`
3. TUI button: keyboard shortcut + clickable control in workflow detail view

### Architecture conflict
Adding HTTP POST endpoints violates §9.a ("HTTP endpoints are read-only, no state mutation").

## Decision

Amend ARCHITECTURE.md §9.a to establish a **two-tier HTTP API model**:

1. **DAG Query API** (`/api/v1/dag/*`) — remains read-only (existing §9.a mandate)
   - Endpoints: listWorkflows, getWorkflow, getTimeline, getStats, getViolations, getWorkflowHistory, getNodeLogs
   - Source: DAGQuery ← session-service (read-only data source)

2. **DAG Control API** (`/api/v1/dag/control/*`) — allows state mutations (new tier)
   - Endpoints: POST pause/:workflowId, POST resume/:workflowId (future: POST cancel/:workflowId)
   - Source: WorkflowEngine (direct call, bypasses DAGQuery which is read-only)
   - Guard: permission check via Effect authorization

### Rationale
- **Separation of concerns**: Query API optimized for reads; Control API for mutations
- **Backward compatibility**: Existing DAG Query API unchanged; new Control API is additive
- **Explicit scope**: Control API limited to workflow lifecycle mutations (pause/resume/cancel)
- **Permission boundary**: Control API requires explicit authorization (not implicit in read-only pattern)
- **TUI integration**: TUI buttons call Control API, maintaining "TUI 只读：任何写必须经 server API" principle

## Implementation

### Architecture amendment
Update ARCHITECTURE.md §9.a:
```
§9.a HTTP endpoint patterns

- **Query endpoints** (`/api/v1/dag/*`): read-only, no state mutation. Source: DAGQuery.
  Pattern: `Effect.fn("DagHttpApi.<method>")(function* () { yield* ... })`

- **Control endpoints** (`/api/v1/dag/control/*`): state mutations (pause/resume/cancel).
  Source: WorkflowEngine (direct call). Requires permission guard.
  Pattern: `Effect.fn("DagControlApi.<method>")(function* () { yield* workflowEngine.pauseWorkflow(...) })`
```

### Session layer changes
- Add 'paused' to DAGWorkflowStatus union (session/types.ts:28)
- Add pause event mapper case (session-service.ts:95-115)

### WorkflowEngine changes
- Add pauseWorkflow(workflowId: string): Effect<void, DAGError, never>
- Add resumeWorkflow(workflowId: string): Effect<void, DAGError, never>
- Pattern: similar to cancelWorkflow (L840), but status='paused' + handle running nodes (pause them individually)

### HTTP Control API
- New file: `groups/dag-control.ts` (separate from read-only `groups/dag.ts`)
- Endpoints: POST /api/v1/dag/control/pause/:workflowId, POST /api/v1/dag/control/resume/:workflowId
- Handlers: call WorkflowEngine directly (not DAGQuery)
- Permission guard: check user has workflow-mutation permission

### Bridge event forwarding
- Update dag-bus-bridge.ts:132-148 to handle workflow.paused/resumed
- Add DagWorkflowPaused, DagWorkflowResumed event types to dag-events.ts
- Forward to platform bus: workflow.paused → dag.workflow.paused, workflow.resumed → dag.workflow.resumed

### TUI buttons
- Add pause/resume buttons to console-route.tsx (workflow detail view)
- Keyboard shortcut: 'p' for pause, 'r' for resume (when workflow selected)
- Call Control API via HTTP POST

## Consequences

### Positive
- Full-stack pause/resume implementation (Tool + HTTP + TUI)
- Clear separation between Query API (read-only) and Control API (mutations)
- TUI buttons work within "只读：任何写必须经 server API" principle
- Bridge forwards pause/resume events (TUI can react in real-time)
- Statistics include paused_count (query layer aware of PAUSED state)

### Negative
- More complex HTTP API (two route groups instead of one)
- Additional permission layer for Control API
- Session layer now has 'paused' status (slightly more complex state machine)

### Neutral
- ARCHITECTURE.md §9.a becomes two-tier (Query vs Control)
- Tool actions and HTTP Control API are parallel paths (both call WorkflowEngine)

## References
- ADR 001: DAG recommended module library (P1)
- ARCHITECTURE.md §9.a: HTTP endpoint patterns
- ARCHITECTURE.md:198: Session layer status omissions
- state-machine/types.ts:33 — WorkflowStatus.PAUSED
- state-machine/errors.ts:528-535 — RUNNING↔PAUSED transitions
- dagworker.ts:353-378 — cancel action pattern (to emulate)
