CREATE TABLE `org_quotas` (
	`org_id` text PRIMARY KEY NOT NULL,
	`max_concurrent` integer,
	`max_runs_per_hour` integer,
	`max_sandbox_minutes_per_day` integer,
	`max_log_bytes` integer,
	`max_stored_bytes` integer,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `quota_notices` (
	`org_id` text NOT NULL,
	`metric` text NOT NULL,
	`level` text NOT NULL,
	`window` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`org_id`, `metric`, `level`, `window`),
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
