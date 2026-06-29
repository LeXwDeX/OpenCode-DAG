# DAG Workflow: fh\-agent\-ok

| Field | Value |
|-------|-------|
| **Workflow ID** | `workflow\_1782050472452\_cb9ufxbxhvl` |
| **Name** | fh\-agent\-ok |
| **Nodes** | 1 |
| **Max Concurrency** | 1 |

## Nodes

| # | ID | Worker | Deps | Required | Timeout |
|---|-----|--------|------|----------|---------|
| 1 | `A` | `general` | \- | yes | default |

## Failure Handler

- **Agent**: `diagnoser`
- **Max Recoveries**: unlimited
