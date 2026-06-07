ALTER TABLE `dag_workflow` ADD COLUMN `paused_at` integer;
--> statement-breakpoint
ALTER TABLE `dag_workflow` ADD COLUMN `resumed_at` integer;