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
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_outbound_webhook_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text,
	`url` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`event_types` text,
	`format` text DEFAULT 'json' NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`disabled_reason` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`cursor` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`org_id`) REFERENCES `projects`(`id`,`org_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "outbound_webhook_endpoints_state_check" CHECK(state IN ('active', 'disabled')),
	CONSTRAINT "outbound_webhook_endpoints_format_check" CHECK(format IN ('json', 'slack'))
);
--> statement-breakpoint
INSERT INTO `__new_outbound_webhook_endpoints`("id", "org_id", "project_id", "url", "description", "event_types", "format", "state", "disabled_reason", "consecutive_failures", "cursor", "created_by", "created_at", "updated_at") SELECT "id", "org_id", "project_id", "url", "description", "event_types", "format", "state", "disabled_reason", "consecutive_failures", "cursor", "created_by", "created_at", "updated_at" FROM `outbound_webhook_endpoints`;--> statement-breakpoint
DROP TABLE `outbound_webhook_endpoints`;--> statement-breakpoint
ALTER TABLE `__new_outbound_webhook_endpoints` RENAME TO `outbound_webhook_endpoints`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `outbound_webhook_endpoints_org_idx` ON `outbound_webhook_endpoints` (`org_id`,`state`);