// `longshore policy`: per-org settings that change what agents may do. Local access to the data
// directory is the trust root (like `longshore token`), so this writes through the repos directly
// and audits the change.
import type { Db } from "../db";
import {
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
  getProjectEgress,
  listProjects,
  setApproveRunMinRole,
  setProjectEgress,
} from "../db/repos";

export const POLICY_USAGE = `Usage:
  longshore policy show --org <slug> [--data-dir ./data]
  longshore policy set approve-run-min-role <operator|release_operator> --org <slug> [--data-dir ./data]
  longshore policy set --checks-mode <off|shadow|live> --org <slug> [--project <slug>] [--data-dir ./data]
  longshore policy set --egress <none|open|allowlist> --org <slug> [--project <slug>] [--data-dir ./data]

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
