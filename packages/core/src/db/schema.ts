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
  /** JSON array of allowed action owners (`actions`, `docker`, ...). Null means no allowlist. */
  actionOwnerAllowlist: text("action_owner_allowlist"),
  /**
   * Lowest agent role that may call `approve_run` in this org: `release_operator` (default) or
   * `operator`. An operator token may belong to an agent that has just read an untrusted pull
   * request's text, which is why the default is the stricter role.
   */
  approveRunMinRole: text("approve_run_min_role").notNull().default("release_operator"),
  /** Incident freeze (`incident_freeze`): no attempt of this org is claimed while set. */
  frozenAt: integer("frozen_at", { mode: "number" }),
  frozenReason: text("frozen_reason"),
  frozenBy: text("frozen_by"),
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
    /** 1: every `uses:` must already be a full commit sha; tags and branches are refused. */
    requireShaPins: integer("require_sha_pins").notNull().default(0),
    /**
     * Sandbox egress for the project's server runs: `none`, `open` or `allowlist`. A repo's own
     * `egress` in the poll config overrides it. Default `none`.
     */
    egress: text("egress").notNull().default("none"),
    /**
     * Ref patterns (JSON array text) that count as a release for signing, for example
     * `["refs/tags/v*"]`. Null: the default, `refs/tags/v*`.
     */
    releaseRefs: text("release_refs"),
    /**
     * The key releases are signed with: `builtin:<name>`, `aws-kms:<key id or ARN>` or
     * `gcp-kms:<key version name>`. Null: this project cannot sign.
     */
    signingKey: text("signing_key"),
    /**
     * Whether the server reports job results to the forge as check runs: `off` (default),
     * `shadow` (always neutral, the real result in the text) or `live` (real conclusions). Set
     * only from the CLI (`longshore policy set --checks-mode`).
     */
    checksMode: text("checks_mode").notNull().default("off"),
    /** Incident freeze for this project alone; the org's freeze applies on top of it. */
    frozenAt: integer("frozen_at", { mode: "number" }),
    frozenReason: text("frozen_reason"),
    frozenBy: text("frozen_by"),
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
    /**
     * The repo a poll-created run is for (`owner/name`, lower case); null for local runs and
     * runs from before this column. A project may bind several repos, so pull request numbers,
     * concurrency groups and waiting caps are all scoped by it.
     */
    repo: text("repo"),
    /**
     * The trust decision (JSON text: class, reasons, the forge facts it came from, the workflow
     * hash, when). Null for runs with no decision (local runs, runs from before trust classes).
     */
    trust: text("trust"),
    /**
     * Who approved this run and for what (JSON text: by, at, head_sha, workflow_hash); null until
     * approved. An approval is bound to the sha and workflow hash, and never raises the class.
     */
    approval: text("approval"),
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
    /** The forge check run reporting this attempt, so a retry or a re-attach updates it. */
    checkRunId: text("check_run_id"),
    /**
     * The resolved job plan (actions pinned to shas, layout, argv, files) as JSON text, stored
     * when the attempt starts, so a restarted controller can re-attach with no repo fetch.
     */
    plan: text("plan"),
    /**
     * The trust class this attempt runs as, after the demotion rule, written once by the
     * scheduler before the sandbox starts. The secrets vault trusts only this: a null means
     * "not decided", and the vault refuses.
     */
    trustClass: text("trust_class"),
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
    /**
     * The hash chain (see src/audit): position in the org's chain, the previous entry's hash and
     * this entry's own. Null on rows written before chaining existed; those are not covered.
     */
    seq: integer("seq"),
    prevHash: text("prev_hash"),
    hash: text("hash"),
  },
  (t) => [
    index("audit_log_org_created_idx").on(t.orgId, t.createdAt),
    // NULLs are distinct in SQLite unique indexes, so unchained legacy rows do not collide.
    unique("audit_log_org_seq_unique").on(t.orgId, t.seq),
  ],
);

