// `turntable policy`: per-org settings that change what agents may do. Local access to the data
// directory is the trust root (like `turntable token`), so this writes through the repos directly
// and audits the change.
import type { Db } from "../db";
import { effectiveApproval, guardSettingChange } from "./setting-guard";
import { settingsRegistry, untrustedRunApprovalSetting } from "../settings/definitions";
import { createSettingsRuntime, type SettingsRuntime } from "../settings/resolve";
import { UNTRUSTED_RUN_APPROVALS, type UntrustedRunApproval } from "../db/schema";
import { validAudience } from "../oidc/issuer";
import { ingestSettingsSchema, type IngestSettings } from "../poll/config";
import {
  getProjectCacheReleaseRestore,
  getProjectOidcAudiences,
  setProjectCacheReleaseRestore,
  setProjectOidcAudiences,
  APPROVE_RUN_ROLES,
  appendAudit,
  type ApproveRunRole,
  getApproveRunMinRole,
  CHECKS_MODES,
  type ChecksMode,
  type EgressMode,
  getProjectChecksMode,
  setProjectChecksMode,
  getOrgBySlug,
  getProjectBySlug,
  getProjectSigning,
  setProjectSigning,
  signingKeyUsedByOtherOrg,
  getProjectEgress,
  getProjectSandboxSettings,
  setProjectSandboxSettings,
  SNAPSHOT_NAME,
  type ProjectSandboxSettings,
  listProjects,
  setApproveRunMinRole,
  setProjectEgress,
  getProjectIngest,
  listRepos,
  setProjectIngest,
} from "../db/repos";

export const POLICY_USAGE = `Usage:
  turntable policy show --org <slug> [--data-dir ./data]
  turntable policy set approve-run-min-role <operator|release_operator> --org <slug> [--data-dir ./data]
  turntable policy set --checks-mode <off|shadow|live> --org <slug> [--project <slug>] [--data-dir ./data]
  turntable policy set --egress <none|open|allowlist> --org <slug> [--project <slug>] [--data-dir ./data]
  turntable policy set --org <slug> --project <slug> [--sandbox-snapshot <name|none>]
      [--max-concurrent <n|none>] [--untrusted-run-approval <human|no_agents|any>] [--config turntable.toml]
      [--data-dir ./data]
  turntable policy set --ingest <on|off> --org <slug> --project <slug> [--workflow <path>]
      [--tag-refs refs/tags/v*,...]   (tags matching these become release runs; default none)
      [--default-branch <name>] [--pr-mode <off|allowlist|approval>] [--authors a,b]
      [--splits-json '<json>']   (run jobs as shards, e.g. [{"job":"tests","shards":[{"steps":["A"]},{"steps":["B"]}]}]; a shard may add "paths":["src/**"] to run only when they change; replaces the stored ones)
      [--var NAME=value ...]   (non-secret vars.* for workflows, e.g. TURNTABLE_CI=true; replaces the stored ones)
      [--merge-queue] [--data-dir ./data]
  turntable policy set --cache-release-restore <on|off> --org <slug> [--project <slug>] [--data-dir ./data]
  turntable policy set --oidc-audiences <aud,aud,...|any> --org <slug> [--project <slug>] [--data-dir ./data]
      (the audiences a project's jobs may mint OIDC tokens for; "any" lifts the limit)

approve-run-min-role: the lowest agent role that may approve a run held for an untrusted author.
Default release_operator. operator lets any operator token approve, including an agent that has
just read the untrusted pull request's text; use it only if you accept that.`;

async function orgOf(db: Db, slug: string) {
  const org = await getOrgBySlug(db, slug);
  if (!org) throw new Error(`no org with slug ${slug}`);
  return org;
}

export async function showPolicy(
  db: Db,
  orgSlug: string,
): Promise<{ approveRunMinRole: ApproveRunRole }> {
  const org = await orgOf(db, orgSlug);
  return { approveRunMinRole: await getApproveRunMinRole(db, org.id) };
}

export async function setPolicy(
  db: Db,
  orgSlug: string,
  key: string,
  value: string,
): Promise<{ key: string; from: string; to: string }> {
  if (key !== "approve-run-min-role") {
    throw new Error(`unknown policy ${key}; the only one is approve-run-min-role`);
  }
  if (!(APPROVE_RUN_ROLES as readonly string[]).includes(value)) {
    throw new Error(`approve-run-min-role must be one of: ${APPROVE_RUN_ROLES.join(", ")}`);
  }
  const org = await orgOf(db, orgSlug);
  const from = await getApproveRunMinRole(db, org.id);
  await db.transaction(async (tx) => {
    await setApproveRunMinRole(tx, org.id, value as ApproveRunRole);
    await appendAudit(
      tx,
      { orgId: org.id },
      {
        principalKind: "cli",
        principalId: "local",
        op: "policy_set",
        effect: "write",
        outcome: "ok",
        input: { key, from, to: value },
      },
    );
  });
  return { key, from, to: value };
}

