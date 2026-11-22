// `longshore policy`: per-org settings that change what agents may do. Local access to the data
// directory is the trust root (like `longshore token`), so this writes through the repos directly
// and audits the change.
import type { Db } from "../db";
import {
  APPROVE_RUN_ROLES,
  appendAudit,
  type ApproveRunRole,
  getApproveRunMinRole,
  getOrgBySlug,
  setApproveRunMinRole,
} from "../db/repos";

export const POLICY_USAGE = `Usage:
  longshore policy show --org <slug> [--data-dir ./data]
  longshore policy set approve-run-min-role <operator|release_operator> --org <slug> [--data-dir ./data]

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
