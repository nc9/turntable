CREATE TABLE "action_pins" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"repo" text NOT NULL,
	"ref" text NOT NULL,
	"sha" text NOT NULL,
	"pending_sha" text,
	"first_seen" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"last_seen" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"accepted_at" bigint,
	CONSTRAINT "action_pins_project_id_repo_ref_pk" PRIMARY KEY("project_id","repo","ref")
);
--> statement-breakpoint
CREATE TABLE "action_verdicts" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"repo" text NOT NULL,
	"ref" text DEFAULT '' NOT NULL,
	"sha" text NOT NULL,
	"verdict" integer NOT NULL,
	"checked_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "action_verdicts_project_id_kind_repo_ref_sha_pk" PRIMARY KEY("project_id","kind","repo","ref","sha")
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"last_used_at" bigint,
	"expires_at" bigint,
	"revoked_at" bigint,
	CONSTRAINT "api_tokens_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "api_tokens_role_check" CHECK (role IN ('reader', 'operator', 'release_operator'))
);
--> statement-breakpoint
CREATE TABLE "approval_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"statement_hash" text NOT NULL,
	"principal" text,
	"expires_at" bigint NOT NULL,
	"used_at" bigint
);
--> statement-breakpoint
CREATE TABLE "approval_key_policies" (
	"org_id" text PRIMARY KEY NOT NULL,
	"policy" text NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"presets" text DEFAULT '[]' NOT NULL,
	"aaguids" text DEFAULT '[]' NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_policies" (
	"org_id" text NOT NULL,
	"environment" text NOT NULL,
	"required" bigint NOT NULL,
	"allow_author_approval" bigint DEFAULT 0 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "approval_policies_org_id_environment_pk" PRIMARY KEY("org_id","environment")
);
--> statement-breakpoint
CREATE TABLE "approval_records" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"kind" text NOT NULL,
	"run_id" text,
	"environment" text,
	"enrolment_id" text,
	"statement_hash" text NOT NULL,
	"statement" text NOT NULL,
	"method" text NOT NULL,
	"approver_id" text NOT NULL,
	"person" text NOT NULL,
	"signature" text NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"expires_at" bigint NOT NULL,
	CONSTRAINT "approval_records_hash_unique" UNIQUE("org_id","statement_hash")
);
--> statement-breakpoint
CREATE TABLE "approver_enrolments" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"person" text NOT NULL,
	"forge_login" text,
	"kind" text NOT NULL,
	"credential_id" text,
	"public_key" text NOT NULL,
	"alg" text NOT NULL,
	"sign_count" bigint DEFAULT 0 NOT NULL,
	"aaguid" text,
	"attested" boolean DEFAULT false NOT NULL,
	"requested_by" text NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"expires_at" bigint NOT NULL,
	"activated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "approvers" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"person" text NOT NULL,
	"forge_login" text,
	"kind" text NOT NULL,
	"credential_id" text,
	"public_key" text NOT NULL,
	"alg" text NOT NULL,
	"sign_count" bigint DEFAULT 0 NOT NULL,
	"aaguid" text,
	"attested" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"revoked_at" bigint,
	CONSTRAINT "approvers_org_key_unique" UNIQUE("org_id","public_key"),
	CONSTRAINT "approvers_id_org_unique" UNIQUE("id","org_id")
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"name" text NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"klass" text DEFAULT 'untrusted_pr' NOT NULL,
	"run_sha" text,
	"digest_source" text DEFAULT 'reported' NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "artifacts_run_name_unique" UNIQUE("org_id","project_id","run_id","name"),
	CONSTRAINT "artifacts_sha256_check" CHECK (length("artifacts"."sha256") = 64)
);
--> statement-breakpoint
CREATE TABLE "attempt_steps" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"step_key" text NOT NULL,
	"stage" text NOT NULL,
	"step_index" integer NOT NULL,
	"name" text NOT NULL,
	"result" text,
	"started_at" bigint,
	"finished_at" bigint,
	"log_offset" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "attempt_steps_attempt_id_step_key_stage_pk" PRIMARY KEY("attempt_id","step_key","stage"),
	CONSTRAINT "attempt_steps_stage_check" CHECK (stage IN ('pre', 'main', 'post')),
	CONSTRAINT "attempt_steps_result_check" CHECK (result IS NULL OR result IN ('success', 'failure', 'skipped', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "audit_checkpoints" (
	"org_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"hash" text NOT NULL,
	"signed_at" bigint NOT NULL,
	"key_id" text NOT NULL,
	"signature" text NOT NULL,
	CONSTRAINT "audit_checkpoints_org_id_seq_pk" PRIMARY KEY("org_id","seq")
);
--> statement-breakpoint
CREATE TABLE "audit_export_cursors" (
	"org_id" text NOT NULL,
	"sink" text NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "audit_export_cursors_org_id_sink_pk" PRIMARY KEY("org_id","sink")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"principal_kind" text NOT NULL,
	"principal_id" text NOT NULL,
	"op" text NOT NULL,
	"effect" text NOT NULL,
	"outcome" text NOT NULL,
	"input" text NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"seq" bigint,
	"prev_hash" text,
	"hash" text,
	CONSTRAINT "audit_log_org_seq_unique" UNIQUE("org_id","seq")
);
--> statement-breakpoint
CREATE TABLE "cache_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cache_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"klass" text NOT NULL,
	"ref_scope" text NOT NULL,
	"key" text NOT NULL,
	"version" text NOT NULL,
	"size" bigint DEFAULT 0 NOT NULL,
	"complete" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"used_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"type" text NOT NULL,
	"run_id" text,
	"job_id" text,
	"attempt_id" text,
	"payload" text DEFAULT '{}' NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "events_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "events_type_check" CHECK (type IN ('run.queued', 'run.started', 'run.finished', 'job.state_changed', 'attempt.step', 'attempt.cut', 'approval.required', 'infra.error'))
);
--> statement-breakpoint
CREATE TABLE "github_apps" (
	"app_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"owner_login" text NOT NULL,
	"html_url" text NOT NULL,
	"client_id" text NOT NULL,
	"previous_secret_expires_at" bigint,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"installation_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"app_id" text NOT NULL,
	"account_login" text NOT NULL,
	"account_id" text NOT NULL,
	"account_type" text NOT NULL,
	"repository_selection" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"updated_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "github_installations_status_check" CHECK (status IN ('active', 'suspended', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "incident_rotation_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"source" text DEFAULT 'builtin' NOT NULL,
	"reason" text NOT NULL,
	"flagged_by" text NOT NULL,
	"flagged_at" bigint NOT NULL,
	"cleared_at" bigint
);
--> statement-breakpoint
CREATE TABLE "installation_claims" (
	"nonce" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"started_by" text NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"expires_at" bigint NOT NULL,
	"used_at" bigint,
	"installation_id" text,
	"expected_login" text,
	"github_user_id" text,
	"github_login" text
);
--> statement-breakpoint
CREATE TABLE "instance" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"job_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"provider" text NOT NULL,
	"sandbox_id" text,
	"exit_code" integer,
	"error_class" text,
	"rerun_reason" text,
	"check_run_id" text,
	"plan" text,
	"trust_class" text,
	"exec_id" text,
	"lease_owner" text,
	"lease_expires_at" bigint,
	"heartbeat_at" bigint,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"started_at" bigint,
	"finished_at" bigint,
	"sandbox_created_at" bigint,
	"sandbox_destroyed_at" bigint,
	CONSTRAINT "job_attempts_id_org_project_unique" UNIQUE("id","org_id","project_id"),
	CONSTRAINT "job_attempts_job_attempt_unique" UNIQUE("job_id","attempt"),
	CONSTRAINT "job_attempts_state_check" CHECK (state IN ('queued', 'running', 'success', 'failure', 'infra_error', 'awaiting_approval', 'cancelled', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"job_key" text NOT NULL,
	"name" text NOT NULL,
	"needs" text DEFAULT '[]' NOT NULL,
	"matrix" text,
	"approval_kind" text,
	"planned" text,
	"outputs" text,
	"state" text DEFAULT 'queued' NOT NULL,
	"exit_code" integer,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"started_at" bigint,
	"finished_at" bigint,
	CONSTRAINT "jobs_id_org_project_unique" UNIQUE("id","org_id","project_id"),
	CONSTRAINT "jobs_run_key_unique" UNIQUE("run_id","job_key"),
	CONSTRAINT "jobs_state_check" CHECK (state IN ('queued', 'running', 'success', 'failure', 'infra_error', 'awaiting_approval', 'cancelled', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "log_chunks" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"offset" bigint NOT NULL,
	"bytes" "bytea" NOT NULL,
	CONSTRAINT "log_chunks_attempt_id_offset_pk" PRIMARY KEY("attempt_id","offset")
);
--> statement-breakpoint
CREATE TABLE "log_cuts" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"at_offset" bigint NOT NULL,
	"omitted_bytes" bigint NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "log_cuts_attempt_id_at_offset_pk" PRIMARY KEY("attempt_id","at_offset")
);
--> statement-breakpoint
CREATE TABLE "org_members" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "org_members_org_id_user_id_pk" PRIMARY KEY("org_id","user_id"),
	CONSTRAINT "org_members_role_check" CHECK (role IN ('owner', 'admin', 'member', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "org_quotas" (
	"org_id" text PRIMARY KEY NOT NULL,
	"max_concurrent" bigint,
	"max_runs_per_hour" bigint,
	"max_sandbox_minutes_per_day" bigint,
	"max_log_bytes" bigint,
	"max_stored_bytes" bigint,
	"updated_by" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"action_owner_allowlist" text,
	"approve_run_min_role" text DEFAULT 'release_operator' NOT NULL,
	"frozen_at" bigint,
	"frozen_reason" text,
	"frozen_by" text,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "orgs_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "poll_seen" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"repo" text NOT NULL,
	"workflow_path" text NOT NULL,
	"event" text NOT NULL,
	"sha" text NOT NULL,
	"run_id" text NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "poll_seen_project_id_repo_workflow_path_event_sha_pk" PRIMARY KEY("project_id","repo","workflow_path","event","sha")
);
--> statement-breakpoint
CREATE TABLE "project_repos" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"forge" text NOT NULL,
	"installation_id" text,
	"forge_repo_id" text,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "project_repos_forge_owner_repo_unique" UNIQUE("forge","owner","repo"),
	CONSTRAINT "project_repos_forge_repo_id_unique" UNIQUE("forge","forge_repo_id"),
	CONSTRAINT "project_repos_forge_check" CHECK (forge IN ('github'))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"require_sha_pins" integer DEFAULT 0 NOT NULL,
	"egress" text DEFAULT 'none' NOT NULL,
	"release_refs" text,
	"signing_key" text,
	"signing_environment" text,
	"checks_mode" text DEFAULT 'off' NOT NULL,
	"ingest_config" text,
	"frozen_at" bigint,
	"frozen_reason" text,
	"frozen_by" text,
	"cache_release_restore" integer DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "projects_org_slug_unique" UNIQUE("org_id","slug"),
	CONSTRAINT "projects_id_org_unique" UNIQUE("id","org_id")
);
--> statement-breakpoint
CREATE TABLE "proxy_passthrough_hosts" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"host" text NOT NULL,
	"ports" text DEFAULT '[443]' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "proxy_passthrough_hosts_unique" UNIQUE("org_id","project_id","host")
);
--> statement-breakpoint
CREATE TABLE "proxy_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"secret" text NOT NULL,
	"host" text NOT NULL,
	"port" bigint DEFAULT 443 NOT NULL,
	"methods" text NOT NULL,
	"path_prefix" text NOT NULL,
	"inject_type" text NOT NULL,
	"inject_header" text,
	"inject_format" text,
	"inject_username" text,
	"created_by" text NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"updated_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "proxy_rules_name_unique" UNIQUE("org_id","project_id","name"),
	CONSTRAINT "proxy_rules_inject_check" CHECK ("proxy_rules"."inject_type" in ('header', 'basic'))
);
--> statement-breakpoint
CREATE TABLE "quota_notices" (
	"org_id" text NOT NULL,
	"metric" text NOT NULL,
	"level" text NOT NULL,
	"window" text NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "quota_notices_org_id_metric_level_window_pk" PRIMARY KEY("org_id","metric","level","window")
);
--> statement-breakpoint
CREATE TABLE "release_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"tag" text NOT NULL,
	"artifacts" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"detail" text,
	"requested_by" text NOT NULL,
	"claimed_by" text,
	"claimed_at" bigint,
	"finished_at" bigint,
	"result" text,
	"facts" text,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "release_requests_status_check" CHECK (status IN ('pending', 'claimed', 'signed', 'refused', 'error'))
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"workflow_path" text NOT NULL,
	"event" text NOT NULL,
	"ref" text NOT NULL,
	"sha" text,
	"workflow_name" text,
	"commit_message" text,
	"actor" text,
	"head_branch" text,
	"pr_number" integer,
	"plan" text,
	"concurrency_group" text,
	"local" boolean DEFAULT false NOT NULL,
	"repo" text,
	"trust" text,
	"approval" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"started_at" bigint,
	"finished_at" bigint,
	CONSTRAINT "runs_id_org_project_unique" UNIQUE("id","org_id","project_id"),
	CONSTRAINT "runs_status_check" CHECK (status IN ('queued', 'running', 'success', 'failure', 'infra_error', 'awaiting_approval', 'cancelled', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"ciphertext" text NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"updated_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "secrets_org_id_name_pk" PRIMARY KEY("org_id","name")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text,
	"display_name" text NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "vault_secret_versions" (
	"secret_id" text NOT NULL,
	"org_id" text NOT NULL,
	"version" bigint NOT NULL,
	"ciphertext" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"valid_until" bigint,
	CONSTRAINT "vault_secret_versions_secret_id_version_pk" PRIMARY KEY("secret_id","version")
);
--> statement-breakpoint
CREATE TABLE "vault_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"environment" text,
	"ref_pattern" text,
	"scope_key" text NOT NULL,
	"trust_classes" text NOT NULL,
	"destinations" text NOT NULL,
	"current_version" bigint NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"updated_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"last_used_at" bigint,
	CONSTRAINT "vault_secrets_scope_unique" UNIQUE("org_id","name","scope_key"),
	CONSTRAINT "vault_secrets_id_org_unique" UNIQUE("id","org_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"forge" text DEFAULT 'github' NOT NULL,
	"event" text NOT NULL,
	"action" text,
	"installation_id" text,
	"status" text DEFAULT 'received' NOT NULL,
	"error" text,
	"payload" text,
	"received_at" bigint DEFAULT ((extract(epoch from now()) * 1000)::bigint) NOT NULL,
	"processed_at" bigint,
	CONSTRAINT "webhook_deliveries_status_check" CHECK (status IN ('received', 'processed', 'ignored', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "action_pins" ADD CONSTRAINT "action_pins_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_verdicts" ADD CONSTRAINT "action_verdicts_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_challenges" ADD CONSTRAINT "approval_challenges_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_key_policies" ADD CONSTRAINT "approval_key_policies_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_records" ADD CONSTRAINT "approval_records_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approver_enrolments" ADD CONSTRAINT "approver_enrolments_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvers" ADD CONSTRAINT "approvers_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_org_id_project_id_runs_id_org_id_project_id_fk" FOREIGN KEY ("run_id","org_id","project_id") REFERENCES "public"."runs"("id","org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_attempt_id_org_id_project_id_job_attempts_id_org_id_project_id_fk" FOREIGN KEY ("attempt_id","org_id","project_id") REFERENCES "public"."job_attempts"("id","org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_steps" ADD CONSTRAINT "attempt_steps_attempt_id_org_id_project_id_job_attempts_id_org_id_project_id_fk" FOREIGN KEY ("attempt_id","org_id","project_id") REFERENCES "public"."job_attempts"("id","org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_checkpoints" ADD CONSTRAINT "audit_checkpoints_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_export_cursors" ADD CONSTRAINT "audit_export_cursors_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cache_entries" ADD CONSTRAINT "cache_entries_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cache_entries" ADD CONSTRAINT "cache_entries_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_apps" ADD CONSTRAINT "github_apps_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_rotation_flags" ADD CONSTRAINT "incident_rotation_flags_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installation_claims" ADD CONSTRAINT "installation_claims_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_job_id_org_id_project_id_jobs_id_org_id_project_id_fk" FOREIGN KEY ("job_id","org_id","project_id") REFERENCES "public"."jobs"("id","org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_run_id_org_id_project_id_runs_id_org_id_project_id_fk" FOREIGN KEY ("run_id","org_id","project_id") REFERENCES "public"."runs"("id","org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_chunks" ADD CONSTRAINT "log_chunks_attempt_id_org_id_project_id_job_attempts_id_org_id_project_id_fk" FOREIGN KEY ("attempt_id","org_id","project_id") REFERENCES "public"."job_attempts"("id","org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_cuts" ADD CONSTRAINT "log_cuts_attempt_id_org_id_project_id_job_attempts_id_org_id_project_id_fk" FOREIGN KEY ("attempt_id","org_id","project_id") REFERENCES "public"."job_attempts"("id","org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_quotas" ADD CONSTRAINT "org_quotas_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_seen" ADD CONSTRAINT "poll_seen_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_passthrough_hosts" ADD CONSTRAINT "proxy_passthrough_hosts_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_rules" ADD CONSTRAINT "proxy_rules_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_notices" ADD CONSTRAINT "quota_notices_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_requests" ADD CONSTRAINT "release_requests_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_secret_versions" ADD CONSTRAINT "vault_secret_versions_secret_id_org_id_vault_secrets_id_org_id_fk" FOREIGN KEY ("secret_id","org_id") REFERENCES "public"."vault_secrets"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_secrets" ADD CONSTRAINT "vault_secrets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_secrets" ADD CONSTRAINT "vault_secrets_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_verdicts_checked_idx" ON "action_verdicts" USING btree ("checked_at");--> statement-breakpoint
CREATE INDEX "api_tokens_org_idx" ON "api_tokens" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "approval_challenges_org_idx" ON "approval_challenges" USING btree ("org_id","expires_at");--> statement-breakpoint
CREATE INDEX "approval_records_run_idx" ON "approval_records" USING btree ("org_id","run_id","environment");--> statement-breakpoint
CREATE INDEX "approval_records_enrol_idx" ON "approval_records" USING btree ("org_id","enrolment_id");--> statement-breakpoint
CREATE INDEX "approver_enrolments_org_idx" ON "approver_enrolments" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "approvers_org_person_idx" ON "approvers" USING btree ("org_id","person");--> statement-breakpoint
CREATE INDEX "artifacts_sha256_idx" ON "artifacts" USING btree ("org_id","sha256");--> statement-breakpoint
CREATE INDEX "audit_log_org_created_idx" ON "audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "cache_entries_ns_idx" ON "cache_entries" USING btree ("org_id","project_id","klass","ref_scope","key");--> statement-breakpoint
CREATE INDEX "cache_entries_used_idx" ON "cache_entries" USING btree ("org_id","klass","used_at");--> statement-breakpoint
CREATE INDEX "events_org_idx" ON "events" USING btree ("org_id","id");--> statement-breakpoint
CREATE INDEX "events_org_project_idx" ON "events" USING btree ("org_id","project_id","id");--> statement-breakpoint
CREATE INDEX "incident_rotation_flags_org_idx" ON "incident_rotation_flags" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "installation_claims_org_idx" ON "installation_claims" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "job_attempts_state_idx" ON "job_attempts" USING btree ("state","id");--> statement-breakpoint
CREATE INDEX "job_attempts_sandbox_idx" ON "job_attempts" USING btree ("org_id","sandbox_created_at");--> statement-breakpoint
CREATE INDEX "jobs_run_idx" ON "jobs" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE INDEX "poll_seen_repo_created_idx" ON "poll_seen" USING btree ("project_id","repo","created_at");--> statement-breakpoint
CREATE INDEX "release_requests_status_idx" ON "release_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "runs_project_created_idx" ON "runs" USING btree ("org_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_sha_idx" ON "runs" USING btree ("org_id","sha");--> statement-breakpoint
CREATE INDEX "runs_concurrency_idx" ON "runs" USING btree ("org_id","project_id","concurrency_group");--> statement-breakpoint
CREATE INDEX "vault_secrets_org_name_idx" ON "vault_secrets" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_received_idx" ON "webhook_deliveries" USING btree ("received_at");