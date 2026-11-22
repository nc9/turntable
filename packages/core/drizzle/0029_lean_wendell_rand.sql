ALTER TABLE `job_attempts` ADD `sandbox_created_at` integer;--> statement-breakpoint
ALTER TABLE `job_attempts` ADD `sandbox_destroyed_at` integer;--> statement-breakpoint
CREATE INDEX `job_attempts_sandbox_idx` ON `job_attempts` (`org_id`,`sandbox_created_at`);