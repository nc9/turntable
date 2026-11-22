CREATE TABLE `installation_claims` (
	`nonce` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`started_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`installation_id` text,
	`expected_login` text,
	`github_user_id` text,
	`github_login` text,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `installation_claims_org_idx` ON `installation_claims` (`org_id`,`created_at`);