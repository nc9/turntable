ALTER TABLE `job_attempts` ADD `check_run_id` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `checks_mode` text DEFAULT 'off' NOT NULL;