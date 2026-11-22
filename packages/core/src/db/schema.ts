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
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const MEMBER_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

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
