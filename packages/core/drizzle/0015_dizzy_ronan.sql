CREATE TABLE `incident_rotation_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`reason` text NOT NULL,
	`flagged_by` text NOT NULL,
	`flagged_at` integer NOT NULL,
	`cleared_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `incident_rotation_flags_org_idx` ON `incident_rotation_flags` (`org_id`,`name`);--> statement-breakpoint
ALTER TABLE `orgs` ADD `frozen_at` integer;--> statement-breakpoint
ALTER TABLE `orgs` ADD `frozen_reason` text;--> statement-breakpoint
ALTER TABLE `orgs` ADD `frozen_by` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `frozen_at` integer;--> statement-breakpoint
ALTER TABLE `projects` ADD `frozen_reason` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `frozen_by` text;