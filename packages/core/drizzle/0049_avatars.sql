ALTER TABLE `github_identities` ADD `avatar_url` text;--> statement-breakpoint
ALTER TABLE `github_identities` ADD `avatar_synced_at` integer;--> statement-breakpoint
ALTER TABLE `github_installations` ADD `avatar_url` text;--> statement-breakpoint
ALTER TABLE `github_installations` ADD `avatar_synced_at` integer;