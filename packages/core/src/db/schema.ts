import { sql } from "drizzle-orm";
import {
  blob,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

// Portable types only, so a Postgres dialect is a mechanical port: ULID text ids, epoch-ms
// integer timestamps (UTC), 0/1 integer booleans, JSON as text, enums as text + CHECK, no arrays.
// Every tenant-owned table carries `org_id`; see src/db/repos for the scoped access layer.

const nowMs = sql`(unixepoch() * 1000)`;
const createdAt = () => integer("created_at", { mode: "number" }).notNull().default(nowMs);

export const JOB_STATES = [
  "queued",
  "running",
  "success",
  "failure",
  "infra_error",
  "awaiting_approval",
  "cancelled",
  "skipped",
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** Event types in the feed. Append-only; new types are additive (the column is text + CHECK). */
export const EVENT_TYPES = [
  "run.queued",
  "run.started",
  "run.finished",
  "job.state_changed",
  "attempt.step",
  "attempt.cut",
  "approval.required",
  "infra.error",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const STEP_STAGES = ["pre", "main", "post"] as const;
export type StepStage = (typeof STEP_STAGES)[number];

export const STEP_RESULTS = ["success", "failure", "skipped", "cancelled"] as const;
export type StepResult = (typeof STEP_RESULTS)[number];

/** Why a job waits for a human: an untrusted PR author, or a protected environment. */
export const APPROVAL_KINDS = ["untrusted_author", "environment"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export const MEMBER_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** Roles an agent token can hold. Org roles (MEMBER_ROLES) belong to people, never to tokens. */
export const AGENT_ROLES = ["reader", "operator", "release_operator"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const FORGES = ["github"] as const;
export type Forge = (typeof FORGES)[number];

const inList = (column: string, values: readonly string[]) =>
  sql.raw(`${column} IN (${values.map((v) => `'${v}'`).join(", ")})`);

/** One row per installation. Instance-level config; not tenant-owned. */
export const instance = sqliteTable("instance", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
});

// ---- tenancy ----

export const orgs = sqliteTable("orgs", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("projects_org_slug_unique").on(t.orgId, t.slug),
    // Target for composite FKs, so children cannot point at another org's project.
    unique("projects_id_org_unique").on(t.id, t.orgId),
  ],
);

export const projectRepos = sqliteTable(
  "project_repos",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    forge: text("forge").notNull(),
    installationId: text("installation_id"),
    /** Forge's stable numeric repo id (survives renames); prefer it for webhook routing. */
    forgeRepoId: text("forge_repo_id"),
    /** Stored lowercase: forge owner and repo names are case-insensitive. */
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.projectId, t.orgId], foreignColumns: [projects.id, projects.orgId] }),
    unique("project_repos_forge_owner_repo_unique").on(t.forge, t.owner, t.repo),
    // NULLs are distinct in SQLite unique indexes, so repos without an id do not collide.
    unique("project_repos_forge_repo_id_unique").on(t.forge, t.forgeRepoId),
    check("project_repos_forge_check", inList("forge", FORGES)),
  ],
);

/** Global identity (a person can belong to several orgs), so no org_id here. */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").unique(),
  displayName: text("display_name").notNull(),
  createdAt: createdAt(),
});

export const orgMembers = sqliteTable(
  "org_members",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.userId] }),
    check("org_members_role_check", inList("role", MEMBER_ROLES)),
  ],
);

