<!--
  Shared workflow-tool guidance. The /dag-flow command prepends its launch
  contract, while the workflow tool uses this neutral reference directly.
-->

# Workflow Orchestration

The `workflow` tool orchestrates heavy tasks as dependency-graph multi-agent workflows. Each node runs as a real child session with its own agent, tools, and optionally its own model. This skill covers when to start a workflow, how to structure it, and how to adapt it at runtime.

## When to start a workflow

A task needs a workflow when ANY of these hold:

- **Staged**: clear phase boundaries where later phases depend on earlier outputs (explore → plan → implement → verify).
- **Parallelizable**: ≥3 independent sub-units can execute concurrently (same fix across 5 packages).
- **Quality gate**: intermediate output must pass review before downstream work begins (architecture review before implementation).
- **Multi-model**: different phases have different cognitive demands and benefit from different models (expensive model for planning, fast model for mechanical edits).

If a task fits in one context window and has no inter-step dependencies, use the `task` tool instead. For trivial work, use direct tools.

## Orchestration Lifecycle

Heavy tasks follow a meta-workflow: multiple workflows chained together, each producing a decision that shapes the next. The lifecycle is not a rigid template — assess the task and enter at the phase that matches its current state.

### Phase 1 — Explore + Brainstorm

Goal: fill in design gaps and understand the project architecture before committing to execution.

When the task description is underspecified, the architecture is unfamiliar, or multiple solution approaches exist, start here. A single workflow runs diverge-converge (multiple generators propose approaches) in parallel with exploration nodes (code-explore, test-explore, config-explore) that map the codebase. The workflow outputs a completed design + architecture inventory.

```yaml
nodes:
  - id: explore-code
    worker_type: explore
    prompt_template: { id: code-explore }
    required: true

  - id: explore-tests
    worker_type: explore
    prompt_template: { id: test-explore }

  - id: gen-approach-a
    worker_type: general
    depends_on: [explore-code]
    prompt_template: { inline: "Propose an approach based on findings." }

  - id: gen-approach-b
    worker_type: general
    depends_on: [explore-code]
    prompt_template: { inline: "Propose an alternative approach based on findings." }

  - id: converge-design
    worker_type: general
    depends_on: [explore-code, explore-tests, gen-approach-a, gen-approach-b]
    required: true
    prompt_template: { id: plan }
```

### Phase 2 — Design Review Gate

Goal: validate the design before execution begins.

A short workflow (or a single gate node) reviews the Phase 1 output. If the design is rejected, replan Phase 1 with adjusted direction. If accepted, proceed to execution.

```yaml
nodes:
  - id: arch-gate
    worker_type: general
    depends_on: []  # receives design from Phase 1 output
    required: true
    model: { modelID: "<strong-model>", providerID: "<provider>" }
    prompt_template: { id: arch-gate }
```

Gate failure cancels the workflow automatically (required: true). Replan by starting a new Phase 1 workflow with the gate's feedback incorporated.

### Phase 3 — Parallel Execution

Goal: implement across independent modules concurrently.

The design from Phase 2 is decomposed into module-level nodes. Each module is a worker node. Modules with no dependencies between them run concurrently (fan-out). A required assembler node collects results.

```yaml
nodes:
  - id: module-auth
    worker_type: build
    prompt_template: { id: implement }
    required: true

  - id: module-server
    worker_type: build
    prompt_template: { id: implement }
    required: true

  - id: module-cli
    worker_type: build
    prompt_template: { id: implement }

  - id: assemble
    worker_type: build
    depends_on: [module-auth, module-server, module-cli]
    required: true
    prompt_template: { id: patcher-assemble }
```

### Phase 4 — Audit + Merge

Goal: verify integration, merge results, update progress tracking.

A workflow runs review nodes (adversarial review pattern) on the assembled output, then a final auditor confirms completeness. Progress tracking (todowrite, OpenSpec tasks, or project board) is updated to reflect what shipped.

### Phase 5 — Expansion Decision

After Phase 4, assess whether the task is complete or needs another cycle:

- **Iterate**: gaps found in audit → start a new Phase 1 or Phase 3 workflow targeting the gaps.
- **Extend**: new work discovered during execution → `extend` the Phase 3 workflow with additional parallel nodes.
- **Complete**: all modules shipped, audit passed → `control(complete)` on remaining workflows, task done.

### Lifecycle Summary

```
Phase 1 (explore + brainstorm)
    ↓ design output
Phase 2 (review gate)
    ↓ pass / fail → replan Phase 1
Phase 3 (parallel execution)
    ↓ module outputs
Phase 4 (audit + merge + progress update)
    ↓
Phase 5 (expand? iterate? complete?)
    ↓ iterate → back to Phase 1 or 3
    ↓ complete → done
```

Not every task needs all five phases. A well-specified task may skip directly to Phase 3. A task with a clear design but uncertain scope may start at Phase 2. The lifecycle is a decision tree, not a pipeline.

## Collaboration Patterns

Four structural patterns cover the common cases. Real workflows often combine them.

