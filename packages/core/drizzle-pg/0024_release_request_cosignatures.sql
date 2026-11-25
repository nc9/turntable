ALTER TABLE "release_requests" ADD COLUMN "cosignatures" text;--> statement-breakpoint
ALTER TABLE "release_requests" ADD COLUMN "dry_run" boolean DEFAULT false NOT NULL;