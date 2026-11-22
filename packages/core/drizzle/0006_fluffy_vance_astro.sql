ALTER TABLE `job_attempts` ADD `plan` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `planned` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `outputs` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `plan` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `concurrency_group` text;--> statement-breakpoint
CREATE INDEX `runs_concurrency_idx` ON `runs` (`org_id`,`project_id`,`concurrency_group`);