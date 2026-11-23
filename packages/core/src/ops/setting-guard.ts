// The refusals every path that changes a setting shares (#321): `set_setting`, and the ops and
// CLI commands that alias a setting (`set_project_settings`, `turntable policy set`). One place,
// so an alias can never be looser than the registry's own op.
import type { Db } from "../db";
import { allProjectRefs, getKeyPolicy, getOrgById, getProject, listApprovers } from "../db/repos";
import { notCountingReason } from "../approvals/identity";
import { keyPolicyViolation } from "../approvals/key-policy";
import type { UntrustedRunApproval } from "../db/schema";
import { settingsRegistry, untrustedRunApprovalSetting } from "../settings/definitions";
import type { SettingDef } from "../settings/define";
import { type Resolved, resolveSetting, type SettingSubject } from "../settings/resolve";
import { createSettingsRuntime, type SettingsRuntime } from "../settings/resolve";
import { OpError } from "./errors";
import type { Principal } from "./principal";
import { roleSatisfies } from "./roles";

export type SettingCaller = {
  /** Absent for a person at the host (the CLI), who is the operator. */
  principal?: Principal | undefined;
  viaMcp?: boolean | undefined;
};

/**
 * Checks a change and returns the value to store (undefined for an unset) with the effective
 * value before. Refusals, most specific reason first, on every transport: a lock (a TOML value on
 * a setting MCP may not edit is still a lock), then who, then MCP, then the value. The subject
 * comes from the caller's own org, never from input.
 */
export async function guardSettingChange(
  rt: SettingsRuntime,
  db: Db,
  def: SettingDef,
  subject: SettingSubject,
  caller: SettingCaller,
  i: { value?: unknown; unset?: boolean | undefined },
): Promise<{ before: Resolved; next: unknown }> {
  const before = await resolveSetting(rt, db, def.key, subject);
  if (before.locked) {
    throw new OpError(
      "conflict",
      `${def.key} is locked: it is set by ${
        before.source === "env" ? `the environment (${before.origin})` : "turntable.toml"
      }; change it there`,
    );
  }
  const p = caller.principal;
  // An org principal on a setting with a strictness order may still tighten it: the value check
  // below refuses loosening, after the role and MCP refusals.
  const oneWay = def.instanceAdminOnly === true && def.strictness !== undefined;
  if (p && p.kind !== "instance") {
    if (def.instanceAdminOnly && !def.strictness) {
      throw new OpError("forbidden", `only the instance administrator can change ${def.key}`);
    }
    if (def.scope !== "instance" && !roleSatisfies(p.role, def.role as never)) {
      throw new OpError("forbidden", `changing ${def.key} requires role ${def.role}`);
    }
  }
  if (caller.viaMcp && !def.mcpEditable) {
    throw new OpError(
      "forbidden",
      `${def.key} cannot be changed over MCP: ${def.mcpReason ?? "a human changes it"}`,
    );
  }
  const unset = i.unset === true;
  if (unset === (i.value !== undefined)) {
    throw new OpError("invalid_input", "give either a value to set or unset: true, not both");
  }
  if (unset) {
    if (oneWay && p && p.kind !== "instance") refuseLoosening(def, before, def.default);
    return { before, next: undefined };
  }
  const parsed = def.type.safeParse(i.value);
  if (!parsed.success) {
    throw new OpError(
      "invalid_input",
      `${def.key}: ${parsed.error.issues.map((x) => x.message).join("; ")}`,
    );
  }
  const refused = def.refuse?.(parsed.data);
  if (refused) throw new OpError("invalid_input", refused);
  if (oneWay && p && p.kind !== "instance") refuseLoosening(def, before, parsed.data);
  if (def.key === untrustedRunApprovalSetting.key && parsed.data === "human") {
    await requireApprover(db, subject.orgId);
  }
  return { before, next: parsed.data };
}

/**
 * Whether an org has an active approver that counts: not revoked, tied to a forge login, and its
 * key satisfying the org key policy. `human` approval can only be satisfied by such a key.
 */
