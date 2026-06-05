-- DAG Workflow Persistence Schema
-- Independent from OpenCode Session system

-- ============================================================================
-- DAG Workflow Table
-- ============================================================================
CREATE TABLE dag_workflow (
  workflow_id TEXT PRIMARY KEY,                    -- wf_<timestamp>_<random>
  chat_session_id TEXT NOT NULL,                   -- Reference to OpenCode session
  workflow_name TEXT NOT NULL,                     -- Human-readable name
  config TEXT NOT NULL,                             -- JSON: complete workflow config
  status TEXT NOT NULL DEFAULT 'pending',           -- pending | running | completed | failed | cancelled | failed_with_violations
  current_progress TEXT,                            -- JSON: progress snapshot
  metadata TEXT,                                    -- JSON: additional metadata
  created_at INTEGER NOT NULL,                     -- Unix timestamp (ms)
  updated_at INTEGER NOT NULL,                     -- Unix timestamp (ms)
  started_at INTEGER,                              -- Unix timestamp (ms)
  completed_at INTEGER                             -- Unix timestamp (ms)
);

-- Index for querying workflows by chat session
CREATE INDEX idx_dag_workflow_chat_session 
  ON dag_workflow(chat_session_id);

-- Index for querying workflows by status (for filtering)
CREATE INDEX idx_dag_workflow_status 
  ON dag_workflow(status);

-- Index for querying recent workflows
CREATE INDEX idx_dag_workflow_created_at 
  ON dag_workflow(created_at DESC);

-- ============================================================================
-- DAG Node Table
-- ============================================================================
CREATE TABLE dag_node (
  node_id TEXT PRIMARY KEY,                        -- node_<timestamp>_<random>
  workflow_id TEXT NOT NULL,                        -- Reference to workflow
  chat_session_id TEXT NOT NULL,                    -- Denormalized for easier querying
  node_name TEXT NOT NULL,                          -- Human-readable name
  node_type TEXT NOT NULL,                          -- 'code' | 'review' | 'test' | etc.
  config TEXT NOT NULL,                             -- JSON: node-specific config
  status TEXT NOT NULL DEFAULT 'pending',           -- pending | running | completed | failed | cancelled | skipped
  input_data TEXT,                                  -- JSON: input payload
  output_data TEXT,                                 -- JSON: output payload
  error_message TEXT,                               -- Error message if failed
  error_stack TEXT,                                 -- Error stack trace if failed
  retry_count INTEGER NOT NULL DEFAULT 0,           -- Number of retries performed
  max_retries INTEGER NOT NULL DEFAULT 3,           -- Maximum allowed retries
  timeout_ms INTEGER,                               -- Node timeout in milliseconds
  required_nodes TEXT,                              -- JSON array: required node IDs
  dependency_nodes TEXT,                            -- JSON array: dependency node IDs
  created_at INTEGER NOT NULL,                     -- Unix timestamp (ms)
  updated_at INTEGER NOT NULL,                     -- Unix timestamp (ms)
  started_at INTEGER,                              -- Unix timestamp (ms)
  completed_at INTEGER,                            -- Unix timestamp (ms)
  duration_ms INTEGER,                             -- Execution duration (ms)
  FOREIGN KEY (workflow_id) REFERENCES dag_workflow(workflow_id)
    ON DELETE CASCADE
);

-- Index for querying nodes by workflow (JOIN optimization)
CREATE INDEX idx_dag_node_workflow 
  ON dag_node(workflow_id);

-- Index for querying nodes by chat session (cross-module queries)
CREATE INDEX idx_dag_node_chat_session 
  ON dag_node(chat_session_id);

-- Index for querying nodes by status (for filtering)
CREATE INDEX idx_dag_node_status 
  ON dag_node(status);

-- Composite index for workflow nodes with status (common query pattern)
CREATE INDEX idx_dag_node_workflow_status 
  ON dag_node(workflow_id, status);

-- ============================================================================
-- DAG Violation Table
-- ============================================================================
CREATE TABLE dag_violation (
  violation_id TEXT PRIMARY KEY,                   -- vio_<timestamp>_<random>
  workflow_id TEXT NOT NULL,                        -- Reference to workflow
  chat_session_id TEXT NOT NULL,                    -- Denormalized for easier querying
  node_id TEXT,                                     -- Optional reference to node
  violation_type TEXT NOT NULL,                     -- 'required_node_skipped' | 'dependency_violated' | etc.
  severity TEXT NOT NULL,                          -- 'error' | 'warning' | 'info'
  message TEXT NOT NULL,                            -- Human-readable violation message
  details TEXT,                                    -- JSON: additional violation details
  created_at INTEGER NOT NULL,                     -- Unix timestamp (ms)
  FOREIGN KEY (workflow_id) REFERENCES dag_workflow(workflow_id)
    ON DELETE CASCADE,
  FOREIGN KEY (node_id) REFERENCES dag_node(node_id)
    ON DELETE SET NULL
);

