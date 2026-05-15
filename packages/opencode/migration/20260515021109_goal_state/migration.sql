CREATE TABLE `goal_state` (
	`session_id` text PRIMARY KEY,
	`payload` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `goal_state_updated_at_idx` ON `goal_state` (`updated_at`);