/** An ed25519 signature over the head of an org's chain at `seq`. The key is not in this database. */
export const auditCheckpoints = sqliteTable(
  "audit_checkpoints",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    seq: integer("seq").notNull(),
    hash: text("hash").notNull(),
    signedAt: integer("signed_at", { mode: "number" }).notNull(),
    keyId: text("key_id").notNull(),
    signature: text("signature").notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.seq] })],
);

/** How far each org's chain has been exported to each sink (at-least-once delivery). */
export const auditExportCursors = sqliteTable(
  "audit_export_cursors",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    sink: text("sink").notNull(),
    lastSeq: integer("last_seq").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "number" }).notNull().default(nowMs),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.sink] })],
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

/**
 * The tag-to-sha map per project: every resolution of an action ref is remembered, so a tag that
 * later points at a different commit (a moved tag) is detected. `pending_sha` is the commit a
 * moved tag now points at, held until an operator accepts it.
 */
export const actionPins = sqliteTable(
  "action_pins",
  {
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    /** `owner/repo`, lowercase. */
    repo: text("repo").notNull(),
    ref: text("ref").notNull(),
    sha: text("sha").notNull(),
    pendingSha: text("pending_sha"),
    firstSeen: integer("first_seen", { mode: "number" }).notNull().default(nowMs),
    lastSeen: integer("last_seen", { mode: "number" }).notNull().default(nowMs),
    acceptedAt: integer("accepted_at", { mode: "number" }),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.repo, t.ref] }),
    foreignKey({ columns: [t.projectId, t.orgId], foreignColumns: [projects.id, projects.orgId] }),
  ],
);

/**
 * Verdicts about actions that took network calls to learn, kept so a restart or a parallel job
 * does not ask again. `resolve`: a tag or branch resolved to a sha (`ref` set, `sha` the result,
 * short life, since refs move). `reach`: a sha is, or is not, reachable from a branch or tag of
 * its own repo (`ref` empty, `sha` the key, `verdict` 1 or 0). Rows expire by age at read time.
 */
export const actionVerdicts = sqliteTable(
  "action_verdicts",
  {
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    kind: text("kind").notNull(),
    /** `owner/repo`, lowercase. */
    repo: text("repo").notNull(),
    ref: text("ref").notNull().default(""),
    sha: text("sha").notNull(),
    verdict: integer("verdict").notNull(),
    checkedAt: integer("checked_at", { mode: "number" }).notNull().default(nowMs),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.kind, t.repo, t.ref, t.sha] }),
    foreignKey({ columns: [t.projectId, t.orgId], foreignColumns: [projects.id, projects.orgId] }),
    index("action_verdicts_checked_idx").on(t.checkedAt),
  ],
);

// ---- secrets vault (#14) ----

/**
 * A scoped secret. The row holds policy (where, for whom, to which hosts) and never a value;
 * values live sealed in `vault_secret_versions`. `scope_key` is the normalised tuple
 * (project, environment, ref pattern) with `*` for unset, so uniqueness is enforced even though
 * the columns are nullable. System secrets (the audit key, the GitHub App) are in `secrets`,
 * a different table and key domain, and are unreachable from here.
 */
export const vaultSecrets = sqliteTable(
  "vault_secrets",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id"),
    name: text("name").notNull(),
    environment: text("environment"),
    refPattern: text("ref_pattern"),
    scopeKey: text("scope_key").notNull(),
    /** JSON array of trust classes allowed to use it. Never contains untrusted_pr. */
    trustClasses: text("trust_classes").notNull(),
    /** JSON array of host patterns a delivery may go to. Empty: deliverable nowhere. */
    destinations: text("destinations").notNull(),
    currentVersion: integer("current_version", { mode: "number" }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull().default(nowMs),
    lastUsedAt: integer("last_used_at", { mode: "number" }),
  },
  (t) => [
    unique("vault_secrets_scope_unique").on(t.orgId, t.name, t.scopeKey),
    unique("vault_secrets_id_org_unique").on(t.id, t.orgId),
    foreignKey({ columns: [t.projectId, t.orgId], foreignColumns: [projects.id, projects.orgId] }),
    index("vault_secrets_org_name_idx").on(t.orgId, t.name),
  ],
);

