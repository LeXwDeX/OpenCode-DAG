<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
-->

# DAG Worker Reference

Complete protocol specification for OpenCode's DAG workflow engine. This document is the authoritative reference for the `dagworker` and `node_complete` tools, their schemas, state machines, and invariants.

## 1. Overview

The DAG workflow engine is a **background process orchestrator**. Every chat session can spawn an unlimited number of workflows; each workflow runs asynchronously as a detached fiber; the orchestrating agent never blocks waiting for completion. Inspections are made via `dagworker status` / `dagworker list` as needed.

### Architecture at a glance

```
Orchestrating agent (you)
   │
   │  dagworker action=start {...DAGConfig...}
   ▼
dagworker tool  →  create workflow row
               →  materialize N dag_node rows (namespaced IDs)
               →  fork executor fiber
   │
   │  returns { workflowId } IMMEDIATELY
   ▼
Background executor fiber
   │
   │  loop: scheduleReadyNodes (with concurrency budget)
   ▼
spawnReadyNode per ready node
   │
   │  agent.get(worker_type) + sessions.create(parentID) + promptOps.prompt
   ▼
Child agent session  ── calls ──>  node_complete(node_id, status, output/error)
                                     │
                                     ▼
                             Workflow engine marks node terminal,
                             re-schedules next ready nodes
```

## 2. Tool: `dagworker`

### Action: `start`

**Input:**
```ts
{
  action: "start"
  workflow: string          // JSON-stringified DAGConfig (see §3)
  wait?: boolean            // Defaults false. If true, block until completion.
  timeout?: number          // Optional hard timeout in ms.
}
```

**Output:** `{ workflowId, message, nodes }` — always returns immediately unless `wait: true`.

**Errors:** malformed JSON config, validation failure (see §4 hard invariants), permission denied.

### Action: `status`

**Input:**
```ts
{
  action: "status"
  workflow: string          // The workflowId returned from `start`
}
```

**Output:** Full snapshot of the workflow:

```
Workflow <id>:
  Name: <config.name>
  Status: pending | running | completed | failed | cancelled
  Total Nodes: N
  Completed: n  |  Failed: n  |  Running: n  |  Ready: n
  Violations: k
  Violation Details:
    1. [error] required_node_failed: <message>
    ...
  Duration: ...ms  (only when terminal)
```

Use this to **poll progress** while the workflow runs in background.

### Action: `cancel`

**Input:**
```ts
{
  action: "cancel"
  workflow: string          // The workflowId
}
```

**Output:** Confirmation. The executor's next tick detects cancellation and exits cleanly.

### Action: `list`

**Input:** `{ action: "list" }`

**Output:** All workflows in this process:

```
Found N workflow(s):

1. Workflow <id>
   Name: <config.name>
   Status: running
   Nodes: 5
   Session: abc12345...
   Created: 2026-06-07T14:23:11.000Z
   Duration: 12345ms
```

## 3. Tool: `node_complete`

This tool is visible to **child agent sessions** inside workflow nodes — not to the orchestrating agent. Each node MUST call it exactly once when its work is done.

### Signature

```ts
{
  node_id: string           // Format: ${workflowId}::${cfg.id}
  status: "completed" | "failed"
  output?: string           // Required when status='completed'
  error?: string            // Required when status='failed'
}
```

### Explicit-completion discipline

- `node_complete` is the **only** signal the engine recognises.
- If the subagent reaches end-of-turn (idle) without calling `node_complete`, the engine inspects the node's status; if still `running`, it marks the node `failed` with `"node did not call node_complete tool"`.
- If the subagent crashes (uncaught tool error, session error), the outer spawn path marks the node `failed` with the underlying error message and records a `violation` with `type: "execution_failed"`.

The explicit-completion design eliminates ambiguity between "truly done" and "silently stuck."

## 4. Schema: `DAGConfig`

```ts
interface DAGConfig {
  name: string                          // Required. Display name.
  description?: string                  // Optional prose.
  nodes: DAGNodeConfig[]                // 1..20 nodes.
  max_concurrency: number               // 1..10. Cap on parallel spawns.
  timeout_ms?: number                   // Optional hard workflow timeout.
}
```

### Hard invariants

