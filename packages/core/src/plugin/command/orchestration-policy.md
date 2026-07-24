# Orchestration Policy

## Execution Mode Selection

Choose the smallest execution mode that can safely complete the request:

1. Use direct execution when one agent can finish the task in its current context without dependent phases.
2. Use a single `task` subagent when one configured specialist is sufficient and no graph-level coordination is needed.
3. Use a `workflow` DAG when the task has staged dependencies, independently parallelizable work, a quality gate, unknown-size discovery, or an explicit multi-role or multi-model requirement.

Outside an explicit `/dag-flow` request, select a DAG only when the request contains both a scenario signal and a structural signal. Scenario signals include multi-role review, brainstorming, swarm or cluster work, multi-model analysis, and end-to-end development. Structural signals include independent viewpoints, multiple work packages, staged gates, unknown-size discovery, and requested iteration. A lone keyword such as "review" is not sufficient.

Explicit user constraints override profile defaults:

- "single agent", "do not use DAG", and "answer directly" disable implicit workflow selection.
- "Do not modify files" does not disable a useful brainstorm or review DAG; it makes every node read-only.
- Preserve named roles, exact model assignments, scope limits, and prohibited actions in every node prompt.

## Role Resolution

Profiles declare capability slots, not fixed agent names. Resolve each slot in this order:

1. an eligible explicit `@agent` assignment from the user;
2. an eligible configured agent whose name or description matches the capability;
3. a compatible documented built-in role;
4. a compatible `explore`, `build`, or `general` fallback.

If a required capability has no eligible role, report the missing capability and do not start the workflow. You MUST NOT invent a `worker_type`.

## Model Assignment

Omit `node.model` by default. Let the existing configuration fallback remain authoritative:

`node.model` → `config.node_defaults.model` → configured agent model → parent session model

Pin a model only when the user supplies an exact provider/model pair for a node or policy slot. Store the provider in `providerID` and only the provider-local `modelID` in `modelID`; never repeat the provider prefix inside `modelID`.

Qualitative labels such as "strong", "fast", or "cheap" may guide capability and role selection, but you MUST NOT invent a model identifier. If the user did not name an exact configured model, use the fallback chain.

## Profile: Brainstorm

Use capability slots such as `scope_explorer`, `viewpoint_generator`, `skeptic`, `constraint_analyst`, and `synthesizer`. Run at least two independent viewpoint nodes in parallel, give them distinct perspectives, then fan in to one synthesizer that compares trade-offs and answers the user's question. The profile is read-only by default.

## Profile: Review

Start with scope discovery only when the review target is unclear. Assign distinct review dimensions—such as specification fit, architecture, correctness, testing, and security—to independent eligible reviewers, then fan in to one downstream arbiter. The arbiter deduplicates findings, resolves conflicts, and emits a structured decision. The profile is read-only by default.

## Profile: Develop

Choose only the phases the task still needs:

1. requirement and codebase exploration;
2. specification and architecture gate;
3. interface and TDD work;
4. business implementation across safe work packages;
5. integration and wiring;
6. parallel review and arbitration;
7. bounded targeted repair;
8. verification, CI when available, final audit, and report.

Omit phases whose evidence is already satisfied. Connect dependent phases explicitly, and run only independent work packages in parallel.

## Gates and Business Verdicts

`required: true` handles execution failure; it does not interpret a successful business verdict. A gate that successfully returns `REVISE` or `REJECT` is a completed node, not a failed node.

Declare `output_schema` for gates and arbiters and normalize `verdict` to `ACCEPT`, `REVISE`, `REJECT`, or `BLOCKED`. Use a downstream `condition` for a static branch. When the decision changes graph shape, set a checkpoint and let the parent select an existing workflow control action.

## Actionable Checkpoints

Normal leaf workers use `report_to_parent: false`. Gates, arbiters, and final auditors use `report_to_parent: true` only when their result requires graph-level action. Their structured output follows this shape:

```json
{
  "verdict": "ACCEPT | REVISE | REJECT | BLOCKED",
  "summary": "string",
  "findings": [],
  "required_actions": [],
  "next_action": {
    "operation": "continue | extend | replan | complete | stop",
    "targets": []
  }
}
```

Do not poll `status` merely to wait. Atomic wake reports actionable checkpoints and workflow terminal outcomes. Use `status` only when the user asks for current state or once before a control decision that requires fresh durable state.

## Bounded Repair

Implement review-and-repair with finite `extend` or `control(replan)` operations. Target only the nodes and findings that require repair. You MUST NOT create cyclic `depends_on`, predeclare unbounded speculative repair waves, or start an unrelated replacement workflow.

Declare a finite `max_node_replan_attempts`. When the ceiling is exhausted, stop with `BLOCKED`, report the remaining findings, and do not retry the identical plan.
