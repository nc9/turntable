-- #321: untrusted_run_approval moves onto the settings registry. Every project's current value
-- is copied into the settings table, so the resolver reads what the column held. The column
-- stays (nothing reads or writes it any more), so rolling the binary back loses nothing but
-- changes made after this ran.
INSERT INTO `settings` (`scope_kind`, `scope_id`, `org_id`, `key`, `value`, `updated_by`, `updated_at`)
SELECT 'project', `id`, `org_id`, 'untrusted_run_approval', '"' || `untrusted_run_approval` || '"', 'migration', CAST(strftime('%s', 'now') AS integer) * 1000
FROM `projects`
WHERE NOT EXISTS (
	SELECT 1 FROM `settings`
	WHERE `settings`.`scope_kind` = 'project' AND `settings`.`scope_id` = `projects`.`id` AND `settings`.`key` = 'untrusted_run_approval'
);
