CREATE TABLE `approval_key_policies` (
	`org_id` text PRIMARY KEY NOT NULL,
	`policy` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`presets` text DEFAULT '[]' NOT NULL,
	`aaguids` text DEFAULT '[]' NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `approver_enrolments` ADD `aaguid` text;--> statement-breakpoint
ALTER TABLE `approver_enrolments` ADD `attested` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `approvers` ADD `aaguid` text;--> statement-breakpoint
ALTER TABLE `approvers` ADD `attested` integer DEFAULT false NOT NULL;