CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`name` text NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`,`org_id`) REFERENCES `projects`(`id`,`org_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`,`org_id`,`project_id`) REFERENCES `runs`(`id`,`org_id`,`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`,`org_id`,`project_id`) REFERENCES `job_attempts`(`id`,`org_id`,`project_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "artifacts_sha256_check" CHECK(length("artifacts"."sha256") = 64)
);
--> statement-breakpoint
CREATE INDEX `artifacts_sha256_idx` ON `artifacts` (`org_id`,`sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_run_name_unique` ON `artifacts` (`org_id`,`project_id`,`run_id`,`name`);--> statement-breakpoint
ALTER TABLE `projects` ADD `release_refs` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `signing_key` text;