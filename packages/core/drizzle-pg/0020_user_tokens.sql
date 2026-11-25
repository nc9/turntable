CREATE TABLE "user_token_orgs" (
	"token_id" text NOT NULL,
	"org_id" text NOT NULL,
	"first_used_at" bigint NOT NULL,
	CONSTRAINT "user_token_orgs_token_id_org_id_pk" PRIMARY KEY("token_id","org_id")
);
--> statement-breakpoint
CREATE TABLE "user_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"github_user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"last_used_at" bigint,
	"expires_at" bigint NOT NULL,
	"revoked_at" bigint,
	CONSTRAINT "user_tokens_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "user_token_orgs" ADD CONSTRAINT "user_token_orgs_token_id_user_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."user_tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_token_orgs" ADD CONSTRAINT "user_token_orgs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_tokens_github_user_idx" ON "user_tokens" USING btree ("github_user_id");