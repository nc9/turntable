// The settings registry's operations (#321): read the effective value of a setting with its source
// and lock, and set the database layer. Two sets with one implementation, because instance ops and
// org ops never meet (see dispatch.ts): `get_setting`, `list_settings` and `set_setting` serve the
// org and project settings to org tokens and members, and the `instance_` three serve the instance
// settings to the instance administrator. A value set in the environment or in `turntable.toml`
// is locked: the set refuses and says where it was set. Secrets are never settings.
import { z } from "zod";
import { SYSTEM_ORG_SLUG } from "../../audit/failures";
import { getOrgById, getOrgBySlug, getProject, getProjectBySlug } from "../../db/repos";
import { getStoredSetting, lockSettingKey, putStoredSetting } from "../../db/repos/settings";
import type { SettingScope } from "../../db/schema";
import type { SettingDef } from "../../settings/define";
import { settingsRegistry } from "../../settings/definitions";
import {
  createSettingsRuntime,
  type Resolved,
  resolveSetting,
  type SettingSubject,
  storeTarget,
} from "../../settings/resolve";
import { defineOp, type OpContext } from "../define";
import { guardSettingChange } from "../setting-guard";
import { recordSettingChange } from "../setting-audit";
import { OpError } from "../errors";
import { invalidateSandboxLimits } from "../../scheduler/live-limits";

const settingView = z.object({
  key: z.string(),
  scope: z.enum(["instance", "org", "project"]),
  description: z.string(),
  value: z.unknown(),
  default: z.unknown(),
  source: z.enum(["env", "toml", "db", "default"]).describe("Which layer the value comes from."),
  locked: z
    .boolean()
    .describe("True when the environment or turntable.toml sets it: it cannot be changed here."),
  locked_by: z.string().nullable().describe("For a locked value, the variable or file."),
  role: z.string().describe("The least role that may change it."),
  mcp_editable: z.boolean(),
  strictness: z
    .array(z.string())
    .nullable()
    .describe(
      "For a setting that may only be tightened by its role: the values from least to most strict. Null otherwise.",
    ),
  warning: z
    .string()
    .nullable()
    .describe(
      "What is at risk in changing it, for a setting whose change can weaken a protection.",
    ),
  trust: z
    .enum(["tighten_only"])
    .nullable()
    .describe(
      "`tighten_only` for a trust setting: the instance administrator may only tighten it, and a web session loosens it only with a fresh passkey step-up. Null otherwise.",
    ),
});
type SettingView = z.infer<typeof settingView>;

/** Times a set re-checks after losing a race to another writer. */
const SET_ATTEMPTS = 3;

const runtimeOf = (ctx: OpContext) => ctx.settings ?? createSettingsRuntime(settingsRegistry);

function view(def: SettingDef, r: Resolved, showFile: boolean): SettingView {
  return {
    key: def.key,
    scope: def.scope,
    description: def.description,
    value: r.value,
    default: def.default,
    source: r.source,
    locked: r.locked,
    // The variable name is public documentation; a file path is the host's business.
    locked_by: !r.locked
      ? null
      : r.source === "env" || showFile
        ? (r.origin ?? r.source)
        : r.source,
    // With a strictness order the role is the least that may tighten; loosening is the instance's.
    role: def.instanceAdminOnly && !def.strictness ? "instance_admin" : def.role,
    mcp_editable: def.mcpEditable,
    strictness: def.strictness ? [...def.strictness] : null,
    warning: def.warning ?? null,
    trust: def.trust ?? null,
  };
}

/** The org and project a setting is about, from the caller's resolved scope. */
async function subjectOf(ctx: OpContext, def: SettingDef): Promise<SettingSubject> {
  if (def.scope === "instance") return {};
  const org = await getOrgById(ctx.db, ctx.scope.orgId);
  if (!org || org.slug === SYSTEM_ORG_SLUG) throw new OpError("not_found", "no such org");
  if (def.scope === "org") return { orgId: org.id, orgSlug: org.slug };
  if (!ctx.scope.projectId) {
    throw new OpError("invalid_input", `${def.key} is a project setting: a project is required`);
  }
  const project = await getProject(ctx.db, { orgId: org.id }, ctx.scope.projectId);
  if (!project) throw new OpError("not_found", "no such project");
  return { orgId: org.id, orgSlug: org.slug, projectId: project.id, projectSlug: project.slug };
}

