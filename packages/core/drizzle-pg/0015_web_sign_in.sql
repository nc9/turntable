CREATE TABLE "github_identities" (
	"github_user_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"login" text NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"last_sign_in_at" bigint,
	CONSTRAINT "github_identities_user_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "login_states" (
	"nonce" text PRIMARY KEY NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"expires_at" bigint NOT NULL,
	"used_at" bigint
);
--> statement-breakpoint
CREATE TABLE "member_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"github_login" text NOT NULL,
	"role" text NOT NULL,
	"created_by" text NOT NULL,
	"reason" text,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"expires_at" bigint NOT NULL,
	"used_at" bigint,
	"used_by_user_id" text,
	"revoked_at" bigint,
	CONSTRAINT "member_invites_role_check" CHECK (role IN ('owner', 'admin', 'member', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "web_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"revoked_at" bigint
);
--> statement-breakpoint
ALTER TABLE "github_identities" ADD CONSTRAINT "github_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_invites" ADD CONSTRAINT "member_invites_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_invites_login_idx" ON "member_invites" USING btree ("github_login");--> statement-breakpoint
CREATE INDEX "member_invites_org_idx" ON "member_invites" USING btree ("org_id","github_login");--> statement-breakpoint
CREATE INDEX "web_sessions_user_idx" ON "web_sessions" USING btree ("user_id");