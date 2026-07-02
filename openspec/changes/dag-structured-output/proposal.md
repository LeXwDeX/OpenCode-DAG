## Why

The DAG engine declares a data-flow layer — `input_mapping` ("pass nodeA's output to nodeB as a variable"), `condition` ("skip nodeC if nodeA.output.count < 1"), and `report_strategy` convergence — but **none of it works**. The entire data-flow layer is built on a foundation that does not exist: structured node output.

The `dag-node-completion-semantics` change (Level 1) defines node output as the final text part of the prompt result — a plain string. But `input_mapping` expects `nodeID.output.field` (field-level access into a structured object), and `condition` evaluates expressions like `nodeA.output.findings.size > 0`. With a string output, `resolvePath("field", { output: "some text" })` returns `undefined`. The `eval.ts` functions (`evaluateCondition`, `resolveInputMapping`) are defined and tested in isolation but have **zero callers** — they have never been wired because there is nothing to wire them to.

```
Current state:
  NodeCompleted.output = "The refactored code passes all tests."  (plain text)

What input_mapping expects:
  input_mapping: { "diff": "refactor-core.output.diff" }
  → resolvePath("diff", { output: "The refactored code passes all tests." })
  → undefined  ← always

What condition expects:
  condition: "refactor-core.output.tests_passed > 0"
  → resolvePath(...) → undefined → comparison fails → condition always false
```

This means the DAG is a **task sequencer** (B runs after A), not a **workflow engine** (B receives A's structured result and makes decisions based on it). For DAG patterns that require data passing — scatter/gather, conditional branching, convergence checks — the engine cannot function.

## What Changes

This change defines **Level 2 structured output** — how a DAG node produces a structured result that downstream nodes can reference by field path.

- **Define the output contract (Level 2).** A node's output is structured when the node's `prompt_template` includes an output directive (e.g., `{{output_schema:json}}` or a dedicated `output_schema` field in `NodeConfig`). The child session's final text response is parsed as JSON and stored as the `NodeCompleted.output`. Without a declared schema, output remains Level 1 plain text (backward compatible).

- **Wire `eval.ts` into the scheduling + spawn path.** `evaluateCondition` is called before spawning a node: if the condition evaluates false, the node is skipped (`NodeSkipped` with reason `condition_false`). `resolveInputMapping` is called at spawn time: upstream outputs are resolved into template variables and interpolated into the node's prompt.

- **Define how agents produce structured output.** Options to evaluate:
  - (A) The prompt template instructs the agent to emit JSON as its final response; the completion bridge attempts `JSON.parse` on the final text part.
  - (B) The agent calls a `node_output` tool with structured data; the tool's result becomes the node output.
  - (C) A post-processing step extracts structured data from the agent's response using a declared schema.

- **Make `input_mapping` and `condition` functional.** Once structured outputs are available, `resolveInputMapping` populates template variables (e.g., `{{diff}}`), and `evaluateCondition` gates node execution.

## Capabilities

### New Capabilities
- `dag-structured-output`: Level 2 node output contract — structured JSON output via declared schema, `eval.ts` wired into scheduling (condition gating + input mapping), backward-compatible fallback to Level 1 plain text when no schema is declared.

## Impact

- **Changed code:** `packages/opencode/src/dag/runtime/scheduling.ts` (condition evaluation before spawn), `spawn.ts` or `templates/resolve.ts` (input mapping interpolation), `eval.ts` (finally gets callers).
- **New decisions needed:** how agents produce structured output (prompt instruction vs. tool vs. post-processing). This is a design exploration, not a settled decision.
- **Risk:** moderate. The Level 1 / Level 2 boundary must be clean — nodes without a declared output schema continue to work with plain text. The JSON parsing path must be defensive (malformed JSON → fall back to text).
- **Depends on:** `dag-node-completion-semantics` (Level 1 must work first).
- **Can run in parallel with:** `dag-scheduler-durability` and `dag-scheduling-correctness` (orthogonal concern).
