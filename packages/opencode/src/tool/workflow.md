# Workflow Tool

Create and control dependency-graph multi-agent workflows. Each node runs as a real child session with its own agent, tools, and optionally its own model.

For collaboration patterns (staged pipelines, parallel fan-out, adversarial review, brainstorm), when to use this tool vs. `task`, and adaptive replanning strategy, load the `workflow` skill.

## Actions

### start
Create a workflow from a YAML-declared graph. Returns the workflow ID.

Nodes declare `depends_on` (node IDs). Layers and execution order are computed automatically — do not declare them.

```yaml
nodes:
  - id: explore-src
    name: Explore source
    worker_type: explore
    depends_on: []
    required: true
    prompt_template:
      id: code-explore
      input: { target: "auth module" }

  - id: plan
    name: Plan refactor
    worker_type: plan
    depends_on: [explore-src]
    prompt_template:
      inline: "Review {{findings}} and plan the refactor."
      input: { findings: "from explore-src" }
```

### extend
Add nodes to a running workflow. Existing nodes are unaffected; new nodes are immediately eligible for scheduling if their dependencies are met. Use when a node's output reveals more parallel work is needed.

### control
Control a running workflow. Operations:

- `pause` — let running nodes finish, don't spawn new ones
- `resume` — resume scheduling
- `cancel` — cancel the entire workflow
- `replan` — submit a subsequent YAML fragment; running nodes can be `restart: true` or `cancel: true`; pending nodes absent from the fragment are cancelled
- `complete` — early-complete: remaining pending nodes are skipped (non-violation)

## Node Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique node identifier, used in `depends_on` |
| `name` | yes | Human-readable name |
| `worker_type` | yes | Agent type (`explore`, `build`, `general`, `plan`, or custom) |
| `depends_on` | yes | Array of node IDs this node waits for (`[]` for root) |
| `required` | no | If true and this node fails, the workflow is cancelled. Default: false |
| `prompt_template` | yes | `{ id: "..." }` or `{ inline: "...", input: {...} }` |
| `model` | no | `{ modelID, providerID }` override |
| `condition` | no | Expression evaluated before spawn; node is skipped if false |
| `input_mapping` | no | Map upstream node outputs into template variables |
| `report_to_parent` | no | If true, the parent agent is automatically woken when this node completes or fails. The workflow's terminal status always wakes the parent regardless of this flag |
| `worker_config` | no | `{ use_worktree, timeout_ms, retry: { max_attempts, delay_ms } }` — `timeout_ms` bounds node execution (defaults to 10 minutes if omitted) |
| `restart` | no | (replan only) Re-spawn this running node with new prompt |
| `cancel` | no | (replan only) Cancel this node |

## What NOT to expect

- No `node_complete` action — completion is automatic
- No `status` / `list` / `history` actions — those are TUI-only via HTTP routes
- No topology templates — templates are prompt fragments only; you design the graph
