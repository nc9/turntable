PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`kind` text DEFAULT 'agent' NOT NULL,
	`token_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`org_id`) REFERENCES `projects`(`id`,`org_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "api_tokens_role_check" CHECK(role IN ('reader', 'operator', 'release_operator')),
	CONSTRAINT "api_tokens_kind_check" CHECK(kind IN ('agent', 'person'))
);
--> statement-breakpoint
INSERT INTO `__new_api_tokens`("id", "org_id", "project_id", "name", "role", "kind", "token_hash", "created_by", "created_at", "last_used_at", "expires_at", "revoked_at") SELECT "id", "org_id", "project_id", "name", "role", 'agent', "token_hash", "created_by", "created_at", "last_used_at", "expires_at", "revoked_at" FROM `api_tokens`;--> statement-breakpoint
DROP TABLE `api_tokens`;--> statement-breakpoint
ALTER TABLE `__new_api_tokens` RENAME TO `api_tokens`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `api_tokens_org_idx` ON `api_tokens` (`org_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `__new_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`require_sha_pins` integer DEFAULT 0 NOT NULL,
	`egress` text DEFAULT 'none' NOT NULL,
	`release_refs` text,
	`signing_key` text,
	`signing_environment` text,
	`checks_mode` text DEFAULT 'off' NOT NULL,
	`ingest_config` text,
	`frozen_at` integer,
	`frozen_reason` text,
	`frozen_by` text,
	`cache_release_restore` integer DEFAULT 0 NOT NULL,
	`oidc_audiences` text,
	`sandbox_snapshot` text,
	`max_concurrent` integer,
	`untrusted_run_approval` text DEFAULT 'no_agents' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "projects_untrusted_run_approval_check" CHECK(untrusted_run_approval IN ('human', 'no_agents', 'any'))
);
--> statement-breakpoint
INSERT INTO `__new_projects`("id", "org_id", "slug", "name", "require_sha_pins", "egress", "release_refs", "signing_key", "signing_environment", "checks_mode", "ingest_config", "frozen_at", "frozen_reason", "frozen_by", "cache_release_restore", "oidc_audiences", "sandbox_snapshot", "max_concurrent", "untrusted_run_approval", "created_at") SELECT "id", "org_id", "slug", "name", "require_sha_pins", "egress", "release_refs", "signing_key", "signing_environment", "checks_mode", "ingest_config", "frozen_at", "frozen_reason", "frozen_by", "cache_release_restore", "oidc_audiences", "sandbox_snapshot", "max_concurrent", 'no_agents', "created_at" FROM `projects`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_org_slug_unique` ON `projects` (`org_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_id_org_unique` ON `projects` (`id`,`org_id`);