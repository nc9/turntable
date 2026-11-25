ALTER TABLE "github_identities" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "github_identities" ADD COLUMN "avatar_synced_at" bigint;--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "avatar_synced_at" bigint;