// ---- runs ----

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    workflowPath: text("workflow_path").notNull(),
    event: text("event").notNull(),
    ref: text("ref").notNull(),
    sha: text("sha"),
    /** Metadata the forge (or `longshore run`) supplies. All forge text: untrusted when shown. */
    workflowName: text("workflow_name"),
    commitMessage: text("commit_message"),
    /** Forge login of whoever triggered it. */
    actor: text("actor"),
    headBranch: text("head_branch"),
    prNumber: integer("pr_number"),
    /**
     * Run-level planning facts as JSON text: the workflow `env`, the `github` and `vars`
     * contexts that `if:` expressions see, and the `concurrency` setting. The scheduler reads it
     * to decide when a job may run.
     */
    plan: text("plan"),
    /** The workflow's concurrency group (project-wide), for cancel-in-progress. */
    concurrencyGroup: text("concurrency_group"),
    /**
     * Started by `longshore run`: only the process that started it runs its attempts. A server's
     * worker never claims them, so a shared data directory is safe.
     */
    local: integer("local", { mode: "boolean" }).notNull().default(false),
    /** Aggregate of its jobs; same vocabulary as job state. */
    status: text("status").notNull().default("queued"),
    createdAt: createdAt(),
    startedAt: integer("started_at", { mode: "number" }),
    finishedAt: integer("finished_at", { mode: "number" }),
  },
  (t) => [
    foreignKey({ columns: [t.projectId, t.orgId], foreignColumns: [projects.id, projects.orgId] }),
    unique("runs_id_org_project_unique").on(t.id, t.orgId, t.projectId),
    check("runs_status_check", inList("status", JOB_STATES)),
    index("runs_project_created_idx").on(t.orgId, t.projectId, t.createdAt),
    index("runs_sha_idx").on(t.orgId, t.sha),
    index("runs_concurrency_idx").on(t.orgId, t.projectId, t.concurrencyGroup),
  ],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    runId: text("run_id").notNull(),
    jobKey: text("job_key").notNull(),
    name: text("name").notNull(),
    /** Job keys this job waits for, as a JSON array text. */
    needs: text("needs").notNull().default("[]"),
    /** This leg's matrix values as a JSON object text; null when the job has no matrix. */
    matrix: text("matrix"),
    /** One of APPROVAL_KINDS or null. Validated in createJob, not by a CHECK: a CHECK would force a table rebuild. */
    approvalKind: text("approval_kind"),
    /** The planned job as JSON text (key, ids, if:, outputs, continue-on-error ...). */
    planned: text("planned"),
    /** The job's outputs as a JSON object text, written when it finishes. */
    outputs: text("outputs"),
    state: text("state").notNull().default("queued"),
    /** Set only for `success` and `failure`. */
    exitCode: integer("exit_code"),
    createdAt: createdAt(),
    startedAt: integer("started_at", { mode: "number" }),
    finishedAt: integer("finished_at", { mode: "number" }),
  },
  (t) => [
    foreignKey({ columns: [t.projectId, t.orgId], foreignColumns: [projects.id, projects.orgId] }),
    foreignKey({
      columns: [t.runId, t.orgId, t.projectId],
      foreignColumns: [runs.id, runs.orgId, runs.projectId],
    }),
    unique("jobs_id_org_project_unique").on(t.id, t.orgId, t.projectId),
    unique("jobs_run_key_unique").on(t.runId, t.jobKey),
    check("jobs_state_check", inList("state", JOB_STATES)),
    index("jobs_run_idx").on(t.orgId, t.runId),
  ],
);

export const jobAttempts = sqliteTable(
  "job_attempts",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    jobId: text("job_id").notNull(),
    attempt: integer("attempt").notNull(),
    state: text("state").notNull().default("queued"),
    provider: text("provider").notNull(),
    sandboxId: text("sandbox_id"),
    exitCode: integer("exit_code"),
    errorClass: text("error_class"),
    /** Set when a person or agent asked for this attempt (a rerun); the reason they gave. */
    rerunReason: text("rerun_reason"),
    /**
     * The resolved job plan (actions pinned to shas, layout, argv, files) as JSON text, stored
     * when the attempt starts, so a restarted controller can re-attach with no repo fetch.
     */
    plan: text("plan"),
    /** The provider exec running the attempt, so a restarted controller can probe it. */
    execId: text("exec_id"),
    /**
     * Scheduler lease. A worker that claims a queued attempt owns it until `lease_expires_at`
     * and extends it by heartbeat. An expired lease on a running attempt means its worker is
     * gone: the reconciler resolves it.
     */
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "number" }),
    heartbeatAt: integer("heartbeat_at", { mode: "number" }),
    createdAt: createdAt(),
    startedAt: integer("started_at", { mode: "number" }),
    finishedAt: integer("finished_at", { mode: "number" }),
  },
  (t) => [
    foreignKey({
      columns: [t.jobId, t.orgId, t.projectId],
      foreignColumns: [jobs.id, jobs.orgId, jobs.projectId],
    }),
    unique("job_attempts_id_org_project_unique").on(t.id, t.orgId, t.projectId),
    unique("job_attempts_job_attempt_unique").on(t.jobId, t.attempt),
    check("job_attempts_state_check", inList("state", JOB_STATES)),
    index("job_attempts_state_idx").on(t.state, t.id),
  ],
);