/** The org or project an instance administrator names for an org or project setting. */
async function targetSubject(
  ctx: OpContext,
  def: SettingDef,
  t: { org: string; project?: string | undefined },
): Promise<SettingSubject> {
  const org = await getOrgBySlug(ctx.db, t.org);
  if (!org || org.slug === SYSTEM_ORG_SLUG) throw new OpError("not_found", "no such org");
  if (def.scope === "org") return { orgId: org.id, orgSlug: org.slug };
  if (!t.project) {
    throw new OpError(
      "invalid_input",
      `${def.key} is a project setting: target_project is required`,
    );
  }
  const project = await getProjectBySlug(ctx.db, { orgId: org.id }, t.project);
  if (!project) throw new OpError("not_found", "no such project");
  return { orgId: org.id, orgSlug: org.slug, projectId: project.id, projectSlug: project.slug };
}

function lookup(ctx: OpContext, key: string, scopes: readonly SettingScope[]): SettingDef {
  const def = runtimeOf(ctx).registry.get(key);
  if (!def) throw new OpError("not_found", `no such setting: ${key}`);
  if (!scopes.includes(def.scope)) {
    throw new OpError(
      "not_found",
      def.scope === "instance"
        ? `${key} is an instance setting: use the instance_ operations`
        : `${key} is an ${def.scope} setting: use the org operations`,
    );
  }
  return def;
}

async function read(
  ctx: OpContext,
  def: SettingDef,
  showFile: boolean,
  target?: { org: string; project?: string | undefined },
): Promise<SettingView> {
  const subject = target ? await targetSubject(ctx, def, target) : await subjectOf(ctx, def);
  return view(def, await resolveSetting(runtimeOf(ctx), ctx.db, def.key, subject), showFile);
}

/** Sets one setting through the registry's own path: lock, role, MCP and value refusals, audit. */
export async function setSetting(
  ctx: OpContext,
  def: SettingDef,
  i: { value?: unknown; unset?: boolean | undefined },
  showFile: boolean,
  target?: { org: string; project?: string | undefined },
): Promise<SettingView> {
  const rt = runtimeOf(ctx);
  const subject = target ? await targetSubject(ctx, def, target) : await subjectOf(ctx, def);
  // Check and write against the row as read: an org tighten and an instance-administrator write
  // take different locks, so a write the guard allowed against an older value could otherwise land
  // after a stricter one and loosen it. The write is a compare-and-set; if the row moved, the
  // guard runs again on the new value (and may now refuse). The write, its audit rows and any
  // event commit together: a loosened policy is never stored without the trail.
  const after = await ctx.db.transaction(async (tx) => {
    // One lock per (org, key) for every scope that feeds the effective value, taken before the
    // first read, so a write at another scope cannot land between the guard's read and the write.
    if (subject.orgId && (def.strictness || def.instanceAdminOnly || def.trust)) {
      await lockSettingKey(tx, subject.orgId, def.key);
    }
    for (let attempt = 0; ; attempt++) {
      if (attempt === SET_ATTEMPTS) {
        throw new OpError("conflict", `${def.key} was changed by someone else; try again`);
      }
      const store = storeTarget(def, subject);
      const stored = await getStoredSetting(tx, store, def.key);
      const { before, next } = await guardSettingChange(
        rt,
        tx,
        def,
        subject,
        {
          principal: ctx.principal,
          viaMcp: ctx.viaMcp,
          stepUpVerified: ctx.stepUp?.action === "set_setting",
        },
        i,
      );
      const written = await putStoredSetting(
        tx,
        store,
        def.key,
        next,
        ctx.principal.id,
        ctx.now(),
        { raw: stored?.raw },
      );
      if (!written) continue;
      const resolved = await resolveSetting(rt, tx, def.key, subject);
      // The old and new effective values, in the chain of the scope it changed. Never a secret: no
      // setting can be one. An instance administrator changing a tenant's setting: the tenant's
      // own chain shows it too.
      await recordSettingChange(tx, {
        def,
        orgId: subject.orgId,
        chains: [
          ctx.scope,
          ...(target && subject.orgId
            ? [
                {
                  orgId: subject.orgId,
                  ...(subject.projectId ? { projectId: subject.projectId } : {}),
                },
              ]
            : []),
        ],
        principalKind: ctx.principal.kind,
        principalId: ctx.principal.id,
        from: before.value,
        to: resolved.value,
        source: resolved.source,
      });
      return resolved;
    }
  });
  // The caps and provider limits are cached for the claim loop: a change shows on its next claim.
  invalidateSandboxLimits();
  return view(def, after, showFile);
}

