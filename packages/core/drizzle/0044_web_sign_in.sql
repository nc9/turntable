CREATE TABLE `github_identities` (
	`github_user_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`login` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_sign_in_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_identities_user_unique` ON `github_identities` (`user_id`);--> statement-breakpoint
CREATE TABLE `login_states` (
	`nonce` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE TABLE `member_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`github_login` text NOT NULL,
	`role` text NOT NULL,
	`created_by` text NOT NULL,
	`reason` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`used_by_user_id` text,
	`revoked_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "member_invites_role_check" CHECK(role IN ('owner', 'admin', 'member', 'viewer'))
);
--> statement-breakpoint
CREATE INDEX `member_invites_login_idx` ON `member_invites` (`github_login`);--> statement-breakpoint
CREATE INDEX `member_invites_org_idx` ON `member_invites` (`org_id`,`github_login`);--> statement-breakpoint
CREATE TABLE `web_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `web_sessions_user_idx` ON `web_sessions` (`user_id`);