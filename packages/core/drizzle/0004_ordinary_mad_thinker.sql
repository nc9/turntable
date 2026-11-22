ALTER TABLE `job_attempts` ADD `rerun_reason` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `needs` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `matrix` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `approval_kind` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `workflow_name` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `commit_message` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `actor` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `head_branch` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `pr_number` integer;