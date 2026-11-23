ALTER TABLE "job_attempts" ADD COLUMN "check_dismissed_at" bigint;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN "check_dismissed_reason" text;