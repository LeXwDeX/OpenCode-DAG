<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
-->

# Harness-DAG-Workflow

A production-grade Directed Acyclic Graph (DAG) workflow engine for LLM agents. Licensed under **GNU AGPL v3**.

> For licensing and attribution boundaries, see [`/NOTICE`](/NOTICE) and [`packages/opencode/src/dag/LICENSE`](../../packages/opencode/src/dag/LICENSE).

## What it does

Harness-DAG-Workflow lets an LLM agent inside an opencode session spin up and drive a multi-node parallel workflow. Typical use cases:

- Decomposing a large refactor task into several parallel sub-agents (each node owns a slice of the repo)
- Driving a multi-stage pipeline (research → plan → implement → verify → review) with dependency edges
- Live replanning mid-workflow when the agent discovers the plan needs reshaping

## Core concepts

- **Workflow** — the top-level DAG; persisted in the `dag_workflows` SQLite table
- **Node** — a single job in the DAG; persisted in `dag_nodes`, namespaced `${workflowId}::${nodeCfgId}`
- **Edge** — declared via `node.dependencies` (string array of upstream node IDs)
- **Iron Laws** — the four inviolable invariants: state machine cannot be bypassed, terminal states irreversible, events must broadcast, persist-first
- **Worker** — a sub-agent spawned per node, signaled back via `node_complete` tool

## Entry points

| Interface | Purpose |
|-----------|---------|
| `/dagworker` slash command | Configure workflows: `list` / `create` / `update` / `validate` / `preview` / `diff` / `inherit` / `register` |
| `/dag-ctl` slash command | Runtime control: `start` / `status` / `cancel` / `list` / `replan` / `open` |
| `dagworker` builtin tool | LLM invokes to spawn a workflow |
| `node_complete` builtin tool | Sub-agent signals node result back to engine |

## Data model (SQLite, 6 tables)

| Table | Purpose |
|-------|---------|
| `dag_workflows` | Workflow header + config |
| `dag_nodes` | Node state + input/output |
| `dag_violations` | Iron-law violation records |
| `dag_workflow_history` | Durable audit log (every workflow-level state change) |
| `dag_node_log` | Per-node event log |
| `dag_schema_version` | Schema migration tracking |

## Iron Laws

All engine code obeys these four invariants — tested in [`packages/opencode/src/dag/AGENTS.md`](../../packages/opencode/src/dag/AGENTS.md):

1. **State machine API cannot be bypassed** — all transitions go through the state machine; direct field mutation is forbidden
2. **Terminal states are irreversible** — `completed` / `failed` / `cancelled` / `archived` never reverse
3. **Every state change emits an event** — downstream subscribers always observe the change
4. **Persist-first ordering** — DB write happens before the in-memory state flip and before the event emission

## Replan: live workflow restructuring

Mid-execution, the LLM agent can replan — add, remove, or update nodes; adjust concurrency caps. The replan runs inside a single `Database.transaction` (5 writes, atomic) with frozen-node enforcement (queued/running/completed/failed/skipped nodes cannot be changed).

## Monitoring

- **LLM side**: `dagworker status` + live system-prompt hints injected every turn
- **External**: read-only HTTP endpoints at `/dag/*` (list workflows, nodes, violations, history)

## Developer guide

For contributors extending this module: [`packages/opencode/src/dag/AGENTS.md`](../../packages/opencode/src/dag/AGENTS.md) covers the design patterns, test organization, and the iron-laws audit matrix.

## License

**GNU Affero General Public License v3**. Modifications must be open-sourced. See [`packages/opencode/src/dag/LICENSE`](../../packages/opencode/src/dag/LICENSE).
