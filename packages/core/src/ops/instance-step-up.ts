// What an instance step-up binds (#541). The instance administrator is a token, not a person, so
// a sensitive instance op (release lane configuration) needs a fresh passkey assertion from an
// approver enrolled in the org the call names, bound to the token, the op and the exact input.
//
// The input hash covers every field. A secret value is the one exception: it is bound by its own
// digest (`<field>_sha256`), so the approver's device, which is shown only the challenge, never
// sees it, and a step-up for one value cannot authorise another.
import { createHash } from "node:crypto";
import { SYSTEM_ORG_SLUG } from "../audit/failures";
import type { Db } from "../db";
import { getOrgBySlug, getProjectBySlug } from "../db/repos";
import { OpError } from "./errors";
import { inputTarget } from "./step-up";

const NO_SUCH = "org or project not found";

/**
 * The digest of a secret input value that stands for it in a step-up. Clients compute the same:
 * `sha256("turntable.step_up.secret.v1\0" + field + "\0" + value)` in hex.
 */
export function secretDigest(field: string, value: string): string {
  return createHash("sha256")
    .update(`turntable.step_up.secret.v1\0${field}\0${value}`, "utf8")
    .digest("hex");
}

/**
 * The input a step-up binds: the validated input with each secret field replaced by its digest
 * under `<field>_sha256`.
 */
export function boundInput(
  input: Record<string, unknown>,
  secretFields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const f of secretFields) {
    if (typeof out[f] === "string") {
      out[`${f}_sha256`] = secretDigest(f, out[f]);
      delete out[f];
    }
  }
  return out;
}

/**
 * Resolves the org and project an instance lane op names (`target_org`, `target_project`) the way
 * every layer must: the project is looked up INSIDE the org, so a mismatched pair is not found,
 * and the system org is never a target.
 */
export async function resolveLaneTarget(
  db: Db,
  input: Record<string, unknown>,
): Promise<{ orgId: string; projectId: string }> {
  const orgSlug = input.target_org;
  const projectSlug = input.target_project;
  if (typeof orgSlug !== "string" || typeof projectSlug !== "string") {
    throw new OpError("invalid_input", "target_org and target_project are required");
  }
  const org = orgSlug === SYSTEM_ORG_SLUG ? undefined : await getOrgBySlug(db, orgSlug);
  if (!org) throw new OpError("not_found", NO_SUCH);
  const project = await getProjectBySlug(db, { orgId: org.id }, projectSlug);
  if (!project) throw new OpError("not_found", NO_SUCH);
  return { orgId: org.id, projectId: project.id };
}

/** Resolves the org an org-level instance op names (`target_org`); the system org is never a target. */
export async function resolveLaneOrg(
  db: Db,
  input: Record<string, unknown>,
): Promise<{ orgId: string }> {
  const slug = input.target_org;
  if (typeof slug !== "string") throw new OpError("invalid_input", "target_org is required");
  const org = slug === SYSTEM_ORG_SLUG ? undefined : await getOrgBySlug(db, slug);
  if (!org) throw new OpError("not_found", "org not found");
  return { orgId: org.id };
}

/**
 * The target a step-up for this call binds (see `inputTarget`), and the org that must sign it.
 * An org-level op (a signing key) has no project: its target binds the input alone.
 */
export async function instanceStepUpTarget(
  db: Db,
  input: Record<string, unknown>,
  secretFields: readonly string[],
  orgLevel = false,
): Promise<{ orgId: string; projectId: string | undefined; target: string }> {
  if (orgLevel) {
    const { orgId } = await resolveLaneOrg(db, input);
    return {
      orgId,
      projectId: undefined,
      target: inputTarget(boundInput(input, secretFields), undefined),
    };
  }
  const { orgId, projectId } = await resolveLaneTarget(db, input);
  return { orgId, projectId, target: inputTarget(boundInput(input, secretFields), projectId) };
}
