CREATE TABLE "onboardings" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"installation_id" text,
	"first_run_id" text,
	"agent_token_id" text,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"updated_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "onboardings" ADD CONSTRAINT "onboardings_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "onboardings_org_idx" ON "onboardings" USING btree ("org_id","created_at");