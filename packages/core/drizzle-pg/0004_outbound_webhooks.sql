CREATE TABLE "outbound_webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"endpoint_id" text NOT NULL,
	"event_id" bigint NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"next_attempt_at" bigint NOT NULL,
	"lease_until" bigint,
	"last_status" bigint,
	"last_error" text,
	"last_response" text,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"delivered_at" bigint,
	CONSTRAINT "outbound_webhook_deliveries_endpoint_event_unique" UNIQUE("endpoint_id","event_id"),
	CONSTRAINT "outbound_webhook_deliveries_state_check" CHECK (state IN ('pending', 'delivered', 'abandoned'))
);
--> statement-breakpoint
CREATE TABLE "outbound_webhook_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"url" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"event_types" text,
	"state" text DEFAULT 'active' NOT NULL,
	"disabled_reason" text,
	"consecutive_failures" bigint DEFAULT 0 NOT NULL,
	"cursor" bigint DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"updated_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "outbound_webhook_endpoints_state_check" CHECK (state IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "outbound_webhook_secrets" (
	"org_id" text NOT NULL,
	"version" bigint NOT NULL,
	"sealed" text NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"expires_at" bigint,
	CONSTRAINT "outbound_webhook_secrets_org_id_version_pk" PRIMARY KEY("org_id","version")
);
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "outbound_webhook_deliveries" ADD CONSTRAINT "outbound_webhook_deliveries_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_webhook_deliveries" ADD CONSTRAINT "outbound_webhook_deliveries_endpoint_id_outbound_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."outbound_webhook_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_webhook_endpoints" ADD CONSTRAINT "outbound_webhook_endpoints_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_webhook_endpoints" ADD CONSTRAINT "outbound_webhook_endpoints_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_webhook_secrets" ADD CONSTRAINT "outbound_webhook_secrets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbound_webhook_deliveries_due_idx" ON "outbound_webhook_deliveries" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "outbound_webhook_deliveries_endpoint_idx" ON "outbound_webhook_deliveries" USING btree ("org_id","endpoint_id","created_at");--> statement-breakpoint
CREATE INDEX "outbound_webhook_endpoints_org_idx" ON "outbound_webhook_endpoints" USING btree ("org_id","state");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_type_check" CHECK (type IN ('run.queued', 'run.started', 'run.finished', 'job.state_changed', 'attempt.step', 'attempt.cut', 'approval.required', 'infra.error', 'quota.warning', 'quota.reached', 'webhook.disabled'));