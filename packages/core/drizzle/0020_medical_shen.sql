CREATE TABLE `proxy_passthrough_hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`host` text NOT NULL,
	`ports` text DEFAULT '[443]' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`,`org_id`) REFERENCES `projects`(`id`,`org_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proxy_passthrough_hosts_unique` ON `proxy_passthrough_hosts` (`org_id`,`project_id`,`host`);--> statement-breakpoint
CREATE TABLE `proxy_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`secret` text NOT NULL,
	`host` text NOT NULL,
	`port` integer DEFAULT 443 NOT NULL,
	`methods` text NOT NULL,
	`path_prefix` text NOT NULL,
	`inject_type` text NOT NULL,
	`inject_header` text,
	`inject_format` text,
	`inject_username` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`,`org_id`) REFERENCES `projects`(`id`,`org_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "proxy_rules_inject_check" CHECK("proxy_rules"."inject_type" in ('header', 'basic'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proxy_rules_name_unique` ON `proxy_rules` (`org_id`,`project_id`,`name`);