/** One sealed value. The previous version stays usable until `valid_until` (rotation overlap). */
export const vaultSecretVersions = sqliteTable(
  "vault_secret_versions",
  {
    secretId: text("secret_id").notNull(),
    orgId: text("org_id").notNull(),
    version: integer("version", { mode: "number" }).notNull(),
    ciphertext: text("ciphertext").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    /** Null for the current version; for an older one, the end of its overlap window. */
    validUntil: integer("valid_until", { mode: "number" }),
  },
  (t) => [
    primaryKey({ columns: [t.secretId, t.version] }),
    foreignKey({
      columns: [t.secretId, t.orgId],
      foreignColumns: [vaultSecrets.id, vaultSecrets.orgId],
    }),
  ],
);

// ---- human approvals (#46) ----

export const APPROVER_KINDS = ["webauthn", "ed25519"] as const;
export type ApproverKind = (typeof APPROVER_KINDS)[number];

/**
 * An enrolled approval key. A person can hold several (a passkey, a security key, an offline
 * ed25519 key); distinctness for the two-person rule is by `person`. `public_key` is the SPKI DER
 * in base64 for every kind. Revoked keys stay for the audit trail and never verify again.
 */
export const approvers = sqliteTable(
  "approvers",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    /** The human this key belongs to; the unit the two-person rule counts. */
    person: text("person").notNull(),
    /** The person's forge login, so a run's author cannot approve it. Null when not given. */
    forgeLogin: text("forge_login"),
    kind: text("kind").notNull(),
    /** WebAuthn credential id, base64url. Null for ed25519. */
    credentialId: text("credential_id"),
    publicKey: text("public_key").notNull(),
    /** `ES256` or `EdDSA`. */
    alg: text("alg").notNull(),
    signCount: integer("sign_count", { mode: "number" }).notNull().default(0),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    revokedAt: integer("revoked_at", { mode: "number" }),
  },
  (t) => [
    unique("approvers_org_key_unique").on(t.orgId, t.publicKey),
    unique("approvers_id_org_unique").on(t.id, t.orgId),
    index("approvers_org_person_idx").on(t.orgId, t.person),
  ],
);

/** Per-environment approval policy. Without a row: production and release need 2, others 1. */
export const approvalPolicies = sqliteTable(
  "approval_policies",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    environment: text("environment").notNull(),
    required: integer("required", { mode: "number" }).notNull(),
    /** 1: the run's author may approve it. Off by default; for solo setups only. */
    allowAuthorApproval: integer("allow_author_approval", { mode: "number" }).notNull().default(0),
    updatedBy: text("updated_by").notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.environment] })],
);

/**
 * A server-issued, single-use challenge: the nonce inside a statement for the WebAuthn flow, and
 * the registration challenge. `id` is the nonce (random, base64url).
 */
export const approvalChallenges = sqliteTable(
  "approval_challenges",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    /** `approve`, `enrol` or `register`. */
    kind: text("kind").notNull(),
    /** The statement hash the challenge was issued for (sha256 hex); empty for `register`. */
    statementHash: text("statement_hash").notNull(),
    expiresAt: integer("expires_at", { mode: "number" }).notNull(),
    usedAt: integer("used_at", { mode: "number" }),
  },
  (t) => [index("approval_challenges_org_idx").on(t.orgId, t.expiresAt)],
);

