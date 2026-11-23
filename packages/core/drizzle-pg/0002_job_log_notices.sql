CREATE TABLE "log_notices" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"at_offset" bigint NOT NULL,
	"source" text NOT NULL,
	"text" text NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "log_notices" ADD CONSTRAINT "log_notices_attempt_id_org_id_project_id_job_attempts_id_org_id_project_id_fk" FOREIGN KEY ("attempt_id","org_id","project_id") REFERENCES "public"."job_attempts"("id","org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "log_notices_attempt_idx" ON "log_notices" USING btree ("attempt_id","at_offset");