### 1. Staged Pipeline with Gate

Sequential phases where each depends on the previous. Insert a gate node between phases to block downstream execution until quality is confirmed.

```yaml
nodes:
  - id: explore
    worker_type: explore
    prompt_template: { id: code-explore, input: { target: "auth module" } }
    required: true

  - id: gate
    worker_type: general
    depends_on: [explore]
    required: true
    prompt_template:
      inline: "Review these findings. Output PASS or FAIL with reasons: {{findings}}"
      input: { findings: "from explore" }

  - id: implement
    worker_type: build
    depends_on: [gate]
    prompt_template:
      inline: "Implement based on approved findings."
```

The gate node is `required: true`. If it fails, the scheduler cancels the workflow instead of spawning `implement` — this is automatic. Design gate prompts to output a clear pass/fail signal.

### 2. Parallel Fan-out

One preparatory node feeds N independent worker nodes, which fan back into a single assembler.

```yaml
nodes:
  - id: discover
    worker_type: explore
    prompt_template: { inline: "List all packages that need the API migration." }
    required: true

  - id: migrate-auth
    worker_type: build
    depends_on: [discover]
    prompt_template: { inline: "Migrate the auth package to the new API." }

  - id: migrate-server
    worker_type: build
    depends_on: [discover]
    prompt_template: { inline: "Migrate the server package to the new API." }

  - id: migrate-cli
    worker_type: build
    depends_on: [discover]
    prompt_template: { inline: "Migrate the CLI package to the new API." }

  - id: assemble
    worker_type: build
    depends_on: [migrate-auth, migrate-server, migrate-cli]
    prompt_template: { inline: "Run integration tests and assemble a summary." }
```

`migrate-*` nodes execute concurrently (bounded by `max_concurrency`). `assemble` waits until all three complete. Non-required worker nodes that fail do not cancel the workflow — `assemble` still runs and can report which migrations failed.

### 3. Adversarial Review

Multiple reviewer nodes with different perspectives examine the same artifact. A final arbiter synthesizes their verdicts.

```yaml
nodes:
  - id: implement
    worker_type: build
    prompt_template: { id: implement }
    required: true

  - id: review-arch
    worker_type: general
    depends_on: [implement]
    model: { modelID: "gpt-4o", providerID: "openai" }
    prompt_template: { id: review-arch }

  - id: review-logic
    worker_type: general
    depends_on: [implement]
    prompt_template: { id: review-logic }

  - id: review-style
    worker_type: general
    depends_on: [implement]
    model: { modelID: "claude-sonnet", providerID: "anthropic" }
    prompt_template: { id: review-style }

  - id: arbitrate
    worker_type: general
    depends_on: [review-arch, review-logic, review-style]
    required: true
    prompt_template:
      inline: "Three reviewers produced verdicts. Synthesize a final decision: ACCEPT, REJECT, or REVISE with specific actions."
```

Reviewer nodes use different models to avoid single-model blind spots. The arbiter is `required: true` — its failure signals that the artifact could not be confidently accepted.

### 4. Diverge-Converge (Brainstorm)

Multiple independent generators produce candidate solutions; a converger selects and refines.

```yaml
nodes:
  - id: gen-a
    worker_type: general
    prompt_template:
      inline: "Propose a solution for X using approach: microservices."

  - id: gen-b
    worker_type: general
    prompt_template:
      inline: "Propose a solution for X using approach: modular monolith."

  - id: gen-c
    worker_type: general
    prompt_template:
      inline: "Propose a solution for X using approach: event-driven."

  - id: converge
    worker_type: general
    depends_on: [gen-a, gen-b, gen-c]
    required: true
    prompt_template:
      inline: "Three approaches were proposed. Compare trade-offs and select the best fit for the constraints."
```

## Adaptive Replanning

Workflows are not static. After creating a workflow, use `extend` and `control(replan)` to adapt based on observed results:

- **Scale up**: a node reports the work is larger than expected → `extend` with additional parallel nodes to split the load.
- **Cut short**: a node proves the remaining work is unnecessary → `control(complete)` to early-complete and skip pending nodes.
- **Redirect**: a gate or review reveals a wrong direction → `control(replan)` with `restart: true` on the affected nodes and `cancel: true` on their downstream dependents.

Node outputs are reported back on completion. When a report suggests the task decomposition was wrong, replan rather than letting the original graph run to completion.

### Escalation: change approach after repeated failures

When the same node or workflow keeps failing — via `orchestrator_unresponsive` (the woken agent took no action), a replan-attempt ceiling rejection, or repeated review failures — **change your approach** rather than retrying the identical plan. Try a different decomposition, a different model, a simpler prompt, or break the node into smaller steps. Repeating the same failing plan wastes budget without progress.

## Model Assignment Strategy

Each node MAY specify `model: { modelID, providerID }` to pin a specific model. If omitted, the node uses its agent's default model.

- Expensive models for planning, review, and arbitration — high-stakes decisions where reasoning quality matters.
- Fast models for mechanical implementation — well-specified edits where speed and cost matter.
- Diverse models in adversarial review — reduces single-model blind spots.

