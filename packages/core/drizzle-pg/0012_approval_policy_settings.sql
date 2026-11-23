ALTER TABLE "events" DROP CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_type_check" CHECK (type IN ('run.queued', 'run.started', 'run.finished', 'job.state_changed', 'attempt.step', 'attempt.cut', 'approval.required', 'infra.error', 'quota.warning', 'quota.reached', 'webhook.disabled', 'approval.policy_loosened'));--> statement-breakpoint
-- #345: every org's approval policies are copied into one `approval_policy` setting, so the
-- resolver reads what the table held. The table stays (nothing reads or writes it any more), so
-- rolling the binary back loses nothing but changes made after this ran.
INSERT INTO "settings" ("scope_kind", "scope_id", "org_id", "key", "value", "updated_by", "updated_at")
SELECT 'org', "org_id", "org_id", 'approval_policy',
	jsonb_object_agg("environment", jsonb_build_object('required', LEAST(GREATEST("required", 1), 10), 'allow_author_approval', "allow_author_approval" = 1, 'key_policy', 'any'))::text,
	'migration', (extract(epoch from now()) * 1000)::bigint
FROM "approval_policies"
WHERE NOT EXISTS (
	SELECT 1 FROM "settings"
	WHERE "settings"."scope_kind" = 'org' AND "settings"."scope_id" = "approval_policies"."org_id" AND "settings"."key" = 'approval_policy'
)
GROUP BY "org_id";