| Invariant | Limit | Consequence of breach |
|---|---|---|
| Node cap | ≤ 20 | `start` rejects with "max_nodes_exceeded" |
| Concurrency | `max_concurrency` ≤ 10 | `start` rejects with "max_concurrency_exceeded" |
| Required nodes | `required: true` nodes cannot be skipped downstream | Failure triggers `required_node_failed` violation |
| No cycles | `dependencies[]` graph must be a DAG | `start` rejects with cycle diagnostic |

### Schedule semantics

The engine recomputes "ready" nodes every 100ms. A node is ready iff:
- Status is `pending`.
- Not already in `spawnedNodes` set (anti-duplicate).
- All `dependencies[]` are `completed`.
- Concurrency budget has room: `running_count < max_concurrency`.

Ready nodes spawn in FIFO-by-iteration order; no explicit priority field.

## 5. Schema: `DAGNodeConfig`

```ts
interface DAGNodeConfig {
  id: string                    // Unique within the workflow. Cannot contain "::".
  name: string                  // Display name.
  description?: string
  dependencies: string[]        // Other node IDs this one waits for.
  required: boolean             // If true, failure blocks downstream completion.
  timeout_ms?: number           // Per-node hard timeout.
  retry?: {
    max_attempts: number        // Total attempts (1 = no retry).
    delay_ms: number            // Backoff between attempts.
  }
  worker_type: string           // Subagent name (must exist in agent catalog).
  worker_config: {
    agent: string               // Same as worker_type.
    prompt: string              // The task given to the subagent.
    // ...any agent-specific fields...
  }
}
```

### Worker Type Resolution

- `worker_type` 必须是目前已注册的 agent 名字；运行时通过 active Agent registry 解析。
- 默认 registry 通常含 `build` / `plan` / `general` / `explore`；`scout` 视 `experimental-scout` 开关而定。
- `implement` / `verify` / `review` / `archgate` / `patcher` 等均为自定义 agent，使用前需在 opencode.json 的 `agent.*` 字段注册。
- 运行时 canonical schema 是 JSON `DAGConfig` / `DAGNodeConfig`（来自 `src/dag/session/types.ts`）；YAML 示例仅为说明，使用前必须转换成等效 JSON。

**Fail-fast**: `dagworker start` validates `worker_type` BEFORE database writes — an unregistered worker_type causes immediate rejection with `"worker_type not found: <name>"`.

### Namespaced ID format

Node IDs in the database are stored as `${workflowId}::${cfg.id}`. This:
- Prevents PK collision across workflows (two workflows may both have a node `build`).
- Lets `node_complete` route by `split("::")[0]` to identify the owning workflow.
- `cfg.id` itself must not contain `::` (would make routing ambiguous).

### Dependency resolution

`dependencies[]` references other `cfg.id` values within the same workflow. At materialization time the engine prefixes each dependency with the workflow's namespace, e.g. for `dependencies: ["build", "lint"]` in a workflow with id `w_123`:
```
Dependencies stored: ["w_123::build", "w_123::lint"]
```

This keeps the dependency-resolution logic uniform.

## 6. Node status state machine

```
pending ─┐
          ├─▶ running ─▶ completed
          │              ─▶ failed
          └─▶ skipped (when required upstream failed)
```

Terminal states (`completed`, `failed`, `skipped`) are **immutable** — no rollbacks.

### Status transitions

| From | To | Trigger |
|---|---|---|
| pending | running | `scheduleReadyNodes` picks it (after metadata.chat_session_id persists §10) |
| pending | failed | Outer `catchCause` on spawn infrastructure failure |
| running | completed | `node_complete` called with `status: "completed"` |
| running | failed | `node_complete` called with `status: "failed"`, OR subagent idle, OR outer `catchCause` |
| running | skipped | Required upstream failed |
| pending | skipped | Required upstream failed |

