ALTER TABLE "job_attempts" ADD COLUMN "adopt_block" text;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN "exec_log_offset" bigint;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN "log_checkpoint" bigint;