const EGRESS_MODES: readonly EgressMode[] = ["none", "open", "allowlist"];

/**
 * Sets the default sandbox egress of one project (or every project of the org when none is
 * named). A repo's `egress` in the poll config overrides it, and untrusted runs never get `open`
 * whatever it says. Default `none`.
 */
export async function setEgressPolicy(
  db: Db,
  orgSlug: string,
  projectSlug: string | undefined,
  value: string,
): Promise<{ project: string; from: EgressMode; to: EgressMode }[]> {
  if (!(EGRESS_MODES as readonly string[]).includes(value)) {
    throw new Error(`--egress must be one of: ${EGRESS_MODES.join(", ")}`);
  }
  const org = await orgOf(db, orgSlug);
  const projects = projectSlug
    ? [await getProjectBySlug(db, { orgId: org.id }, projectSlug)]
    : await listProjects(db, { orgId: org.id });
  if (projects.length === 0 || projects.some((p) => p === undefined)) {
    throw new Error(
      projectSlug ? `no project ${projectSlug} in org ${orgSlug}` : "org has no projects",
    );
  }
  const out: { project: string; from: EgressMode; to: EgressMode }[] = [];
  for (const p of projects) {
    const scope = { orgId: org.id, projectId: p!.id };
    const from = await getProjectEgress(db, scope);
    await db.transaction(async (tx) => {
      await setProjectEgress(tx, scope, value as EgressMode);
      await appendAudit(tx, scope, {
        principalKind: "cli",
        principalId: "local",
        op: "policy_set",
        effect: "write",
        outcome: "ok",
        input: { key: "egress", project: p!.slug, from, to: value },
      });
    });
    out.push({ project: p!.slug, from, to: value as EgressMode });
  }
  return out;
}

/**
 * Turns ingest from the project's installation binding on or off, with the knobs a poll repo has.
 * `on` replaces the stored settings. Nothing is ingested for a bound repo until this is set, and
 * it decides who is trusted (`authors`), so it is a local, audited, CLI-only change.
 */
