CREATE TABLE `vault_secret_versions` (
	`secret_id` text NOT NULL,
	`org_id` text NOT NULL,
	`version` integer NOT NULL,
	`ciphertext` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`valid_until` integer,
	PRIMARY KEY(`secret_id`, `version`),
	FOREIGN KEY (`secret_id`,`org_id`) REFERENCES `vault_secrets`(`id`,`org_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `vault_secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`environment` text,
	`ref_pattern` text,
	`scope_key` text NOT NULL,
	`trust_classes` text NOT NULL,
	`destinations` text NOT NULL,
	`current_version` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`org_id`) REFERENCES `projects`(`id`,`org_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `vault_secrets_org_name_idx` ON `vault_secrets` (`org_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `vault_secrets_scope_unique` ON `vault_secrets` (`org_id`,`name`,`scope_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `vault_secrets_id_org_unique` ON `vault_secrets` (`id`,`org_id`);--> statement-breakpoint
ALTER TABLE `job_attempts` ADD `trust_class` text;