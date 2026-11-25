CREATE TABLE `github_installation_installers` (
	`installation_id` text PRIMARY KEY NOT NULL,
	`installer_github_id` text NOT NULL,
	`installer_login` text NOT NULL,
	`recorded_at` integer NOT NULL
);