export async function hasQualifyingApprover(db: Db, orgId: string): Promise<boolean> {
  const policy = await getKeyPolicy(db, orgId);
  const active = await listApprovers(db, orgId);
  return active.some(
    (a) => notCountingReason(a) === null && keyPolicyViolation(policy, a) === null,
  );
}

/** Message of the refusal; fixed, so it names no key, person or org. */
export const HUMAN_REQUIRES_APPROVER =
  "human_requires_approver: untrusted_run_approval=human needs the org to have an active approver " +
  "whose key satisfies the org key policy; enrol one first (turntable approvals bootstrap)";

async function requireApprover(db: Db, orgId: string | undefined): Promise<void> {
  if (orgId && (await hasQualifyingApprover(db, orgId))) return;
  throw new OpError("conflict", HUMAN_REQUIRES_APPROVER, { reason: "human_requires_approver" });
}

/**
 * Refuses a value less strict than the effective one. `before` is read in the caller's write
 * transaction. A current value the order does not list ranks as the strictest, so it fails closed.
 */
function refuseLoosening(def: SettingDef, before: Resolved, next: unknown): void {
  const order = def.strictness!;
  const rank = (v: unknown): number => {
    const i = order.indexOf(v as string);
    return i < 0 ? order.length : i;
  };
  if (rank(next) < rank(before.value)) {
    throw new OpError(
      "forbidden",
      `only the instance administrator can loosen ${def.key} (current: ${String(before.value)})`,
    );
  }
}

/** The slugs a project's `turntable.toml` section is keyed by, from its ids. */
export async function projectSubject(
  db: Db,
  orgId: string,
  projectId: string,
): Promise<SettingSubject> {
  const org = await getOrgById(db, orgId);
  const project = await getProject(db, { orgId }, projectId);
  return {
    orgId,
    projectId,
    ...(org ? { orgSlug: org.slug } : {}),
    ...(project ? { projectSlug: project.slug } : {}),
  };
}

/**
 * The effective `untrusted_run_approval` of one project: environment, `turntable.toml`, the
 * stored value, then the default. A value that is not a known policy reads as `human` (fail
 * closed), though the resolver already refuses to use one.
 */
export async function effectiveApproval(
  rt: SettingsRuntime | undefined,
  db: Db,
  orgId: string,
  projectId: string,
): Promise<UntrustedRunApproval> {
  const r = await resolveSetting(
    rt ?? createSettingsRuntime(settingsRegistry),
    db,
    "untrusted_run_approval",
    await projectSubject(db, orgId, projectId),
  );
  return r.value as UntrustedRunApproval;
}

/**
 * How many projects resolve to `human` while their org's key policy is `any`: an ed25519 key file
 * on a machine where agents run lets an agent sign a statement, so `human` assumes `hardware`.
 */
export async function countHumanWithAnyKeyPolicy(
  rt: SettingsRuntime | undefined,
  db: Db,
): Promise<number> {
  const anyPolicy = new Map<string, boolean>();
  let n = 0;
  for (const p of await allProjectRefs(db)) {
    if ((await effectiveApproval(rt, db, p.orgId, p.id)) !== "human") continue;
    let any = anyPolicy.get(p.orgId);
    if (any === undefined) {
      any = (await getKeyPolicy(db, p.orgId)).mode === "any";
      anyPolicy.set(p.orgId, any);
    }
    if (any) n += 1;
  }
  return n;
}

/**
 * How many projects resolve to `human` while their org has no approver that counts (revoked
 * since, or the key policy tightened). A value from `turntable.toml` or the environment is not
 * refused at boot, so this is where it shows.
 */
export async function countHumanWithoutApprover(
  rt: SettingsRuntime | undefined,
  db: Db,
): Promise<number> {
  const covered = new Map<string, boolean>();
  let n = 0;
  for (const p of await allProjectRefs(db)) {
    if ((await effectiveApproval(rt, db, p.orgId, p.id)) !== "human") continue;
    let ok = covered.get(p.orgId);
    if (ok === undefined) {
      ok = await hasQualifyingApprover(db, p.orgId);
      covered.set(p.orgId, ok);
    }
    if (!ok) n += 1;
  }
  return n;
}