export async function setIngestPolicy(
  db: Db,
  orgSlug: string,
  projectSlug: string | undefined,
  mode: string,
  opts: {
    workflow?: string | undefined;
    defaultBranch?: string | undefined;
    prMode?: string | undefined;
    authors?: string[] | undefined;
    mergeQueue?: boolean | undefined;
    /** Tag ref patterns to ingest as release runs (refs/tags/v*). Unset: tags are not ingested. */
    tagRefs?: string[] | undefined;
    /** Non-secret `vars.*` for the workflows. Replaces the stored ones. */
    vars?: Record<string, string> | undefined;
    /** Job split rules (see splitsSchema). Replaces the stored ones. */
    splits?: unknown;
    everyPush?: boolean | undefined;
    /** Asks GitHub for a repo's default branch, once, when `defaultBranch` is not given. */
    resolveDefaultBranch?: ((repo: string) => Promise<string>) | undefined;
  } = {},
): Promise<{ project: string; from: IngestSettings | null; to: IngestSettings | null }> {
  if (mode !== "on" && mode !== "off") throw new Error("--ingest must be on or off");
  if (!projectSlug) throw new Error("--ingest needs --project");
  const org = await orgOf(db, orgSlug);
  const project = await getProjectBySlug(db, { orgId: org.id }, projectSlug);
  if (!project) throw new Error(`no project ${projectSlug} in org ${orgSlug}`);
  const scope = { orgId: org.id, projectId: project.id };
  const stored = await getProjectIngest(db, scope);
  const from =
    stored === null ? null : (ingestSettingsSchema.safeParse(JSON.parse(stored)).data ?? null);
  let to: IngestSettings | null = null;
  if (mode === "on") {
    // The default branch is fixed here and never re-resolved by the poller (see ingestSettingsSchema).
    let defaultBranch = opts.defaultBranch;
    if (!defaultBranch) {
      const bound = (await listRepos(db, scope)).find((r) => r.forge === "github");
      if (!bound || !opts.resolveDefaultBranch) {
        throw new Error(
          "give --default-branch: it is fixed when ingest is turned on and no bound repository could be asked",
        );
      }
      defaultBranch = await opts.resolveDefaultBranch(`${bound.owner}/${bound.repo}`);
    }
    const parsed = ingestSettingsSchema.safeParse({
      defaultBranch,
      ...(opts.workflow ? { workflow: opts.workflow } : {}),
      ...(opts.prMode ? { prMode: opts.prMode } : {}),
      ...(opts.authors ? { authors: opts.authors } : {}),
      ...(opts.mergeQueue ? { mergeQueue: true } : {}),
      ...(opts.tagRefs ? { tagRefs: opts.tagRefs } : {}),
      ...(opts.vars && Object.keys(opts.vars).length > 0 ? { vars: opts.vars } : {}),
      ...(opts.splits !== undefined ? { splits: opts.splits } : {}),
      ...(opts.everyPush ? { everyPush: true } : {}),
    });
    if (!parsed.success) {
      throw new Error(
        `invalid ingest settings: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }
    to = parsed.data;
  }
  await db.transaction(async (tx) => {
    await setProjectIngest(tx, scope, to === null ? null : JSON.stringify(to));
    await appendAudit(tx, scope, {
      principalKind: "cli",
      principalId: "local",
      op: "policy_set",
      effect: "write",
      outcome: "ok",
      input: { key: "ingest", project: project.slug, from, to },
    });
  });
  return { project: project.slug, from, to };
}

/** Each project's ingest settings, for `policy show`. */
export async function showIngest(
  db: Db,
  orgSlug: string,
): Promise<{ project: string; ingest: IngestSettings | null }[]> {
  const org = await orgOf(db, orgSlug);
  const out: { project: string; ingest: IngestSettings | null }[] = [];
  for (const p of await listProjects(db, { orgId: org.id })) {
    const v = await getProjectIngest(db, { orgId: org.id, projectId: p.id });
    out.push({
      project: p.slug,
      ingest: v === null ? null : (ingestSettingsSchema.safeParse(JSON.parse(v)).data ?? null),
    });
  }
  return out;
}

/** Each project's default egress, for `policy show`. */
export async function showEgress(
  db: Db,
  orgSlug: string,
): Promise<{ project: string; egress: EgressMode }[]> {
  const org = await orgOf(db, orgSlug);
  const out: { project: string; egress: EgressMode }[] = [];
  for (const p of await listProjects(db, { orgId: org.id })) {
    out.push({
      project: p.slug,
      egress: await getProjectEgress(db, { orgId: org.id, projectId: p.id }),
    });
  }
  return out;
}

/**
 * Sets whether the server reports job results to the forge as check runs. `shadow` posts only
 * neutral checks that cannot gate a merge; `live` posts real conclusions. Only this CLI can set
 * it (no operation exists), so an agent cannot turn it on. Without --project, every project.
 */
export async function setChecksModePolicy(
  db: Db,
  orgSlug: string,
  projectSlug: string | undefined,
  value: string,
): Promise<{ project: string; from: ChecksMode; to: ChecksMode }[]> {
  if (!(CHECKS_MODES as readonly string[]).includes(value)) {
    throw new Error(`--checks-mode must be one of: ${CHECKS_MODES.join(", ")}`);
  }
  const org = await orgOf(db, orgSlug);
  const projects = projectSlug
    ? [await getProjectBySlug(db, { orgId: org.id }, projectSlug)]
    : await listProjects(db, { orgId: org.id });
  if (projects.length === 0 || projects.some((p) => p === undefined)) {
    throw new Error(
      projectSlug ? `no project ${projectSlug} in org ${orgSlug}` : "org has no projects",
    );
  }
  const out: { project: string; from: ChecksMode; to: ChecksMode }[] = [];
  for (const p of projects) {
    const scope = { orgId: org.id, projectId: p!.id };
    const from = await getProjectChecksMode(db, scope);
    await db.transaction(async (tx) => {
      await setProjectChecksMode(tx, scope, value as ChecksMode);
      await appendAudit(tx, scope, {
        principalKind: "cli",
        principalId: "local",
        op: "policy_set",
        effect: "write",
        outcome: "ok",
        input: { key: "checks_mode", project: p!.slug, from, to: value },
      });
    });
    out.push({ project: p!.slug, from, to: value as ChecksMode });
  }
  return out;
}

export async function showChecksMode(
  db: Db,
  orgSlug: string,
): Promise<{ project: string; mode: ChecksMode }[]> {
  const org = await orgOf(db, orgSlug);
  const out: { project: string; mode: ChecksMode }[] = [];
  for (const p of await listProjects(db, { orgId: org.id })) {
    out.push({
      project: p.slug,
      mode: await getProjectChecksMode(db, { orgId: org.id, projectId: p.id }),
    });
  }
  return out;
}

/**
 * Sets how a project signs releases: the ref patterns that count as a release and the key to sign
 * with. Without --project, every project of the org. A key reference is `builtin:<name>`,
 * `aws-kms:<key id or ARN>` or `gcp-kms:<key version name>`.
 */
export async function setSigningPolicy(
  db: Db,
  orgSlug: string,
  projectSlug: string | undefined,
  patch: {
    releaseRefs?: string[] | undefined;
    signingKey?: string | undefined;
    environment?: string | undefined;
  },
): Promise<
  { project: string; releaseRefs: string[]; signingKey: string | null; environment: string }[]
> {
  const { parseKeyRef } = await import("../signing");
  if (patch.signingKey !== undefined && patch.signingKey !== "" && !parseKeyRef(patch.signingKey)) {
    throw new Error("--signing-key must be builtin:<name>, aws-kms:<key> or gcp-kms:<key version>");
  }
  if (
    patch.signingKey?.startsWith("builtin:") &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(patch.signingKey.slice(8))
  ) {
    throw new Error("a builtin key name is 1 to 64 letters, digits, dots, dashes or underscores");
  }
  if (patch.environment !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(patch.environment)) {
    throw new Error(
      "--signing-environment must be 1 to 64 letters, digits, dots, dashes or underscores",
    );
  }
  for (const r of patch.releaseRefs ?? []) {
    if (!/^refs\/(heads|tags)\/[A-Za-z0-9._/*-]{1,200}$/.test(r)) {
      throw new Error(`--release-refs entry ${r} must be a refs/heads/ or refs/tags/ pattern`);
    }
  }
  const org = await orgOf(db, orgSlug);
  const projects = projectSlug
    ? [await getProjectBySlug(db, { orgId: org.id }, projectSlug)]
    : await listProjects(db, { orgId: org.id });
  if (projects.length === 0 || projects.some((p) => p === undefined)) {
    throw new Error(
      projectSlug ? `no project ${projectSlug} in org ${orgSlug}` : "org has no projects",
    );
  }
  const out: {
    project: string;
    releaseRefs: string[];
    signingKey: string | null;
    environment: string;
  }[] = [];
  // A builtin key is looked up inside the org (its id is part of the stored name), so the same
  // `builtin:<name>` in two orgs is two keys. Any other reference (a KMS key) names one key
  // outside Turntable: an org may not name one that another org already does.
  if (
    patch.signingKey &&
    !patch.signingKey.startsWith("builtin:") &&
    (await signingKeyUsedByOtherOrg(db, org.id, patch.signingKey))
  ) {
    throw new Error("that signing key is already used by another org; a key belongs to one org");
  }
  for (const p of projects) {
    const scope = { orgId: org.id, projectId: p!.id };
    await db.transaction(async (tx) => {
      await setProjectSigning(tx, scope, {
        ...(patch.releaseRefs === undefined ? {} : { releaseRefs: patch.releaseRefs }),
        ...(patch.signingKey === undefined
          ? {}
          : { signingKey: patch.signingKey === "" ? null : patch.signingKey }),
        ...(patch.environment === undefined ? {} : { environment: patch.environment }),
      });
      await appendAudit(tx, scope, {
        principalKind: "cli",
        principalId: "local",
        op: "policy_set",
        effect: "write",
        outcome: "ok",
        input: {
          key: "signing",
          project: p!.slug,
          release_refs: patch.releaseRefs ?? null,
          signing_key: patch.signingKey ?? null,
          signing_environment: patch.environment ?? null,
        },
      });
    });
    out.push({ project: p!.slug, ...(await getProjectSigning(db, scope)) });
  }
  return out;
}

export async function showSigning(
  db: Db,
  orgSlug: string,
): Promise<
  { project: string; releaseRefs: string[]; signingKey: string | null; environment: string }[]
> {
  const org = await orgOf(db, orgSlug);
  const out: {
    project: string;
    releaseRefs: string[];
    signingKey: string | null;
    environment: string;
  }[] = [];
  for (const p of await listProjects(db, { orgId: org.id })) {
    out.push({
      project: p.slug,
      ...(await getProjectSigning(db, { orgId: org.id, projectId: p.id })),
    });
  }
  return out;
}

/**
 * Lets (or stops) release-class jobs restore caches that release-class jobs wrote. Off by
 * default: a release job restores nothing. Local only, like egress: no operation sets it.
 */
export async function setCacheReleaseRestorePolicy(
  db: Db,
  orgSlug: string,
  projectSlug: string | undefined,
  value: string,
): Promise<{ project: string; from: boolean; to: boolean }[]> {
  if (value !== "on" && value !== "off")
    throw new Error("--cache-release-restore must be on or off");
  const org = await orgOf(db, orgSlug);
  const projects = projectSlug
    ? [await getProjectBySlug(db, { orgId: org.id }, projectSlug)]
    : await listProjects(db, { orgId: org.id });
  if (projects.length === 0 || projects.some((p) => p === undefined)) {
    throw new Error(
      projectSlug ? `no project ${projectSlug} in org ${orgSlug}` : "org has no projects",
    );
  }
  const out: { project: string; from: boolean; to: boolean }[] = [];
  for (const p of projects) {
    const scope = { orgId: org.id, projectId: p!.id };
    const from = await getProjectCacheReleaseRestore(db, scope);
    await db.transaction(async (tx) => {
      await setProjectCacheReleaseRestore(tx, scope, value === "on");
      await appendAudit(tx, scope, {
        principalKind: "cli",
        principalId: "local",
        op: "policy_set",
        effect: "write",
        outcome: "ok",
        input: { key: "cache_release_restore", project: p!.slug, from, to: value === "on" },
      });
    });
    out.push({ project: p!.slug, from, to: value === "on" });
  }
  return out;
}

/**
 * Limits the audiences a project's jobs may ask the org's OIDC issuer for, or lifts the limit
 * (`any`). Audited like the other policy settings.
 */
export async function setOidcAudiencesPolicy(
  db: Db,
  orgSlug: string,
  projectSlug: string | undefined,
  value: string,
): Promise<{ project: string; from: string[] | null; to: string[] | null }[]> {
  const to =
    value.trim() === "any"
      ? null
      : [
          ...new Set(
            value
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean),
          ),
        ];
  if (to !== null) {
    if (to.length === 0 || to.length > 20)
      throw new Error("--oidc-audiences takes 1 to 20 values, or any");
    for (const a of to) {
      if (!validAudience(a)) {
        throw new Error(
          `not an audience (one printable string, no spaces, up to 256 characters): ${a}`,
        );
      }
    }
  }
  const org = await orgOf(db, orgSlug);
  const projects = projectSlug
    ? [await getProjectBySlug(db, { orgId: org.id }, projectSlug)]
    : await listProjects(db, { orgId: org.id });
  if (projects.length === 0 || projects.some((p) => p === undefined)) {
    throw new Error(
      projectSlug ? `no project ${projectSlug} in org ${orgSlug}` : "org has no projects",
    );
  }
  const out: { project: string; from: string[] | null; to: string[] | null }[] = [];
  for (const p of projects) {
    const scope = { orgId: org.id, projectId: p!.id };
    const from = await getProjectOidcAudiences(db, scope);
    await db.transaction(async (tx) => {
      await setProjectOidcAudiences(tx, scope, to);
      await appendAudit(tx, scope, {
        principalKind: "cli",
        principalId: "local",
        op: "policy_set",
        effect: "write",
        outcome: "ok",
        input: { key: "oidc_audiences", project: p!.slug, from, to },
      });
    });
    out.push({ project: p!.slug, from, to });
  }
  return out;
}

export async function showOidcAudiences(
  db: Db,
  orgSlug: string,
): Promise<{ project: string; audiences: string[] | null }[]> {
  const org = await orgOf(db, orgSlug);
  const out: { project: string; audiences: string[] | null }[] = [];
  for (const p of await listProjects(db, { orgId: org.id })) {
    out.push({
      project: p.slug,
      audiences: await getProjectOidcAudiences(db, { orgId: org.id, projectId: p.id }),
    });
  }
  return out;
}

/**
 * Sets the sandbox snapshot and/or the concurrency cap of one project (the instance operator's:
 * a tenant must not choose its own image or lift its own cap). `none` removes a setting. Audited
 * in the project's org chain. The cap can only lower the instance's per-org cap, which the
 * scheduler applies whatever is stored.
 */
export async function setSandboxPolicy(
  db: Db,
  orgSlug: string,
  projectSlug: string | undefined,
  opts: {
    sandboxSnapshot?: string | undefined;
    maxConcurrent?: string | undefined;
    untrustedRunApproval?: string | undefined;
  },
  /** The settings layers above the database: `turntable.toml` and the environment lock a value. */
  settings?: SettingsRuntime,
): Promise<{ project: string; from: ProjectSandboxSettings; to: ProjectSandboxSettings }> {
  if (!projectSlug)
    throw new Error(
      "--sandbox-snapshot, --max-concurrent and --untrusted-run-approval need --project",
    );
  const patch: Partial<ProjectSandboxSettings> = {};
  if (opts.sandboxSnapshot !== undefined) {
    if (opts.sandboxSnapshot !== "none" && !SNAPSHOT_NAME.test(opts.sandboxSnapshot))
      throw new Error(
        '--sandbox-snapshot is a snapshot name (letters, digits, . _ -, up to 128) or "none"',
      );
    patch.sandboxSnapshot = opts.sandboxSnapshot === "none" ? null : opts.sandboxSnapshot;
  }
  if (opts.maxConcurrent !== undefined) {
    if (opts.maxConcurrent !== "none" && !/^\d{1,15}$/.test(opts.maxConcurrent))
      throw new Error('--max-concurrent must be a whole number or "none"');
    patch.maxConcurrent = opts.maxConcurrent === "none" ? null : Number(opts.maxConcurrent);
  }
  if (opts.untrustedRunApproval !== undefined) {
    if (!(UNTRUSTED_RUN_APPROVALS as readonly string[]).includes(opts.untrustedRunApproval))
      throw new Error(`--untrusted-run-approval is one of: ${UNTRUSTED_RUN_APPROVALS.join(", ")}`);
    patch.untrustedRunApproval = opts.untrustedRunApproval as UntrustedRunApproval;
  }
  if (Object.keys(patch).length === 0)
    throw new Error("name --sandbox-snapshot, --max-concurrent or --untrusted-run-approval");
  const org = await orgOf(db, orgSlug);
  const project = await getProjectBySlug(db, { orgId: org.id }, projectSlug);
  if (!project) throw new Error(`no project ${projectSlug} in org ${orgSlug}`);
  const scope = { orgId: org.id, projectId: project.id };
  const rt = settings ?? createSettingsRuntime(settingsRegistry);
  const from = await getProjectSandboxSettings(db, scope);
  from.untrustedRunApproval = await effectiveApproval(rt, db, org.id, project.id);
  if (patch.untrustedRunApproval !== undefined) {
    // A thin alias of set_setting: the same lock and value refusals. The person at the host is
    // the operator, so no role applies, and the CLI is never MCP.
    try {
      await guardSettingChange(
        rt,
        db,
        untrustedRunApprovalSetting,
        { orgId: org.id, orgSlug: org.slug, projectId: project.id, projectSlug: project.slug },
        {},
        { value: patch.untrustedRunApproval },
      );
    } catch (err) {
      await appendAudit(db, scope, {
        principalKind: "cli",
        principalId: "local",
        op: "policy_set",
        effect: "write",
        outcome: "error:invalid_input",
        input: {
          key: "sandbox",
          project: project.slug,
          from,
          refused: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }
  }
  const to = await db.transaction(async (tx) => {
    const after = await setProjectSandboxSettings(tx, scope, patch);
    if (!after) throw new Error(`no project ${projectSlug} in org ${orgSlug}`);
    after.untrustedRunApproval = await effectiveApproval(rt, tx, org.id, project.id);
    await appendAudit(tx, scope, {
      principalKind: "cli",
      principalId: "local",
      op: "policy_set",
      effect: "write",
      outcome: "ok",
      input: { key: "sandbox", project: project.slug, from, to: after },
    });
    return after;
  });
  return { project: project.slug, from, to };
}

/** Each project's sandbox snapshot and cap, for `policy show`. */
export async function showSandbox(
  db: Db,
  orgSlug: string,
  settings?: SettingsRuntime,
): Promise<{ project: string; settings: ProjectSandboxSettings }[]> {
  const org = await orgOf(db, orgSlug);
  const out: { project: string; settings: ProjectSandboxSettings }[] = [];
  for (const p of await listProjects(db, { orgId: org.id })) {
    const s = await getProjectSandboxSettings(db, { orgId: org.id, projectId: p.id });
    s.untrustedRunApproval = await effectiveApproval(settings, db, org.id, p.id);
    out.push({ project: p.slug, settings: s });
  }
  return out;
}
