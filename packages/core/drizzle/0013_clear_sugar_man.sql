CREATE TABLE `action_verdicts` (
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`repo` text NOT NULL,
	`ref` text DEFAULT '' NOT NULL,
	`sha` text NOT NULL,
	`verdict` integer NOT NULL,
	`checked_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`project_id`, `kind`, `repo`, `ref`, `sha`),
	FOREIGN KEY (`project_id`,`org_id`) REFERENCES `projects`(`id`,`org_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `action_verdicts_checked_idx` ON `action_verdicts` (`checked_at`);