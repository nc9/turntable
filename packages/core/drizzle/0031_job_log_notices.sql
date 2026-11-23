CREATE TABLE `log_notices` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`at_offset` integer NOT NULL,
	`source` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`attempt_id`,`org_id`,`project_id`) REFERENCES `job_attempts`(`id`,`org_id`,`project_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `log_notices_attempt_idx` ON `log_notices` (`attempt_id`,`at_offset`);