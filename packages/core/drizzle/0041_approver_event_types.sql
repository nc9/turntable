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
	CONSTRAINT "events_type_check" CHECK(type IN ('run.queued', 'run.started', 'run.finished', 'job.state_changed', 'attempt.step', 'attempt.cut', 'approval.required', 'infra.error', 'quota.warning', 'quota.reached', 'webhook.disabled', 'approver.bootstrapped', 'approvers.depleted'))
);
--> statement-breakpoint
INSERT INTO `__new_events`("id", "public_id", "org_id", "project_id", "type", "run_id", "job_id", "attempt_id", "payload", "created_at") SELECT "id", "public_id", "org_id", "project_id", "type", "run_id", "job_id", "attempt_id", "payload", "created_at" FROM `events`;--> statement-breakpoint
DROP TABLE `events`;--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;--> statement-breakpoint
-- An empty events table leaves no sqlite_sequence row after the rebuild: create it, then raise it.
INSERT INTO sqlite_sequence (name, seq) SELECT 'events', coalesce((SELECT max(seq) FROM `__events_seq`), 0) WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'events');--> statement-breakpoint
UPDATE sqlite_sequence SET seq = max(seq, coalesce((SELECT max(seq) FROM `__events_seq`), 0)) WHERE name = 'events';--> statement-breakpoint
DROP TABLE `__events_seq`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `events_org_idx` ON `events` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `events_org_project_idx` ON `events` (`org_id`,`project_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `events_public_id_unique` ON `events` (`public_id`);