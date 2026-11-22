CREATE TABLE `action_pins` (
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`repo` text NOT NULL,
	`ref` text NOT NULL,
	`sha` text NOT NULL,
	`pending_sha` text,
	`first_seen` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_seen` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`accepted_at` integer,
	PRIMARY KEY(`project_id`, `repo`, `ref`),
	FOREIGN KEY (`project_id`,`org_id`) REFERENCES `projects`(`id`,`org_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `orgs` ADD `action_owner_allowlist` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `require_sha_pins` integer DEFAULT 0 NOT NULL;