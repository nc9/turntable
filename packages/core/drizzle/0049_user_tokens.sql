CREATE TABLE `user_token_orgs` (
	`token_id` text NOT NULL,
	`org_id` text NOT NULL,
	`first_used_at` integer NOT NULL,
	PRIMARY KEY(`token_id`, `org_id`),
	FOREIGN KEY (`token_id`) REFERENCES `user_tokens`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `user_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`github_user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_used_at` integer,
	`expires_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `user_tokens_github_user_idx` ON `user_tokens` (`github_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_tokens_hash_unique` ON `user_tokens` (`token_hash`);