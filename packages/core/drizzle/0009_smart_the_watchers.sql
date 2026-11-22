ALTER TABLE `orgs` ADD `approve_run_min_role` text DEFAULT 'release_operator' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `egress` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `repo` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `trust` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `approval` text;