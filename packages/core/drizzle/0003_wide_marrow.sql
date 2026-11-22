CREATE TABLE `attempt_steps` (
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`step_key` text NOT NULL,
	`stage` text NOT NULL,
	`step_index` integer NOT NULL,
	`name` text NOT NULL,
	`result` text,
	`started_at` integer,
	`finished_at` integer,
	`log_offset` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`attempt_id`, `step_key`, `stage`),
	FOREIGN KEY (`attempt_id`,`org_id`,`project_id`) REFERENCES `job_attempts`(`id`,`org_id`,`project_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "attempt_steps_stage_check" CHECK(stage IN ('pre', 'main', 'post')),
	CONSTRAINT "attempt_steps_result_check" CHECK(result IS NULL OR result IN ('success', 'failure', 'skipped', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE `events` (
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
	CONSTRAINT "events_type_check" CHECK(type IN ('run.queued', 'run.started', 'run.finished', 'job.state_changed', 'attempt.step', 'attempt.cut', 'approval.required', 'infra.error'))
);
--> statement-breakpoint
CREATE INDEX `events_org_idx` ON `events` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `events_org_project_idx` ON `events` (`org_id`,`project_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `events_public_id_unique` ON `events` (`public_id`);--> statement-breakpoint
CREATE TABLE `log_cuts` (
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`at_offset` integer NOT NULL,
	`omitted_bytes` integer NOT NULL,
	`reason` text NOT NULL,
	PRIMARY KEY(`attempt_id`, `at_offset`),
	FOREIGN KEY (`attempt_id`,`org_id`,`project_id`) REFERENCES `job_attempts`(`id`,`org_id`,`project_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_job_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`job_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`provider` text NOT NULL,
	`sandbox_id` text,
	`exit_code` integer,
	`error_class` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`job_id`,`org_id`,`project_id`) REFERENCES `jobs`(`id`,`org_id`,`project_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "job_attempts_state_check" CHECK(state IN ('queued', 'running', 'success', 'failure', 'infra_error', 'awaiting_approval', 'cancelled', 'skipped'))
);
--> statement-breakpoint
INSERT INTO `__new_job_attempts`("id", "org_id", "project_id", "job_id", "attempt", "state", "provider", "sandbox_id", "exit_code", "error_class", "created_at", "started_at", "finished_at") SELECT "id", "org_id", "project_id", "job_id", "attempt", "state", "provider", "sandbox_id", "exit_code", "error_class", "created_at", "started_at", "finished_at" FROM `job_attempts`;--> statement-breakpoint
DROP TABLE `job_attempts`;--> statement-breakpoint
ALTER TABLE `__new_job_attempts` RENAME TO `job_attempts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `job_attempts_id_org_project_unique` ON `job_attempts` (`id`,`org_id`,`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `job_attempts_job_attempt_unique` ON `job_attempts` (`job_id`,`attempt`);--> statement-breakpoint
CREATE TABLE `__new_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text NOT NULL,
	`job_key` text NOT NULL,
	`name` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`exit_code` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`project_id`,`org_id`) REFERENCES `projects`(`id`,`org_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`,`org_id`,`project_id`) REFERENCES `runs`(`id`,`org_id`,`project_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "jobs_state_check" CHECK(state IN ('queued', 'running', 'success', 'failure', 'infra_error', 'awaiting_approval', 'cancelled', 'skipped'))
);
--> statement-breakpoint
INSERT INTO `__new_jobs`("id", "org_id", "project_id", "run_id", "job_key", "name", "state", "exit_code", "created_at", "started_at", "finished_at") SELECT "id", "org_id", "project_id", "run_id", "job_key", "name", "state", "exit_code", "created_at", "started_at", "finished_at" FROM `jobs`;--> statement-breakpoint
DROP TABLE `jobs`;--> statement-breakpoint
ALTER TABLE `__new_jobs` RENAME TO `jobs`;--> statement-breakpoint
CREATE INDEX `jobs_run_idx` ON `jobs` (`org_id`,`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_id_org_project_unique` ON `jobs` (`id`,`org_id`,`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_run_key_unique` ON `jobs` (`run_id`,`job_key`);--> statement-breakpoint
CREATE TABLE `__new_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`workflow_path` text NOT NULL,
	`event` text NOT NULL,
	`ref` text NOT NULL,
	`sha` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`project_id`,`org_id`) REFERENCES `projects`(`id`,`org_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "runs_status_check" CHECK(status IN ('queued', 'running', 'success', 'failure', 'infra_error', 'awaiting_approval', 'cancelled', 'skipped'))
);
--> statement-breakpoint
INSERT INTO `__new_runs`("id", "org_id", "project_id", "workflow_path", "event", "ref", "sha", "status", "created_at", "started_at", "finished_at") SELECT "id", "org_id", "project_id", "workflow_path", "event", "ref", "sha", "status", "created_at", "started_at", "finished_at" FROM `runs`;--> statement-breakpoint
DROP TABLE `runs`;--> statement-breakpoint
ALTER TABLE `__new_runs` RENAME TO `runs`;--> statement-breakpoint
CREATE INDEX `runs_project_created_idx` ON `runs` (`org_id`,`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_sha_idx` ON `runs` (`org_id`,`sha`);--> statement-breakpoint
CREATE UNIQUE INDEX `runs_id_org_project_unique` ON `runs` (`id`,`org_id`,`project_id`);