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

### Action: `template_list`

**Purpose:** list the built-in reusable DAG templates available to the orchestrating agent.

**Input:** `{ action: "template_list" }`

**Output:** JSON array with `id`, `name`, `description`, `tags`, and `requiredAgents`.

### Action: `template_show`

**Purpose:** render one built-in template into a concrete `DAGConfig` without starting it.

**Input:**
```ts
{
  action: "template_show"
  template_id: string
  template_input?: string   // JSON-stringified DAGTemplateInput. Defaults to { goal: "" }.
}
```

**Output:** template metadata plus `config`, the generated `DAGConfig`.

### Action: `template_start`

**Purpose:** render one built-in template and immediately start the generated workflow.

**Input:**
```ts
{
  action: "template_start"
  template_id: string
  template_input: string    // JSON-stringified DAGTemplateInput; requires at least { goal: string }.
}
```

**Output:** `{ workflowId, templateId, message, nodes }`.

### Template authoring, discovery, and inspection

Templates are code-level factories, not chat-session records:

| Need | Canonical path / action |
|---|---|
| Write or change a built-in template | Edit `packages/opencode/src/dag/integration/templates/index.ts`: add a `DAGTemplate`, append its id to `DAG_TEMPLATE_IDS`, and register it in `registry`. |
| Discover templates as an agent | `dagworker { action: "template_list" }`. |
| Read one template's generated `DAGConfig` | `dagworker { action: "template_show", template_id, template_input? }`. |
| Start from a template | `dagworker { action: "template_start", template_id, template_input }`. |
| Inspect a hand-written workflow created by an agent | It is not a named template. After `dagworker start`, inspect the workflow instance with `list` / `status` / `node_detail` / `history` / `logs`. |

There is no runtime custom-template store. If an agent hand-writes a JSON `workflow` and calls `dagworker start`, the resulting object is a workflow instance persisted under its `workflowId`; it does not appear in `template_list`. To make that shape reusable as a named template, move it into `templates/index.ts` and register it.

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
    agent: string               // Agent-name override. See "Recognized worker_config keys" below.
    prompt: string              // The task given to the subagent.
    // ...any agent-specific fields...
  }
  condition?: DAGNodeCondition  // Optional declarative skip/ready (WP-B1).
  input_mapping?: DAGInputMapping  // Optional declarative upstream data injection (WP-C1).
}
```

#### Recognized `worker_config` keys

| Key | Type | Effect |
|---|---|---|
| `agent` | string | Agent-name override. When present, child session uses `agent` instead of `worker_type` for `agent.get(...)` resolution. Usually `agent === worker_type`; only specify when they diverge. |
| `prompt` | string | Task prompt handed to the child subagent. |
| `use_worktree` | `true` | Opt-in per-node git worktree isolation (default `false`). |
| `subDagConfig` | `DAGConfig` | Reserved for `worker_type === "dag"` (sub-DAG dispatch, depth ≤ 3). |

#### `condition` (WP-B1 — declarative skip/ready)

```ts
type DAGNodeCondition = {
  ref_node: string              // Upstream node id (must be in this node's dependencies).
  op: "eq" | "ne" | "gt" | "lt" | "gte" | "lte" | "exists" | "not_exists"
  value?: unknown               // Comparison baseline (ignored for exists/not_exists).
}
```

- Evaluate upstream node's output using `op` against `value`.
- Result `false` → node marked `skipped` (not `failed`) and transitive downstream is also skipped.
- **`required: true` nodes cannot declare `condition`** — schema rejects the config.
- Missing in config (or `null`) → unconditional execution (backward-compatible).

#### `input_mapping` (WP-C1 — declarative upstream data injection)

```ts
type DAGInputMapping = Record<
  string,                       // inputKey
  { ref_node: string, ref_path?: string }
