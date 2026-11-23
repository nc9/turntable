CREATE TABLE `cache_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`klass` text NOT NULL,
	`ref_scope` text NOT NULL,
	`key` text NOT NULL,
	`version` text NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`complete` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`used_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`org_id`) REFERENCES `projects`(`id`,`org_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cache_entries_ns_idx` ON `cache_entries` (`org_id`,`project_id`,`klass`,`ref_scope`,`key`);--> statement-breakpoint
CREATE INDEX `cache_entries_used_idx` ON `cache_entries` (`org_id`,`klass`,`used_at`);--> statement-breakpoint
ALTER TABLE `projects` ADD `cache_release_restore` integer DEFAULT 0 NOT NULL;