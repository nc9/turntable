CREATE TABLE "notification_cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"last_event_id" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_prefs" (
	"user_id" text NOT NULL,
	"org_id" text DEFAULT '' NOT NULL,
	"project_id" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "notification_prefs_user_id_org_id_project_id_kind_pk" PRIMARY KEY("user_id","org_id","project_id","kind"),
	CONSTRAINT "notification_prefs_kind_check" CHECK (kind IN ('run_failed', 'infra_errors', 'work_held', 'approval_waiting', 'checkout_auth_failed', 'dogfood_red', 'deploy_failed'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"run_id" text,
	"count" bigint DEFAULT 1 NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"read_at" bigint,
	CONSTRAINT "notifications_dedupe_unique" UNIQUE("user_id","kind","dedupe_key"),
	CONSTRAINT "notifications_kind_check" CHECK (kind IN ('run_failed', 'infra_errors', 'work_held', 'approval_waiting', 'checkout_auth_failed', 'dogfood_red', 'deploy_failed'))
);
--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","id");