>
```

- For each `inputKey`, pull `ref_node`'s output (or a JSON-path sub-field via `ref_path`) at spawn time and inject into the node's prompt.
- `ref_node` must be a member of `dependencies[]` (schema enforced).
- Safe defaults: `null_output`, `non_object_output`, `path_not_found`, `beyond_deps` → audit as `skipped` with a reason code; node runs without that key.
- Per-entry and per-total payload caps enforced by engine (truncated).

### Worker Type Resolution

- `worker_type` 必须是目前已注册的 agent 名字；运行时通过 active Agent registry 解析。
- 默认 registry 通常含 `build` / `plan` / `general` / `explore`；`scout` 视 `experimental-scout` 开关而定。
- `implement` / `verify` / `review` / `archgate` / `patcher` 等均为自定义 agent，使用前需在 opencode.json 的 `agent.*` 字段注册。
- 运行时 canonical schema 是 JSON `DAGConfig` / `DAGNodeConfig`（来自 `src/dag/session/types.ts`）。

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
pending ─▶ queued ─▶ running ─▶ completed
  │             │                ─▶ failed ─┐
  │             │                            │ retry (max_attempts not exhausted)
  │             └─▶ skipped                  │ (the SOLE permitted reversal)
  └─▶ skipped (when required upstream        ▼
         failed or condition is false)     pending
```

Terminal states (`completed`, `failed` when retries exhausted, `skipped`) are **immutable**.

The `queued` state means: dependencies resolved, but the node is waiting for an execution slot (`running_count < max_concurrency`). It is NOT `running` yet.

### Status transitions

| From | To | Trigger |
|---|---|---|
| pending | queued | `scheduleReadyNodes` resolves dependencies and admits the node |
| pending | failed | Outer `catchCause` on spawn infrastructure failure |
| pending | skipped | Required upstream failed |
| queued | running | Spawn fiber actually starts the child session |
| queued | skipped | Required upstream failed |
| running | completed | `node_complete` called with `status: "completed"` |
| running | failed | `node_complete` called with `status: "failed"`, OR subagent idle (`node_complete_missing`), OR outer `catchCause`, OR timeout |
| running | skipped | Required upstream failed |
| running | pending | `condition` evaluated to `false` (→ actually `skipped`); same slot as `running → skipped` |
| failed | pending | Retry reversal: `retry_count < max_attempts - 1` (sole exception to iron law #2) |

Terminal states block any further transition (iron law #2), except retry `failed → pending`.

## 7. Workflow status state machine

```
pending ─▶ running ─▶ completed
              │      ─▶ failed
              │      ─▶ cancelled
              └─▶ paused ─▶ running  (resume / step)
                 │         ─▶ cancelled
                 │
                 └──▶ (stays paused unless resumed / stepped / cancelled)
```

### Status transitions

| From | To | Trigger |
|---|---|---|
| pending | running | First node starts |
| pending | cancelled | `dagworker action=cancel` on a `pending` workflow |
| running | completed | Last required node succeeds |
| running | failed | Required node failed or unrecoverable error |
| running | cancelled | `dagworker action=cancel`, timeout, parent session abort |
| running | paused | `dagworker action=pause` |
| paused | running | `dagworker action=resume` |
| paused | cancelled | `dagworker action=cancel` (the only terminal transition out of `paused`) |

**Note about `step`**: `dagworker action=step` keeps the workflow in `paused` the entire time — it executes exactly one ready node (synchronous from the step request's view), then returns. The workflow never reaches `running` during a step.

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
  | "process_orphan"              // Orphan process detected during recovery
  | "condition_skipped"           // Node condition evaluated to false (skipped)
  | "subdag_depth_exceeded"       // Sub-DAG nesting depth > 3
  | "subdag_timeout"              // Sub-DAG lifecycle bridge timeout
```

Severity levels: `critical` | `error` | `warning` | `info`. Most node-level violations emit `error`-level unless explicitly downgraded by worker config.

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
| `workflow.paused` | Workflow moves `running → paused` |
| `workflow.resumed` | Workflow moves `paused → running` |
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
