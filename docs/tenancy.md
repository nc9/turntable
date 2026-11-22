# Tenancy model

One Turntable instance serves many orgs. An org is the tenant. Isolation is enforced in the data layer, not by convention.

## Entities

- **Org**: the tenant boundary. Has a unique slug.
- **Project**: belongs to one org, slug unique per org. Runs, jobs and logs hang off a project.
- **Project repo**: binds a project to a forge repo (today: GitHub, optionally with an installation id). A `(forge, owner, repo)` triple belongs to exactly one project instance-wide, so webhook routing is unambiguous. Owner and repo are stored lowercase (forges treat them case-insensitively). `forge_repo_id` holds the forge's stable numeric id, unique per forge when set; webhook routing should prefer it when present, because names change on rename and transfer.
- **User**: global identity. A person can belong to several orgs.
- **Org member**: links a user to an org with a role: `owner`, `admin`, `member` or `viewer`.
- **Local tenant**: `turntable run` uses a built-in org `local` with project `local`, created idempotently by `ensureLocalTenant`.

## Runs, jobs, attempts, logs

- A **run** is one workflow execution for a project. A **job** is one job of that run. A **job attempt** is one try of a job in one sandbox. **Log chunks** are byte-addressed per attempt, so readers resume by offset.
- Job states: `queued`, `running`, `success`, `failure`, `infra_error`, `awaiting_approval`, `cancelled`.
  - `failure` is the job's own non-zero exit.
  - `infra_error` means no trustworthy result: sandbox create failed, provider error, exit code unrecoverable, infra timeout.
  - `success`, `failure` and `cancelled` are terminal. `infra_error` can return to `queued` for a retry, which creates a new attempt.

## Isolation guarantees

1. Every tenant-owned table has an `org_id` column. A test fails if a new table lacks one and is not on the explicit allowlist (`instance`, `orgs`, `users`).
2. All access goes through `packages/core/src/db/repos`. Each function takes a `Scope` (`{ orgId, projectId? }`) and always filters by it. A lookup by id in another org returns nothing; writes affect nothing.
3. A source-guard test fails if code outside the repos module references a tenant table.
4. Composite foreign keys such as `(run_id, org_id, project_id)` make the database reject a child row whose org or project differs from its parent's, even if application code is wrong. Jobs, attempts and log chunks all carry `project_id`, so a project-narrowed scope cannot reach a sibling project's data in the same org.
5. Portable column types (ULID text ids, epoch-ms integers, text plus CHECK for enums, no arrays) keep a Postgres port mechanical.

## Scope of the guarantee

These rules cover the database layer. As later milestones land, the same org boundary applies to secrets, caches and sandboxes: none of them may be shared across orgs. Webhook routing (`resolveRepoScope`) is the one deliberately unscoped lookup, because the caller has no tenant yet. When a binding has an `installation_id`, the incoming installation must match it, so a same-named repo under another installation cannot route into the bound org.
