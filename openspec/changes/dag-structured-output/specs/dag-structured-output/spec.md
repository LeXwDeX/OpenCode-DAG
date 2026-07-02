## ADDED Requirements

### Requirement: Structured output via declared output schema

A node MAY declare an output schema (JSON Schema or equivalent). When declared, the node's completion bridge MUST attempt to parse the child session's final text response as JSON and store the parsed object as `NodeCompleted.output`. When not declared, output remains Level 1 plain text (backward compatible).

#### Scenario: node with output schema produces structured output

- **WHEN** a node declares an output schema
- **AND** the child session's final text part is valid JSON matching the schema
- **THEN** `NodeCompleted.output` is the parsed JSON object
- **AND** downstream nodes can reference fields via `input_mapping: { "var": "nodeID.output.field" }`

#### Scenario: invalid JSON falls back to text

- **WHEN** a node declares an output schema
- **AND** the child session's final text part is not valid JSON
- **THEN** `NodeCompleted.output` falls back to the plain text string (Level 1 behavior)
- **AND** a warning is logged indicating the output schema was not satisfied

#### Scenario: node without output schema uses Level 1 text

- **WHEN** a node does not declare an output schema
- **THEN** `NodeCompleted.output` is the plain text string (Level 1)
- **AND** `input_mapping` field references resolve to `undefined` (documented boundary)

### Requirement: Condition evaluation gates node execution

Before spawning a node that declares a `condition`, the scheduling loop MUST evaluate the condition against upstream node outputs. If the condition evaluates false, the node MUST be skipped (`NodeSkipped` with reason `condition_false`).

#### Scenario: condition true allows spawn

- **WHEN** a node declares `condition: "explore.output.findings_count > 0"`
- **AND** the upstream node `explore` has completed with structured output where `findings_count > 0`
- **THEN** the node is spawned normally

#### Scenario: condition false skips node

- **WHEN** a node declares `condition: "explore.output.findings_count > 0"`
- **AND** the upstream node `explore` has completed with `findings_count = 0` (or no findings_count field)
- **THEN** the node is skipped with `NodeSkipped` reason `condition_false`
- **AND** the node is added to the `done` set (skipped satisfies downstream dependencies)

### Requirement: Input mapping interpolation at spawn time

When spawning a node that declares `input_mapping`, the scheduling loop MUST resolve upstream outputs into template variables and interpolate them into the node's prompt before spawning.

#### Scenario: upstream output interpolated into prompt

- **WHEN** a node declares `input_mapping: { "diff": "refactor.output.changes" }`
- **AND** upstream node `refactor` has completed with structured output `{ "changes": "..." }`
- **THEN** the variable `{{diff}}` in the node's prompt template is replaced with the resolved value
- **AND** the interpolated prompt is passed to the child session

#### Scenario: unresolved mapping leaves placeholder

- **WHEN** a node declares `input_mapping: { "diff": "refactor.output.changes" }`
- **AND** the upstream output does not contain the `changes` field (e.g., Level 1 text output)
- **THEN** the `{{diff}}` placeholder is left as-is in the prompt
- **AND** a warning is logged
