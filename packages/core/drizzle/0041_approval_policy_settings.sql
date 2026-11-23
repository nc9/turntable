-- #345: approval_policy joins the event types, and the approval policies move onto the settings
-- registry. The events table is rebuilt for its CHECK: keep the AUTOINCREMENT high-water mark, so
-- a feed cursor never meets a reused id.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	CONSTRAINT "events_type_check" CHECK(type IN ('run.queued', 'run.started', 'run.finished', 'job.state_changed', 'attempt.step', 'attempt.cut', 'approval.required', 'infra.error', 'quota.warning', 'quota.reached', 'webhook.disabled', 'approval.policy_loosened'))
);
--> statement-breakpoint
INSERT INTO `__new_events`("id", "public_id", "org_id", "project_id", "type", "run_id", "job_id", "attempt_id", "payload", "created_at") SELECT "id", "public_id", "org_id", "project_id", "type", "run_id", "job_id", "attempt_id", "payload", "created_at" FROM `events`;--> statement-breakpoint
DROP TABLE `events`;--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;--> statement-breakpoint
INSERT INTO sqlite_sequence (name, seq) SELECT 'events', coalesce((SELECT max(seq) FROM `__events_seq`), 0) WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'events');--> statement-breakpoint
UPDATE sqlite_sequence SET seq = max(seq, coalesce((SELECT max(seq) FROM `__events_seq`), 0)) WHERE name = 'events';--> statement-breakpoint
DROP TABLE `__events_seq`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `events_org_idx` ON `events` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `events_org_project_idx` ON `events` (`org_id`,`project_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `events_public_id_unique` ON `events` (`public_id`);--> statement-breakpoint
-- Every org's approval policies are copied into one `approval_policy` setting, so the resolver
-- reads what the table held. The table stays (nothing reads or writes it any more), so rolling
-- the binary back loses nothing but changes made after this ran.
INSERT INTO `settings` (`scope_kind`, `scope_id`, `org_id`, `key`, `value`, `updated_by`, `updated_at`)
SELECT 'org', `org_id`, `org_id`, 'approval_policy',
	json_group_object(`environment`, json_object('required', min(max(`required`, 1), 10), 'allow_author_approval', json(CASE WHEN `allow_author_approval` = 1 THEN 'true' ELSE 'false' END), 'key_policy', 'any')),
	'migration', CAST(strftime('%s', 'now') AS integer) * 1000
FROM `approval_policies`
WHERE NOT EXISTS (
	SELECT 1 FROM `settings`
	WHERE `settings`.`scope_kind` = 'org' AND `settings`.`scope_id` = `approval_policies`.`org_id` AND `settings`.`key` = 'approval_policy'
)
GROUP BY `org_id`;
