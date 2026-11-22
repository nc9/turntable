CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`org_id`) REFERENCES `projects`(`id`,`org_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "api_tokens_role_check" CHECK(role IN ('reader', 'operator', 'release_operator'))
);
--> statement-breakpoint
CREATE INDEX `api_tokens_org_idx` ON `api_tokens` (`org_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text,
	`principal_kind` text NOT NULL,
	`principal_id` text NOT NULL,
	`op` text NOT NULL,
	`effect` text NOT NULL,
	`outcome` text NOT NULL,
	`input` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_log_org_created_idx` ON `audit_log` (`org_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_sha_idx` ON `runs` (`org_id`,`sha`);