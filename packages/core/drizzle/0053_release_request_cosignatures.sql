ALTER TABLE `release_requests` ADD `cosignatures` text;--> statement-breakpoint
ALTER TABLE `release_requests` ADD `dry_run` integer DEFAULT false NOT NULL;