/** A request to enrol a key, waiting for the existing approvers' quorum. */
export const approverEnrolments = sqliteTable(
  "approver_enrolments",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    person: text("person").notNull(),
    forgeLogin: text("forge_login"),
    kind: text("kind").notNull(),
    credentialId: text("credential_id"),
    publicKey: text("public_key").notNull(),
    alg: text("alg").notNull(),
    signCount: integer("sign_count", { mode: "number" }).notNull().default(0),
    requestedBy: text("requested_by").notNull(),
    createdAt: createdAt(),
    expiresAt: integer("expires_at", { mode: "number" }).notNull(),
    /** Set when the quorum signed and the key became an approver. */
    activatedAt: integer("activated_at", { mode: "number" }),
  },
  (t) => [index("approver_enrolments_org_idx").on(t.orgId, t.createdAt)],
);

/**
 * A verified, signed statement: an environment approval or an enrolment approval. The statement
 * and the signature are kept so the release lane can verify them again against its own keys.
 */
export const approvalRecords = sqliteTable(
  "approval_records",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id"),
    /** `environment` or `enrol`. */
    kind: text("kind").notNull(),
    runId: text("run_id"),
    environment: text("environment"),
    enrolmentId: text("enrolment_id"),
    /** sha256 hex of the canonical statement. Unique per org: a statement is accepted once. */
    statementHash: text("statement_hash").notNull(),
    /** Canonical JSON. */
    statement: text("statement").notNull(),
    method: text("method").notNull(),
    approverId: text("approver_id").notNull(),
    person: text("person").notNull(),
    /** JSON: what the approver's key produced (kind-specific). */
    signature: text("signature").notNull(),
    createdAt: createdAt(),
    expiresAt: integer("expires_at", { mode: "number" }).notNull(),
  },
  (t) => [
    unique("approval_records_hash_unique").on(t.orgId, t.statementHash),
    index("approval_records_run_idx").on(t.orgId, t.runId, t.environment),
    index("approval_records_enrol_idx").on(t.orgId, t.enrolmentId),
  ],
);

/**
 * Secret names an incident freeze flagged as needing rotation. One open row per (org, name);
 * `cleared_at` is set when someone rotates it. Kept apart from the secret stores so a freeze
 * never touches a value, and so every store (the built-in one, the vault) can be flagged the
 * same way. Names only.
 */
export const incidentRotationFlags = sqliteTable(
  "incident_rotation_flags",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    /** The project whose freeze raised it; null for an org-wide freeze. */
    projectId: text("project_id"),
    name: text("name").notNull(),
    /**
     * Which store the name came from: `builtin` (the GitHub App's key and webhook secret) or
     * `vault`. A flag is cleared only by an update in the store that raised it.
     */
    source: text("source").notNull().default("builtin"),
    reason: text("reason").notNull(),
    flaggedBy: text("flagged_by").notNull(),
    flaggedAt: integer("flagged_at", { mode: "number" }).notNull(),
    clearedAt: integer("cleared_at", { mode: "number" }),
  },
  (t) => [index("incident_rotation_flags_org_idx").on(t.orgId, t.name)],
);

/**
 * Artifacts recorded for a run, by name and sha256. Insert-only: a row is never updated or
 * deleted, and a name is recorded once per run, so what was recorded is what gets signed. The
 * signing service signs digests from here and from nowhere else.
 */
export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    runId: text("run_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    name: text("name").notNull(),
    /** Lower-case hex. */
    sha256: text("sha256").notNull(),
    size: integer("size", { mode: "number" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.projectId, t.orgId], foreignColumns: [projects.id, projects.orgId] }),
    // The run and the attempt must be in this org and project: no row can point across tenants.
    foreignKey({
      columns: [t.runId, t.orgId, t.projectId],
      foreignColumns: [runs.id, runs.orgId, runs.projectId],
    }),
    foreignKey({
      columns: [t.attemptId, t.orgId, t.projectId],
      foreignColumns: [jobAttempts.id, jobAttempts.orgId, jobAttempts.projectId],
    }),
    unique("artifacts_run_name_unique").on(t.orgId, t.projectId, t.runId, t.name),
    check("artifacts_sha256_check", sql`length(${t.sha256}) = 64`),
    index("artifacts_sha256_idx").on(t.orgId, t.sha256),
  ],
);