/** Offset-addressed log bytes: `offset` is the byte position of the chunk in the attempt's log. */
export const logChunks = sqliteTable(
  "log_chunks",
  {
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    offset: integer("offset").notNull(),
    bytes: blob("bytes", { mode: "buffer" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.attemptId, t.offset] }),
    foreignKey({
      columns: [t.attemptId, t.orgId, t.projectId],
      foreignColumns: [jobAttempts.id, jobAttempts.orgId, jobAttempts.projectId],
    }),
  ],
);

// ---- agent access ----

/**
 * Bearer tokens for agents and scripts. Only the sha256 of the secret is stored; the secret is
 * shown once at creation. `project_id` null means the whole org.
 */
export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id"),
    name: text("name").notNull(),
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull(),
    /** Who minted it (`kind:id`), for audit and the "never exceeds its creator" rule. */
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    lastUsedAt: integer("last_used_at", { mode: "number" }),
    expiresAt: integer("expires_at", { mode: "number" }),
    revokedAt: integer("revoked_at", { mode: "number" }),
  },
  (t) => [
    // NULL project_id is not checked by the composite FK (MATCH SIMPLE), as intended.
    foreignKey({ columns: [t.projectId, t.orgId], foreignColumns: [projects.id, projects.orgId] }),
    unique("api_tokens_hash_unique").on(t.tokenHash),
    check("api_tokens_role_check", inList("role", AGENT_ROLES)),
    index("api_tokens_org_idx").on(t.orgId),
  ],
);

/** Append-only record of write and destructive operations, including denied attempts. */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id"),
    /** `token` or `member`. */
    principalKind: text("principal_kind").notNull(),
    principalId: text("principal_id").notNull(),
    op: text("op").notNull(),
    effect: text("effect").notNull(),
    /** `ok` or `error:<code>`. */
    outcome: text("outcome").notNull(),
    /** Input as JSON, truncated; never output. */
    input: text("input").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_org_created_idx").on(t.orgId, t.createdAt)],
);

// ---- events, steps, cuts ----

/**
 * Append-only event feed. `id` is the monotonic cursor (integer autoincrement: it is the cursor,
 * so no ULID here); `public_id` is a ULID for external reference. Rows are written in the same
 * transaction as the state change they describe.
 */
export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    publicId: text("public_id").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id"),
    type: text("type").notNull(),
    /** Subject ids, plain text (no FK): the feed outlives retries and is never rewritten. */
    runId: text("run_id"),
    jobId: text("job_id"),
    attemptId: text("attempt_id"),
    /** JSON text. */
    payload: text("payload").notNull().default("{}"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.projectId, t.orgId], foreignColumns: [projects.id, projects.orgId] }),
    unique("events_public_id_unique").on(t.publicId),
    check("events_type_check", inList("type", EVENT_TYPES)),
    index("events_org_idx").on(t.orgId, t.id),
    index("events_org_project_idx").on(t.orgId, t.projectId, t.id),
  ],
);

/** Steps of an attempt, as the runner reports them. `log_offset` is where the step's log starts. */
export const attemptSteps = sqliteTable(
  "attempt_steps",
  {
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    stepKey: text("step_key").notNull(),
    stage: text("stage").notNull(),
    stepIndex: integer("step_index").notNull(),
    name: text("name").notNull(),
    result: text("result"),
    startedAt: integer("started_at", { mode: "number" }),
    finishedAt: integer("finished_at", { mode: "number" }),
    logOffset: integer("log_offset").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.attemptId, t.stepKey, t.stage] }),
    foreignKey({
      columns: [t.attemptId, t.orgId, t.projectId],
      foreignColumns: [jobAttempts.id, jobAttempts.orgId, jobAttempts.projectId],
    }),
    check("attempt_steps_stage_check", inList("stage", STEP_STAGES)),
    check(
      "attempt_steps_result_check",
      sql.raw(`result IS NULL OR result IN (${STEP_RESULTS.map((v) => `'${v}'`).join(", ")})`),
    ),
  ],
);

