# DAG Workflow: core\-headless\-test

| Field | Value |
|-------|-------|
| **Workflow ID** | `workflow\_1782101897145\_qg8zzgnp1gb` |
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