-- Index for querying violations by workflow
CREATE INDEX idx_dag_violation_workflow 
  ON dag_violation(workflow_id);

-- Index for querying violations by chat session
CREATE INDEX idx_dag_violation_chat_session 
  ON dag_violation(chat_session_id);

-- Index for querying violations by type (for filtering)
CREATE INDEX idx_dag_violation_type 
  ON dag_violation(violation_type);

-- Index for querying violations by severity (for filtering)
CREATE INDEX idx_dag_violation_severity 
  ON dag_violation(severity);

-- Index for querying recent violations
CREATE INDEX idx_dag_violation_created_at 
  ON dag_violation(created_at DESC);

-- ============================================================================
-- DAG Workflow History Table (for audit and recovery)
-- ============================================================================
CREATE TABLE dag_workflow_history (
  history_id TEXT PRIMARY KEY,                     -- hist_<timestamp>_<random>
  workflow_id TEXT NOT NULL,                        -- Reference to workflow
  chat_session_id TEXT NOT NULL,                    -- Denormalized for easier querying
  action TEXT NOT NULL,                             -- 'created' | 'updated' | 'deleted' | 'state_changed'
  old_state TEXT,                                   -- JSON: previous state before change
  new_state TEXT,                                   -- JSON: new state after change
  change_details TEXT,                              -- JSON: detailed change info
  changed_by TEXT,                                  -- 'system' | 'user' | 'llm'
  created_at INTEGER NOT NULL,                     -- Unix timestamp (ms)
  FOREIGN KEY (workflow_id) REFERENCES dag_workflow(workflow_id)
    ON DELETE CASCADE
);

-- Index for querying history by workflow
CREATE INDEX idx_dag_workflow_history_workflow 
  ON dag_workflow_history(workflow_id);

-- Index for querying history by chat session
CREATE INDEX idx_dag_workflow_history_chat_session 
  ON dag_workflow_history(chat_session_id);

-- Index for querying history by action type
CREATE INDEX idx_dag_workflow_history_action 
  ON dag_workflow_history(action);

-- Index for querying recent history
CREATE INDEX idx_dag_workflow_history_created_at 
  ON dag_workflow_history(created_at DESC);

-- ============================================================================
-- DAG Node Execution Log Table (for detailed execution tracking)
-- ============================================================================
CREATE TABLE dag_node_log (
  log_id TEXT PRIMARY KEY,                         -- log_<timestamp>_<random>
  node_id TEXT NOT NULL,                            -- Reference to node
  workflow_id TEXT NOT NULL,                        -- Denormalized for easier querying
  chat_session_id TEXT NOT NULL,                    -- Denormalized for easier querying
  log_level TEXT NOT NULL,                          -- 'debug' | 'info' | 'warn' | 'error'
  log_message TEXT NOT NULL,                        -- Log message
  log_data TEXT,                                    -- JSON: structured log data
  execution_phase TEXT,                             -- 'init' | 'execute' | 'cleanup' | etc.
  created_at INTEGER NOT NULL,                     -- Unix timestamp (ms)
  FOREIGN KEY (node_id) REFERENCES dag_node(node_id)
    ON DELETE CASCADE,
  FOREIGN KEY (workflow_id) REFERENCES dag_workflow(workflow_id)
    ON DELETE CASCADE
);

-- Index for querying logs by node
CREATE INDEX idx_dag_node_log_node 
  ON dag_node_log(node_id);

-- Index for querying logs by workflow
CREATE INDEX idx_dag_node_log_workflow 
  ON dag_node_log(workflow_id);

-- Index for querying logs by chat session
CREATE INDEX idx_dag_node_log_chat_session 
  ON dag_node_log(chat_session_id);

-- Index for querying logs by level (for filtering)
CREATE INDEX idx_dag_node_log_level 
  ON dag_node_log(log_level);

-- Index for querying recent logs
CREATE INDEX idx_dag_node_log_created_at 
  ON dag_node_log(created_at DESC);

-- ============================================================================
-- Schema Version Tracking
-- ============================================================================
CREATE TABLE dag_schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  description TEXT
);

-- Insert current schema version
INSERT INTO dag_schema_version (version, applied_at, description) 
VALUES (1, unixepoch() * 1000, 'Initial DAG persistence schema');
