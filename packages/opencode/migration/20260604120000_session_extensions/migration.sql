ALTER TABLE `session` ADD `session_type` text;--> statement-breakpoint
ALTER TABLE `session` ADD `source_session_id` text;--> statement-breakpoint
ALTER TABLE `session` ADD `context_json` text;--> statement-breakpoint
CREATE INDEX `session_source_idx` ON `session` (`source_session_id`);
