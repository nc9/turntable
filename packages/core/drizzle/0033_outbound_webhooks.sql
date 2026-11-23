CREATE TABLE `outbound_webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`endpoint_id` text NOT NULL,
	`event_id` integer NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`lease_until` integer,
	`last_status` integer,
	`last_error` text,
	`last_response` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`endpoint_id`) REFERENCES `outbound_webhook_endpoints`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "outbound_webhook_deliveries_state_check" CHECK(state IN ('pending', 'delivered', 'abandoned'))
);
--> statement-breakpoint
CREATE INDEX `outbound_webhook_deliveries_due_idx` ON `outbound_webhook_deliveries` (`state`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `outbound_webhook_deliveries_endpoint_idx` ON `outbound_webhook_deliveries` (`org_id`,`endpoint_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `outbound_webhook_deliveries_endpoint_event_unique` ON `outbound_webhook_deliveries` (`endpoint_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `outbound_webhook_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text,
	`url` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`event_types` text,
	`state` text DEFAULT 'active' NOT NULL,
	`disabled_reason` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`cursor` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`org_id`) REFERENCES `projects`(`id`,`org_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "outbound_webhook_endpoints_state_check" CHECK(state IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE INDEX `outbound_webhook_endpoints_org_idx` ON `outbound_webhook_endpoints` (`org_id`,`state`);--> statement-breakpoint
CREATE TABLE `outbound_webhook_secrets` (
	`org_id` text NOT NULL,
	`version` integer NOT NULL,
	`sealed` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer,
	PRIMARY KEY(`org_id`, `version`),
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
-- Keep the AUTOINCREMENT high-water mark: a feed cursor must never meet a reused id.
CREATE TEMP TABLE `__events_seq` AS SELECT seq FROM sqlite_sequence WHERE name = 'events';--> statement-breakpoint
CREATE TABLE `__new_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`public_id` text NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text,
	`type` text NOT NULL,
	`run_id` text,
	`job_id` text,
	`attempt_id` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`org_id`) REFERENCES `projects`(`id`,`org_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "events_type_check" CHECK(type IN ('run.queued', 'run.started', 'run.finished', 'job.state_changed', 'attempt.step', 'attempt.cut', 'approval.required', 'infra.error', 'quota.warning', 'quota.reached', 'webhook.disabled'))
);
--> statement-breakpoint
INSERT INTO `__new_events`("id", "public_id", "org_id", "project_id", "type", "run_id", "job_id", "attempt_id", "payload", "created_at") SELECT "id", "public_id", "org_id", "project_id", "type", "run_id", "job_id", "attempt_id", "payload", "created_at" FROM `events`;--> statement-breakpoint
DROP TABLE `events`;--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;--> statement-breakpoint
UPDATE sqlite_sequence SET seq = max(seq, coalesce((SELECT max(seq) FROM `__events_seq`), 0)) WHERE name = 'events';--> statement-breakpoint
DROP TABLE `__events_seq`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `events_org_idx` ON `events` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `events_org_project_idx` ON `events` (`org_id`,`project_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `events_public_id_unique` ON `events` (`public_id`);