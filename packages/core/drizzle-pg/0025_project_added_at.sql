ALTER TABLE "projects" ADD COLUMN "added_at" bigint;
--> statement-breakpoint
UPDATE "projects" SET "added_at" = "created_at" WHERE "ingest_config" IS NOT NULL OR EXISTS (SELECT 1 FROM "runs" WHERE "runs"."project_id" = "projects"."id");