PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_vault_secrets` (
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
	`source` text DEFAULT 'sealed' NOT NULL,
	`external_ref` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`org_id`) REFERENCES `projects`(`id`,`org_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "vault_secrets_source_check" CHECK(("__new_vault_secrets"."source" = 'sealed' and "__new_vault_secrets"."external_ref" is null and "__new_vault_secrets"."current_version" >= 1) or ("__new_vault_secrets"."source" <> 'sealed' and "__new_vault_secrets"."external_ref" is not null and "__new_vault_secrets"."current_version" = 0))
);
--> statement-breakpoint
INSERT INTO `__new_vault_secrets`("id", "org_id", "project_id", "name", "environment", "ref_pattern", "scope_key", "trust_classes", "destinations", "current_version", "source", "external_ref", "created_by", "created_at", "updated_at", "last_used_at") SELECT "id", "org_id", "project_id", "name", "environment", "ref_pattern", "scope_key", "trust_classes", "destinations", "current_version", "source", "external_ref", "created_by", "created_at", "updated_at", "last_used_at" FROM `vault_secrets`;--> statement-breakpoint
DROP TABLE `vault_secrets`;--> statement-breakpoint
ALTER TABLE `__new_vault_secrets` RENAME TO `vault_secrets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `vault_secrets_org_name_idx` ON `vault_secrets` (`org_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `vault_secrets_scope_unique` ON `vault_secrets` (`org_id`,`name`,`scope_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `vault_secrets_id_org_unique` ON `vault_secrets` (`id`,`org_id`);