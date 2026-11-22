CREATE TABLE `job_attempts` (
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
	CONSTRAINT "job_attempts_state_check" CHECK(state IN ('queued', 'running', 'success', 'failure', 'infra_error', 'awaiting_approval', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_attempts_id_org_project_unique` ON `job_attempts` (`id`,`org_id`,`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `job_attempts_job_attempt_unique` ON `job_attempts` (`job_id`,`attempt`);--> statement-breakpoint
CREATE TABLE `jobs` (
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
	CONSTRAINT "jobs_state_check" CHECK(state IN ('queued', 'running', 'success', 'failure', 'infra_error', 'awaiting_approval', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `jobs_run_idx` ON `jobs` (`org_id`,`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_id_org_project_unique` ON `jobs` (`id`,`org_id`,`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_run_key_unique` ON `jobs` (`run_id`,`job_key`);--> statement-breakpoint
CREATE TABLE `log_chunks` (
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`offset` integer NOT NULL,
	`bytes` blob NOT NULL,
	PRIMARY KEY(`attempt_id`, `offset`),
	FOREIGN KEY (`attempt_id`,`org_id`,`project_id`) REFERENCES `job_attempts`(`id`,`org_id`,`project_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `org_members` (
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`org_id`, `user_id`),
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "org_members_role_check" CHECK(role IN ('owner', 'admin', 'member', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE `orgs` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orgs_slug_unique` ON `orgs` (`slug`);--> statement-breakpoint
CREATE TABLE `project_repos` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`forge` text NOT NULL,
	`installation_id` text,
	`forge_repo_id` text,
	`owner` text NOT NULL,
	`repo` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`,`org_id`) REFERENCES `projects`(`id`,`org_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "project_repos_forge_check" CHECK(forge IN ('github'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_repos_forge_owner_repo_unique` ON `project_repos` (`forge`,`owner`,`repo`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_repos_forge_repo_id_unique` ON `project_repos` (`forge`,`forge_repo_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_org_slug_unique` ON `projects` (`org_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_id_org_unique` ON `projects` (`id`,`org_id`);--> statement-breakpoint
CREATE TABLE `runs` (
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
	CONSTRAINT "runs_status_check" CHECK(status IN ('queued', 'running', 'success', 'failure', 'infra_error', 'awaiting_approval', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `runs_project_created_idx` ON `runs` (`org_id`,`project_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `runs_id_org_project_unique` ON `runs` (`id`,`org_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text,
	`display_name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);