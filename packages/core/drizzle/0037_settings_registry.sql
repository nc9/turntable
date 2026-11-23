CREATE TABLE `settings` (
	`scope_kind` text NOT NULL,
	`scope_id` text DEFAULT '' NOT NULL,
	`org_id` text,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope_kind`, `scope_id`, `key`),
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "settings_scope_kind_check" CHECK(scope_kind IN ('instance', 'org', 'project')),
	CONSTRAINT "settings_org_id_check" CHECK(("settings"."scope_kind" = 'instance' AND "settings"."org_id" IS NULL) OR ("settings"."scope_kind" = 'org' AND "settings"."org_id" IS NOT NULL AND "settings"."scope_id" = "settings"."org_id") OR ("settings"."scope_kind" = 'project' AND "settings"."org_id" IS NOT NULL))
);
