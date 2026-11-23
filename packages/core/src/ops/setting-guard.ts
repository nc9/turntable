// The refusals every path that changes a setting shares (#321): `set_setting`, and the ops and
// CLI commands that alias a setting (`set_project_settings`, `turntable policy set`). One place,
// so an alias can never be looser than the registry's own op.
import type { Db } from "../db";
import { getOrgById, getProject } from "../db/repos";
import type { UntrustedRunApproval } from "../db/schema";
import { settingsRegistry } from "../settings/definitions";
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
  return { before, next: parsed.data };
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
