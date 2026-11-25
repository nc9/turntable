CREATE TABLE `notification_cursors` (
	`name` text PRIMARY KEY NOT NULL,
	`last_event_id` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_prefs` (
	`user_id` text NOT NULL,
	`org_id` text DEFAULT '' NOT NULL,
	`project_id` text DEFAULT '' NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `org_id`, `project_id`, `kind`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "notification_prefs_kind_check" CHECK(kind IN ('run_failed', 'infra_errors', 'work_held', 'approval_waiting', 'checkout_auth_failed', 'dogfood_red', 'deploy_failed'))
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text,
	`kind` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`run_id` text,
	`count` integer DEFAULT 1 NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`read_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`org_id`) REFERENCES `projects`(`id`,`org_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "notifications_kind_check" CHECK(kind IN ('run_failed', 'infra_errors', 'work_held', 'approval_waiting', 'checkout_auth_failed', 'dogfood_red', 'deploy_failed'))
);
--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`user_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_dedupe_unique` ON `notifications` (`user_id`,`kind`,`dedupe_key`);--> statement-breakpoint
ALTER TABLE `outbound_webhook_endpoints` ADD `format` text DEFAULT 'json' NOT NULL;
