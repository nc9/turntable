ALTER TABLE "api_tokens" ADD COLUMN "kind" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "untrusted_run_approval" text DEFAULT 'no_agents' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_kind_check" CHECK (kind IN ('agent', 'person'));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_untrusted_run_approval_check" CHECK (untrusted_run_approval IN ('human', 'no_agents', 'any'));