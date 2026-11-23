ALTER TABLE "events" DROP CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_type_check" CHECK (type IN ('run.queued', 'run.started', 'run.finished', 'job.state_changed', 'attempt.step', 'attempt.cut', 'approval.required', 'infra.error', 'quota.warning', 'quota.reached'));--> statement-breakpoint
-- Quota notices were `infra.error` events with an error_class (#182): they are quota.* now.
UPDATE "events" SET "type" = 'quota.warning', "payload" = ("payload"::jsonb - 'error_class')::text WHERE "type" = 'infra.error' AND "payload"::jsonb ->> 'error_class' = 'quota_warning';--> statement-breakpoint
UPDATE "events" SET "type" = 'quota.reached', "payload" = ("payload"::jsonb - 'error_class')::text WHERE "type" = 'infra.error' AND "payload"::jsonb ->> 'error_class' = 'quota_reached';