/** Out-of-band marks where log bytes were omitted (head and tail caps), so the UI never guesses. */
export const logCuts = sqliteTable(
  "log_cuts",
  {
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    atOffset: integer("at_offset").notNull(),
    omittedBytes: integer("omitted_bytes").notNull(),
    reason: text("reason").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.attemptId, t.atOffset] }),
    foreignKey({
      columns: [t.attemptId, t.orgId, t.projectId],
      foreignColumns: [jobAttempts.id, jobAttempts.orgId, jobAttempts.projectId],
    }),
  ],
);

// ---- poll ingest ----

/**
 * One row per (repo, workflow, event, sha) the poller turned into a run. The unique key is what
 * makes ingest idempotent, and its `created_at` is what the per-hour run cap counts.
 */
export const pollSeen = sqliteTable(
  "poll_seen",
  {
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    /** `owner/name`, lowercase. */
    repo: text("repo").notNull(),
    workflowPath: text("workflow_path").notNull(),
    event: text("event").notNull(),
    sha: text("sha").notNull(),
    runId: text("run_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.repo, t.workflowPath, t.event, t.sha] }),
    foreignKey({ columns: [t.projectId, t.orgId], foreignColumns: [projects.id, projects.orgId] }),
    index("poll_seen_repo_created_idx").on(t.projectId, t.repo, t.createdAt),
  ],
);

// ---- GitHub App, secrets, webhooks ----

/**
 * Built-in encrypted secrets (envelope encryption, see src/secrets). `ciphertext` is the whole
 * sealed record; the (org, name) pair is bound into its AAD, so a row cannot be moved to another
 * name or org. Values are never selected into any API response.
 */
export const secrets = sqliteTable(
  "secrets",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    name: text("name").notNull(),
    ciphertext: text("ciphertext").notNull(),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull().default(nowMs),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.name] })],
);

/** The GitHub App this instance runs as. One per instance; its secrets live in `secrets`. */
export const githubApps = sqliteTable("github_apps", {
  /** The numeric GitHub App id, as text. */
  appId: text("app_id").primaryKey(),
  /** The org that owns the App and, with it, every installation of it. */
  orgId: text("org_id")
    .notNull()
    .references(() => orgs.id),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  ownerLogin: text("owner_login").notNull(),
  htmlUrl: text("html_url").notNull(),
  clientId: text("client_id").notNull(),
  /** Set while the previous webhook secret is still accepted after a rotation. */
  previousSecretExpiresAt: integer("previous_secret_expires_at", { mode: "number" }),
  createdAt: createdAt(),
});

export const INSTALLATION_STATUSES = ["active", "suspended", "deleted"] as const;
export type InstallationStatus = (typeof INSTALLATION_STATUSES)[number];

/** Installations of the App, mapped to the org that owns it. Facts come from the API. */
export const githubInstallations = sqliteTable(
  "github_installations",
  {
    installationId: text("installation_id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    appId: text("app_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountId: text("account_id").notNull(),
    accountType: text("account_type").notNull(),
    repositorySelection: text("repository_selection").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull().default(nowMs),
  },
  () => [check("github_installations_status_check", inList("status", INSTALLATION_STATUSES))],
);

export const DELIVERY_STATUSES = ["received", "processed", "ignored", "failed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * Every accepted webhook delivery, keyed by GitHub's delivery GUID: the dedupe key and the
 * audit trail. Written BEFORE the 202, tagged with the App's org.
 * `payload` is kept only for events a handler acts on, so an interrupted one can be retried.
 */
export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    /** The org that owns the App the delivery was addressed to. */
    orgId: text("org_id").references(() => orgs.id),
    forge: text("forge").notNull().default("github"),
    event: text("event").notNull(),
    action: text("action"),
    installationId: text("installation_id"),
    status: text("status").notNull().default("received"),
    error: text("error"),
    payload: text("payload"),
    receivedAt: integer("received_at", { mode: "number" }).notNull().default(nowMs),
    processedAt: integer("processed_at", { mode: "number" }),
  },
  (t) => [
    index("webhook_deliveries_received_idx").on(t.receivedAt),
    check("webhook_deliveries_status_check", inList("status", DELIVERY_STATUSES)),
  ],
);
