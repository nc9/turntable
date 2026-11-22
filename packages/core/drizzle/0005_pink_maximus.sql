CREATE TABLE `poll_seen` (
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`repo` text NOT NULL,
	`workflow_path` text NOT NULL,
	`event` text NOT NULL,
	`sha` text NOT NULL,
	`run_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`project_id`, `repo`, `workflow_path`, `event`, `sha`),
	FOREIGN KEY (`project_id`,`org_id`) REFERENCES `projects`(`id`,`org_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `poll_seen_repo_created_idx` ON `poll_seen` (`project_id`,`repo`,`created_at`);--> statement-breakpoint
ALTER TABLE `job_attempts` ADD `exec_id` text;--> statement-breakpoint
ALTER TABLE `job_attempts` ADD `lease_owner` text;--> statement-breakpoint
ALTER TABLE `job_attempts` ADD `lease_expires_at` integer;--> statement-breakpoint
ALTER TABLE `job_attempts` ADD `heartbeat_at` integer;--> statement-breakpoint
CREATE INDEX `job_attempts_state_idx` ON `job_attempts` (`state`,`id`);