Terminal states block any further transition (iron law #2).

## 7. Workflow status state machine

```
pending ─▶ running ─▶ completed
                   ─▶ failed
                   ─▶ cancelled
```

### Terminal conditions

- **completed**: all nodes are `completed` OR optional nodes are `skipped`/`failed` but every `required: true` node succeeded.
- **failed**: any `required: true` node is `failed`, OR unhandled error propagates out of the executor fiber.
- **cancelled**: orchestrating agent called `dagworker action=cancel`, OR workflow exceeded `timeout_ms`, OR parent session aborted.

## 8. Violation types

```ts
type DAGViolationType =
  | "required_node_skipped"       // Required node was bypassed
  | "required_node_failed"        // Required node explicitly failed
  | "max_nodes_exceeded"          // Config tried to materialize > 20 nodes
  | "max_concurrency_exceeded"    // Config set max_concurrency > 10
  | "timeout_exceeded"            // Node or workflow timed out
  | "execution_failed"            // Runtime spawn/infrastructure error
```

Severity levels: `error` | `warning` | `info`. Most node-level violations emit `error`-level unless explicitly downgraded by worker config.

## 9. Timeout semantics

| Timeout | Scope | Trigger |
|---|---|---|
| `node.timeout_ms` | Per-node hard deadline | Spawned fiber cancelled, node marked `failed` with `timeout_exceeded` |
| `workflow.timeout_ms` | Whole-workflow deadline | `dag start`'s `timeout` parameter |
| `dagworker start`'s `timeout` field | Hard cap on orchestrator-side call | Executor fiber cancelled, workflow cancelled |

If both node and workflow timeouts are set, whichever fires first wins.

## 10. Retry policy

When a node's `retry` is configured and `max_attempts > 1`:
- First attempt runs normally.
- On failure, if `retry_count < max_attempts - 1`:
  - `status` resets to `pending` (iron-law exception: retry is the sole permitted reversal from `failed`)
  - Sleep `delay_ms`
  - Increment `retry_count`
  - Next scheduler tick picks it up again
- On exhaustion, node stays `failed` permanently.

The retry exception to iron law #2 is explicitly documented in `state-machine/NodeStateMachine.ts`.

## 11. Event bus integration

Every status transition emits an event:

| Event | Emitted on |
|---|---|
| `workflow.started` | Workflow enters `running` |
| `workflow.completed` | All terminal nodes OK |
| `workflow.failed` | Required node failed or fatal error |
| `workflow.cancelled` | Cancel requested or timeout |
| `node.started` | Node enters `running` |
| `node.completed` | Node marked `completed` |
| `node.failed` | Node marked `failed` |
| `node.skipped` | Node marked `skipped` |

These flow through the shared `IEventBus` (set on `DAGSessionService` via `setEventBus` in `src/dag/layer.ts`).

## 12. Examples

### 12.1 Linear pipeline

```json
{
  "name": "Build → Test → Deploy",
  "max_concurrency": 1,
  "nodes": [
    { "id": "build",  "name": "Build",  "dependencies": [],           "required": true, "worker_type": "implement", "worker_config": { "agent": "implement", "prompt": "Run npm build" } },
    { "id": "test",   "name": "Test",   "dependencies": ["build"],    "required": true, "worker_type": "verify",    "worker_config": { "agent": "verify",    "prompt": "Run test suite" } },
    { "id": "deploy", "name": "Deploy", "dependencies": ["test"],     "required": true, "worker_type": "implement", "worker_config": { "agent": "implement", "prompt": "Deploy to staging" } }
  ]
}
```

Runs strictly sequentially: `build` → `test` → `deploy`.

### 12.2 Parallel diamond

```json
{
  "name": "Build → (Lint, Test) → Deploy",
  "max_concurrency": 2,
  "nodes": [
    { "id": "build",  "name": "Build",  "dependencies": [],              "required": true, "worker_type": "implement", "worker_config": { "agent": "implement", "prompt": "npm build" } },
    { "id": "lint",   "name": "Lint",   "dependencies": ["build"],       "required": false, "worker_type": "verify",    "worker_config": { "agent": "verify",    "prompt": "npm lint" } },
    { "id": "test",   "name": "Test",   "dependencies": ["build"],       "required": true,  "worker_type": "verify",    "worker_config": { "agent": "verify",    "prompt": "npm test" } },
    { "id": "deploy", "name": "Deploy", "dependencies": ["lint", "test"], "required": true, "worker_type": "implement", "worker_config": { "agent": "implement", "prompt": "npm deploy" } }
  ]
}
```

`lint` and `test` run in parallel after `build`. Deploy waits for both. `lint` is optional — even if it fails, deploy can proceed so long as `test` wins.

### 12.3 Fan-out with retry

```json
{
  "name": "Process files in parallel",
  "max_concurrency": 5,
  "nodes": [
    { "id": "scan",    "name": "Scan",    "dependencies": [],                   "required": true, "worker_type": "explore",   "worker_config": { "agent": "explore",   "prompt": "List files in target dir" } },
    { "id": "fix_1",   "name": "Fix A",   "dependencies": ["scan"],             "required": true, "worker_type": "implement", "retry": { "max_attempts": 3, "delay_ms": 2000 }, "worker_config": { "agent": "implement", "prompt": "Fix file A" } },
    { "id": "fix_2",   "name": "Fix B",   "dependencies": ["scan"],             "required": true, "worker_type": "implement", "retry": { "max_attempts": 3, "delay_ms": 2000 }, "worker_config": { "agent": "implement", "prompt": "Fix file B" } },
    { "id": "aggregate", "name": "Aggregate", "dependencies": ["fix_1", "fix_2"], "required": true, "worker_type": "implement", "worker_config": { "agent": "implement", "prompt": "Aggregate results" } }
  ]
}
```

Parallel fan-out with exponential retry. `aggregate` runs only when both fixes complete.

## 13. Common pitfalls

1. **Forgetting `node_complete` in subagent prompt**: Always tell the subagent "you MUST call `node_complete` when done." The node's prompt prefix (auto-injected by the engine) includes this reminder, but reinforcing in `worker_config.prompt` is safer.

2. **`::` in `cfg.id`**: Breaks routing. Use plain alphanumeric IDs like `build`, `fix_a`, `step1`.

3. **Cycles**: `A → B → A` will be rejected at `start` time. Run a dry check if the graph is complex.

4. **Not polling status**: `dagworker start` returns immediately. If you want to know when the workflow completes, either poll `dagworker status` periodically, or set `wait: true` on start to block (not recommended for long workflows).

5. **Hardcoding max_concurrency > 10**: Always ≤ 10. The engine enforces this but surfacing a clear error saves round trips.

## 14. Replan protocol

### 14.1 Overview

`dagworker action=replan patch={...}` restructures the *tail* of a running workflow — the portion that hasn't left `pending` status — without cancelling in-flight nodes. The engine atomically:

1. Deletes the specified pending nodes.
2. Applies config/dependency patches to the specified pending nodes.
3. Inserts the newly added nodes (with namespaced IDs).
4. Replaces `dag_workflow.config` with the merged (post-patch) `DAGConfig`.
5. Inserts one `dag_workflow_history` row with `action='replan'`, the pre- and post- state as JSON, a `change_details` JSON blob, and a `history_id`.

All five writes happen inside a single `Database.transaction`. If any step throws, the whole transaction rolls back and the tool returns `{ ok: false, reason, detail }`.

### 14.2 ReplanPatch schema

```ts
interface ReplanPatch {
  workflow_id: string                          // Required. The workflow to replan.
  add_nodes?: DAGNodeConfig[]                  // New nodes. cfg.id must NOT be namespaced.
  remove_nodes?: string[]                      // Namespaced node ids (${workflowId}::${cfg.id}). Must be pending.
  update_nodes?: ReplanNodePatch[]             // Per-node patches. See below.
  new_max_concurrency?: number                 // 1..10. Optional.
  changed_by?: string                          // Free-form audit tag, e.g. "main-agent".
}

interface ReplanNodePatch {
  node_id: string                              // Namespaced.
  new_config?: Partial<Omit<DAGNodeConfig, 'id' | 'dependencies'>>  // Patches everything except id/dependencies.
  new_dependencies?: string[]                  // Full replacement of the dependency list (still un-namespaced).
}
```

### 14.3 ReplanResult shape

Success:
```json
{
  "ok": true,
  "workflow_id": "...",
  "history_id": "history_<ts>_<rand>",
  "nodes_added": 1,
  "nodes_removed": 1,
  "nodes_updated": 2,
  "final_total": 5
}
```

Failure:
```json
{ "ok": false, "reason": "Cannot remove frozen nodes: wf-abc::build", "detail": {} }
```

### 14.4 Frozen vs mutable nodes

Nodes are classified at the moment the replan begins:

| Status | Classification | Notes |
|---|---|---|
| `pending` | Mutable | Patch may remove, update, or rewire dependencies. |
| `queued` | Frozen | Scheduler picked it; may be mid-spawn. |
| `running` | Frozen | Child agent session actively executing. |
| `completed` | Frozen (terminal) | Output already produced. |
| `failed` | Frozen (terminal) | Violation already recorded. |
| `skipped` | Frozen (terminal) | Required-upstream failure path. |

Any `remove_nodes` entry or `update_nodes` entry targeting a frozen/terminal node makes the replan reject.

Workflows whose status is `completed` / `failed` / `cancelled` reject outright.

### 14.5 Validation rules applied at replan time

Before any DB write, `replanWorkflow` runs these checks on the post-patch config:

| Rule | Limit | Failure message |
|---|---|---|
| Node cap | `nodes.length ≤ 20` | `node cap exceeded: N > 20` |
| Concurrency cap | `1 ≤ max_concurrency ≤ 10` | `max_concurrency must be 1..10, got X` |
| Dependency reference resolution | Every `dependencies[i]` resolves to a `cfg.id` in the post-patch graph | `unresolved dependency: node 'a' references 'b'` |
| RequiredNodesValidator | Passes the existing validator | `Validation errors: ...` |
| Required nodes cannot be removed | No `required: true` node appears in `remove_nodes` | `Cannot remove required nodes: ...` |
| No cycles | DFS over the post-patch `dependencies[]` graph | `patch introduces a cycle` |

### 14.6 Atomicity guarantee

The actual DB writes happen inside `atomicReplan`, which wraps them in `Database.transaction((tx) => { ... })`. The callback is synchronous (`Effect.sync` semantics, `NotPromise<T>` return). Any throw inside the callback aborts the SQLite transaction; the surrounding `Effect` collapses it to `{ ok: false, reason, detail }` via `Effect.catchCause`.

The single `dag_workflow_history` row written inside the same transaction is the durable audit record. Each successful replan produces exactly one such row with `action='replan'`.

### 14.7 Worked example — add a verification stage mid-workflow

Three-stage linear pipeline: `build → test → deploy`. `build` and `test` are `completed`; `deploy` is `pending`. We want to interpose a stage `stage-check` between `test` and `deploy`.

```json
{
  "workflow_id": "wf-abc",
  "add_nodes": [{
    "id": "stage-check",
    "name": "Stage Check",
    "dependencies": ["test"],
    "required": true,
    "worker_type": "verify",
    "worker_config": { "agent": "verify", "prompt": "Validate staging deploy readiness" }
  }],
  "update_nodes": [{
    "node_id": "wf-abc::deploy",
    "new_dependencies": ["stage-check"]
  }],
  "changed_by": "main-agent"
}
```

Result:
- `stage-check` materialized as `wf-abc::stage-check` with status `pending`, dependency stored as `["wf-abc::test"]`.
- `deploy`'s dependency rewritten to `["wf-abc::stage-check"]`.
- `dag_workflow.config` updated to reflect the new 4-node graph.
- One `dag_workflow_history` row written with `action='replan'`, `old_state.node_ids = ["wf-abc::build", "wf-abc::test", "wf-abc::deploy"]`, `new_state.node_ids = ["wf-abc::build", "wf-abc::test", "wf-abc::deploy", "wf-abc::stage-check"]`.

### 14.8 Common mistakes

1. **Trying to replan a completed workflow**: Rejected with `Cannot replan a terminal workflow (completed)`. Use a fresh workflow instead.
2. **Trying to remove a frozen node**: Patching/removing a running or completed node is rejected. Only `pending` nodes are mutable.
3. **Introducing cycles**: `A → B → A` in `update_nodes` / `add_nodes` is caught before any DB write.
4. **Forgetting namespaced ids in `remove_nodes` / `update_nodes[].node_id`**: The engine looks them up by the namespaced form; an un-namespaced id silently no-ops (or throws "not found" if the node is required).
5. **Adding a node whose `cfg.id` already exists in the post-patch graph**: The RequiredNodesValidator rejects duplicates.
6. **Bumping `max_concurrency` above 10**: Rejected pre-write.
7. **Removing a `required: true` node**: Always rejected, even if other required nodes complete.
