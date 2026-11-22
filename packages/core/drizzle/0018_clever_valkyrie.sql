CREATE TABLE `approval_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`statement_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `approval_challenges_org_idx` ON `approval_challenges` (`org_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `approval_policies` (
	`org_id` text NOT NULL,
	`environment` text NOT NULL,
	`required` integer NOT NULL,
	`allow_author_approval` integer DEFAULT 0 NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `environment`),
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `approval_records` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text,
	`kind` text NOT NULL,
	`run_id` text,
	`environment` text,
	`enrolment_id` text,
	`statement_hash` text NOT NULL,
	`statement` text NOT NULL,
	`method` text NOT NULL,
	`approver_id` text NOT NULL,
	`person` text NOT NULL,
	`signature` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `approval_records_run_idx` ON `approval_records` (`org_id`,`run_id`,`environment`);--> statement-breakpoint
CREATE INDEX `approval_records_enrol_idx` ON `approval_records` (`org_id`,`enrolment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `approval_records_hash_unique` ON `approval_records` (`org_id`,`statement_hash`);--> statement-breakpoint
CREATE TABLE `approver_enrolments` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`person` text NOT NULL,
	`forge_login` text,
	`kind` text NOT NULL,
	`credential_id` text,
	`public_key` text NOT NULL,
	`alg` text NOT NULL,
	`sign_count` integer DEFAULT 0 NOT NULL,
	`requested_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`activated_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `approver_enrolments_org_idx` ON `approver_enrolments` (`org_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `approvers` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`person` text NOT NULL,
	`forge_login` text,
	`kind` text NOT NULL,
	`credential_id` text,
	`public_key` text NOT NULL,
	`alg` text NOT NULL,
	`sign_count` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `approvers_org_person_idx` ON `approvers` (`org_id`,`person`);--> statement-breakpoint
CREATE UNIQUE INDEX `approvers_org_key_unique` ON `approvers` (`org_id`,`public_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `approvers_id_org_unique` ON `approvers` (`id`,`org_id`);