# DAG Workflow: core\-headless\-test

| Field | Value |
|-------|-------|
| **Workflow ID** | `workflow\_1782099694131\_x6bhg6rl4v8` |
| **Name** | core\-headless\-test |
| **Nodes** | 2 |
| **Max Concurrency** | 2 |

## Nodes

| # | ID | Worker | Deps | Required | Timeout |
|---|-----|--------|------|----------|---------|
| 1 | `A` | `general` | \- | yes | default |
| 2 | `B` | `general` | A | yes | default |

## Dependency Graph

```
  [A]
  [A] ──→ [B]
```