const keyInput = z.object({ key: z.string().min(1).max(64).describe("The setting's key.") });
const setInput = keyInput.extend({
  value: z.unknown().optional().describe("The new value, of the type `list_settings` shows."),
  unset: z
    .boolean()
    .optional()
    .describe("True to remove the stored value, so the default applies again."),
});

const ORG_SCOPES = ["org", "project"] as const;

export const getSettingOp = defineOp({
  name: "get_setting",
  summary: "One org or project setting: effective value, source and lock.",
  description:
    "Returns the effective value of one org or project setting, which layer it comes from " +
    "(`env`, `toml`, `db` or `default`) and whether it is locked. A locked value is set by the " +
    "instance's environment or config file and cannot be changed here. A project setting needs " +
    "the project. Read-only.",
  input: keyInput,
  output: settingView,
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/settings/{key}" },
  async handler(ctx, i) {
    return read(ctx, lookup(ctx, i.key, ORG_SCOPES), false);
  },
});

export const listSettingsOp = defineOp({
  name: "list_settings",
  summary: "Every org setting (and project setting, with a project) with source and lock.",
  description:
    "Lists the org settings, and the project settings when a project is given or the token is " +
    "scoped to one. Each has its effective value, default, source (`env`, `toml`, `db` or " +
    "`default`), lock, the role that may change it and whether MCP may. Read-only.",
  input: z.object({
    limit: z.int().min(1).max(100).optional().describe("Most settings to return. Default 50."),
    cursor: z.string().max(64).optional().describe("`next_cursor` of the previous page."),
  }),
  output: z.object({ settings: z.array(settingView), next_cursor: z.string().nullable() }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/settings" },
  async handler(ctx, i) {
    const all = runtimeOf(ctx)
      .registry.settings.filter(
        (d) => d.scope === "org" || (d.scope === "project" && ctx.scope.projectId !== undefined),
      )
      .toSorted((x, y) => x.key.localeCompare(y.key));
    // The cursor is the last key of the previous page: the list is in key order.
    const after = i.cursor === undefined ? all : all.filter((d) => d.key > i.cursor!);
    const limit = i.limit ?? 50;
    const page = after.slice(0, limit);
    return {
      settings: await Promise.all(page.map((d) => read(ctx, d, false))),
      next_cursor: after.length > limit ? page.at(-1)!.key : null,
    };
  },
});

export const setSettingOp = defineOp({
  name: "set_setting",
  summary: "Set an org or project setting (database layer).",
  description:
    "Sets, or with `unset` removes, the stored value of one org or project setting. It is " +
    "refused when the setting is locked (the environment or turntable.toml sets it; the error " +
    "says which), when your role is below the setting's own, and over MCP for a setting that " +
    "raises a limit or widens what runs may do (`mcp_editable` is false in `list_settings`). " +
    "A setting with a `strictness` order may be tightened by its role but only loosened by the " +
    "instance administrator, and unsetting counts as setting the default. " +
    "A setting marked `trust: tighten_only` (`list_settings` shows it) may only be tightened by a " +
    "token; an owner's web session loosens it with a fresh passkey step-up (`step_up_required` " +
    "without one). The old and new values are audited. Returns the setting as `get_setting` does.",
  roleNote:
    "Requires role operator, and the setting's own role (shown by `list_settings`); a few " +
    "settings need a role only people hold.",
  input: setInput,
  output: settingView,
  effect: "write",
  auth: { type: "token", minRole: "operator" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/settings" },
  async handler(ctx, i) {
    return setSetting(ctx, lookup(ctx, i.key, ORG_SCOPES), i, false);
  },
});

const targetFields = {
  target_org: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("Slug of the org, for an org or project setting."),
  target_project: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("Slug of the project, for a project setting."),
};
const instanceKeyInput = keyInput.extend(targetFields);
const instanceSetInput = setInput.extend(targetFields);

/** The org or project an instance call names for a setting that is not an instance one. */
function targetOf(
  def: SettingDef,
  i: { target_org?: string | undefined; target_project?: string | undefined },
): { org: string; project?: string | undefined } | undefined {
  if (def.scope === "instance") return undefined;
  if (!i.target_org) {
    throw new OpError(
      "invalid_input",
      `${def.key} is an ${def.scope} setting: target_org is required`,
    );
  }
  return { org: i.target_org, project: i.target_project };
}

export const instanceGetSettingOp = defineOp({
  name: "instance_get_setting",
  summary: "One instance setting: effective value, source and lock.",
  description:
    "Returns the effective value of one instance setting, or with `target_org` (and " +
    "`target_project` for a project setting) of that tenant's org or project setting, which layer it comes from (`env`, " +
    "`toml`, `db` or `default`) and, for a locked one, the variable or file that sets it. " +
    "Only the instance administrator can call it. Not an MCP tool: instance settings are the " +
    "operator's. Read-only.",
  input: instanceKeyInput,
  output: settingView,
  effect: "read",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/instance/settings/{key}" },
  mcp: false,
  async handler(ctx, i) {
    const def = lookup(ctx, i.key, ["instance", ...ORG_SCOPES]);
    return read(ctx, def, true, targetOf(def, i));
  },
});

export const instanceListSettingsOp = defineOp({
  name: "instance_list_settings",
  summary: "Every instance setting with source and lock.",
  description:
    "Lists the instance settings (and, with `target_org`, that org's org settings, and with " +
    "`target_project` the project's) with their effective value, default, source (`env`, `toml`, " +
    "`db` or `default`) and lock. Only the instance administrator can call it. Not an MCP " +
    "tool: instance settings are the operator's. Read-only.",
  input: z.object({
    target_org: targetFields.target_org.describe(
      "Also list this org's org settings (and the project's, with `target_project`).",
    ),
    target_project: targetFields.target_project.describe(
      "With `target_org`: also list this project's project settings.",
    ),
  }),
  output: z.object({ settings: z.array(settingView) }),
  effect: "read",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/instance/settings" },
  mcp: false,
  async handler(ctx, i) {
    const reg = runtimeOf(ctx).registry;
    const target = i.target_org ? { org: i.target_org, project: i.target_project } : undefined;
    if (i.target_project && !i.target_org) {
      throw new OpError("invalid_input", "target_project needs target_org");
    }
    const defs = [
      ...reg.byScope("instance"),
      ...(target ? reg.byScope("org") : []),
      ...(target?.project ? reg.byScope("project") : []),
    ];
    return {
      settings: await Promise.all(
        defs.map((d) => read(ctx, d, true, d.scope === "instance" ? undefined : target)),
      ),
    };
  },
});

export const instanceSetSettingOp = defineOp({
  name: "instance_set_setting",
  summary: "Set an instance setting (database layer, instance administrator only).",
  description:
    "Sets, or with `unset` removes, the stored value of one instance setting. Refused when " +
    "the environment or turntable.toml sets it (the error says which): change it there. The " +
    "old and new values are audited in the system org's chain. Only the instance administrator " +
    "can call it. Not an MCP tool: instance settings are the operator's, and a value in an " +
    "agent's context is not an operator's decision. Any org or project setting is set here " +
    "with `target_org` and, for a project setting, `target_project`; the change is audited in " +
    "the system org's chain and the target org's, with the old and new values. A setting marked " +
    "`trust: tighten_only` (such as `untrusted_run_approval`) may be tightened but not loosened " +
    "here (`trust_loosening_needs_owner`): only the org's owner loosens it. The environment and " +
    "turntable.toml locks still apply.",
  input: instanceSetInput,
  output: settingView,
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/settings" },
  mcp: false,
  async handler(ctx, i) {
    const def = lookup(ctx, i.key, ["instance", ...ORG_SCOPES]);
    return setSetting(ctx, def, i, true, targetOf(def, i));
  },
});