## Prompt Templates

Templates are read-only prompt fragments under `.opencode/dag-prompts/*.md`. Reference them by ID; they are read on spawn. Available templates:

- `code-explore`: Search codebase structure, output file paths + responsibilities
- `test-explore`: Search test structure, output coverage gaps
- `config-explore`: Search config/deploy files, output config inventory
- `arch-gate`: Review architecture constraints and approve direction
- `implement`: Implement per specification
- `verify`: Verify completeness and compatibility
- `plan`: Synthesize findings into a structured plan
- `review-arch`: Review from architecture perspective
- `review-logic`: Review from logic correctness perspective
- `review-style`: Review from code style perspective
- `patcher-assemble`: Assemble clean patch from completed work
- `integration-test`: Run integration tests and report

For ad-hoc prompts, use `prompt_template: { inline: "...", input: {...} }`. Inline templates support `{{var}}` interpolation from `input`.

## Budget Declaration

The engine faithfully executes declared budgets and circuit-breaks on ceiling breach. It does not adaptively adjust — declare what your task needs. Choose values based on task complexity:

- `max_concurrency`: default 5. For independent fan-out (e.g., generating 100 images, migrating 10 packages), declare 10–20 so nodes aren't serialized behind an artificially narrow pipe.
- `max_node_replan_attempts`: default 5. Increase only if you expect iterative quality-driven convergence (review → revise → review cycles on a single artifact).
- `max_total_nodes`: default 100. Increase for large-scale decompositions.
- `worker_config.timeout_ms`: default 10 minutes. Increase for long-running nodes (compilation, large test suites).

## Single-Workspace Discipline

All nodes share the same workspace. Write conflicts are an orchestration concern, not an infrastructure one. Two tiers:

**Tier A — Disjoint write sets**: parallel nodes that write to non-overlapping files/paths can run concurrently without coordination. Structure the decomposition so each node owns a distinct module or file set.

**Tier B — Propose-then-assemble**: when disjoint write sets cannot be guaranteed, parallel nodes should only produce proposals (structured output via `output_schema` + `submit_result`), not directly write files. A single assembly node then applies the changes sequentially. The review point converges on the assembly node's diff, not on scattered parallel edits.

## Design Principles

- Each node is a real child session with its own message history, tools, and context window. There is no shared memory between nodes — data flows only through `depends_on` and `input_mapping`.
- `required: true` means failure cancels the entire workflow. Use it for nodes whose output is indispensable (gates, core implementation). Omit it for nodes whose failure is recoverable.
- Layers are computed automatically from `depends_on`. Nodes in the same layer execute concurrently up to `max_concurrency`. Do not try to control execution order beyond declaring dependencies.
- When a node declares `output_schema`, the child agent must call `submit_result` to submit its structured result. Failure to call `submit_result` before the session ends results in node failure (`verdict_fail`). Nodes without `output_schema` use plain text output (the final text part of the session).

## Tool Reference

### Actions

**start** — Create a workflow from a YAML-declared graph. Returns the workflow ID. Nodes declare `depends_on` (node IDs); layers and execution order are computed automatically.

**extend** — Add nodes to a running workflow. Existing nodes are unaffected; new nodes are immediately eligible for scheduling if their dependencies are met.

**status** — Read the durable state of one workflow and all of its nodes. Pass `workflow_id`. Use it whenever the user asks whether a workflow is running, when progress is uncertain, or before deciding whether to replan/control a workflow.

**control** — Control a running workflow:
- `pause` — let running nodes finish, don't spawn new ones
- `resume` — resume scheduling
- `cancel` — cancel the entire workflow
- `replan` — submit a YAML fragment; running nodes can be `restart: true` or `cancel: true`; pending nodes absent from the fragment are cancelled
- `complete` — early-complete: remaining pending nodes are skipped (non-violation)
- `step` — advance exactly one ready node (the first by node ID lexicographic order), then wait. Use for controlled debugging or staged verification of a critical path. Unlike `pause`, which freezes all scheduling, `step` advances one node and re-waits. A second `step` while the stepped node is still running is rejected. Use `resume` to return to full-speed scheduling. Nodes are selected in lexicographic ID order for determinism.

### Node Fields

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
| `report_to_parent` | no | If true, the parent agent is woken when this node completes or fails. The workflow's terminal status always wakes the parent regardless of this flag |
| `worker_config` | no | `{ timeout_ms }` — bounds node execution (defaults to 10 minutes if omitted) |
| `output_schema` | no | JSON Schema; when declared, the child agent must call `submit_result` to submit structured output — failure to submit results in node failure |
| `restart` | no | (replan only) Re-spawn this running node with new prompt |
| `cancel` | no | (replan only) Cancel this node |

### What NOT to expect

- No `node_complete` action — completion is automatic
- No `list` / `history` actions — inspect a known workflow with `status`; broader browsing remains TUI-only
- No topology templates — templates are prompt fragments only; you design the graph
