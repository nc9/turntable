ALTER TABLE `artifacts` ADD `klass` text DEFAULT 'untrusted_pr' NOT NULL;--> statement-breakpoint
ALTER TABLE `artifacts` ADD `run_sha` text;--> statement-breakpoint
ALTER TABLE `artifacts` ADD `digest_source` text DEFAULT 'reported' NOT NULL;