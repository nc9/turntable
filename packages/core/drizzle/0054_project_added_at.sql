ALTER TABLE `projects` ADD `added_at` integer;
--> statement-breakpoint
UPDATE `projects` SET `added_at` = `created_at` WHERE `ingest_config` IS NOT NULL OR EXISTS (SELECT 1 FROM `runs` WHERE `runs`.`project_id` = `projects`.`id`);