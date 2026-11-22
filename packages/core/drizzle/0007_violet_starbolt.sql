CREATE TABLE `github_apps` (
	`app_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`owner_login` text NOT NULL,
	`html_url` text NOT NULL,
	`client_id` text NOT NULL,
	`previous_secret_expires_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `github_installations` (
	`installation_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`app_id` text NOT NULL,
	`account_login` text NOT NULL,
	`account_id` text NOT NULL,
	`account_type` text NOT NULL,
	`repository_selection` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "github_installations_status_check" CHECK(status IN ('active', 'suspended', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE `secrets` (
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`ciphertext` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`org_id`, `name`),
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`forge` text DEFAULT 'github' NOT NULL,
	`event` text NOT NULL,
	`action` text,
	`installation_id` text,
	`status` text DEFAULT 'received' NOT NULL,
	`error` text,
	`payload` text,
	`received_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`processed_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "webhook_deliveries_status_check" CHECK(status IN ('received', 'processed', 'ignored', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_received_idx` ON `webhook_deliveries` (`received_at`);