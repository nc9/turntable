CREATE TABLE `release_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text NOT NULL,
	`tag` text NOT NULL,
	`artifacts` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text,
	`detail` text,
	`requested_by` text NOT NULL,
	`claimed_by` text,
	`claimed_at` integer,
	`finished_at` integer,
	`result` text,
	`facts` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`,`org_id`) REFERENCES `projects`(`id`,`org_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "release_requests_status_check" CHECK(status IN ('pending', 'claimed', 'signed', 'refused', 'error'))
);
--> statement-breakpoint
CREATE INDEX `release_requests_status_idx` ON `release_requests` (`status`,`created_at`);