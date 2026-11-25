CREATE TABLE `onboardings` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`installation_id` text,
	`first_run_id` text,
	`agent_token_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `onboardings_org_idx` ON `onboardings` (`org_id`,`created_at`);