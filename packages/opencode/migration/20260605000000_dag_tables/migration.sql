CREATE TABLE `dag_workflow` (
	`workflow_id` text PRIMARY KEY,
	`chat_session_id` text NOT NULL,
	`name` text NOT NULL,
	`config` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`current_progress` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `dag_workflow_chat_session_idx` ON `dag_workflow` (`chat_session_id`);
--> statement-breakpoint
CREATE INDEX `dag_workflow_status_idx` ON `dag_workflow` (`status`);
--> statement-breakpoint
CREATE TABLE `dag_node` (
	`node_id` text PRIMARY KEY,
	`workflow_id` text NOT NULL,
	`config` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`output` text,
	`error_info` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`max_retries` integer DEFAULT 3 NOT NULL,
	`timeout_ms` integer,
	`required_nodes` text,
	`dependencies` text,
	`metadata` text,
	`start_time` integer,
	`end_time` integer,
	`parent_node` text,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `dag_node_workflow_idx` ON `dag_node` (`workflow_id`);
--> statement-breakpoint
CREATE INDEX `dag_node_status_idx` ON `dag_node` (`status`);
--> statement-breakpoint
CREATE TABLE `dag_violation` (
	`violation_id` text PRIMARY KEY,
	`workflow_id` text NOT NULL,
	`chat_session_id` text,
	`node_id` text,
	`violation_type` text NOT NULL,
	`severity` text NOT NULL,
	`message` text NOT NULL,
	`details` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dag_violation_workflow_idx` ON `dag_violation` (`workflow_id`);
--> statement-breakpoint
CREATE TABLE `dag_workflow_history` (
	`history_id` text PRIMARY KEY,
	`workflow_id` text NOT NULL,
	`chat_session_id` text NOT NULL,
	`action` text NOT NULL,
	`old_state` text,
	`new_state` text,
	`change_details` text,
	`changed_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dag_workflow_history_workflow_idx` ON `dag_workflow_history` (`workflow_id`);
--> statement-breakpoint
CREATE TABLE `dag_node_log` (
	`log_id` text PRIMARY KEY,
	`node_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`chat_session_id` text NOT NULL,
	`log_level` text NOT NULL,
	`log_message` text NOT NULL,
	`log_data` text,
	`execution_phase` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dag_node_log_node_idx` ON `dag_node_log` (`node_id`);
--> statement-breakpoint
CREATE INDEX `dag_node_log_workflow_idx` ON `dag_node_log` (`workflow_id`);
--> statement-breakpoint
CREATE TABLE `dag_schema_version` (
	`version` integer PRIMARY KEY,
	`applied_at` integer NOT NULL,
	`description` text
);
