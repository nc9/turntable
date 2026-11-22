CREATE TABLE `audit_checkpoints` (
	`org_id` text NOT NULL,
	`seq` integer NOT NULL,
	`hash` text NOT NULL,
	`signed_at` integer NOT NULL,
	`key_id` text NOT NULL,
	`signature` text NOT NULL,
	PRIMARY KEY(`org_id`, `seq`),
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `audit_export_cursors` (
	`org_id` text NOT NULL,
	`sink` text NOT NULL,
	`last_seq` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`org_id`, `sink`),
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `audit_log` ADD `seq` integer;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `prev_hash` text;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `audit_log_org_seq_unique` ON `audit_log` (`org_id`,`seq`);