// The settings registry's operations (#321): read the effective value of a setting with its source
// and lock, and set the database layer. Two sets with one implementation, because instance ops and
// org ops never meet (see dispatch.ts): `get_setting`, `list_settings` and `set_setting` serve the
// org and project settings to org tokens and members, and the `instance_` three serve the instance
// settings to the instance administrator. A value set in the environment or in `turntable.toml`
// is locked: the set refuses and says where it was set. Secrets are never settings.
import { z } from "zod";
import { SYSTEM_ORG_SLUG } from "../../audit/failures";
import { appendAudit, getOrgById, getProject } from "../../db/repos";
import { putStoredSetting } from "../../db/repos/settings";
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
import { OpError } from "../errors";
import { orgRole } from "../principal";
import { roleSatisfies } from "../roles";

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
});
type SettingView = z.infer<typeof settingView>;

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
    role: def.role,
    mcp_editable: def.mcpEditable,
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

async function read(ctx: OpContext, def: SettingDef, showFile: boolean): Promise<SettingView> {
  const subject = await subjectOf(ctx, def);
  return view(def, await resolveSetting(runtimeOf(ctx), ctx.db, def.key, subject), showFile);
}

async function setSetting(
  ctx: OpContext,
  def: SettingDef,
  i: { value?: unknown; unset?: boolean | undefined },
  showFile: boolean,
): Promise<SettingView> {
  // Who: the setting's own role, on top of the op's. An instance setting's caller is the
  // instance administrator by construction.
  if (def.scope !== "instance" && !roleSatisfies(orgRole(ctx.principal), def.role as never)) {
    throw new OpError("forbidden", `changing ${def.key} requires role ${def.role}`);
  }
  if (ctx.viaMcp && !def.mcpEditable) {
    throw new OpError(
      "forbidden",
      `${def.key} cannot be changed over MCP: ${def.mcpReason ?? "a human changes it"}`,
    );
  }
  const unset = i.unset === true;
  if (unset === (i.value !== undefined)) {
    throw new OpError("invalid_input", "give either a value to set or unset: true, not both");
  }
  const rt = runtimeOf(ctx);
  const subject = await subjectOf(ctx, def);
  const before = await resolveSetting(rt, ctx.db, def.key, subject);
  if (before.locked) {
    throw new OpError(
      "conflict",
      `${def.key} is locked: it is set by ${
        before.source === "env" ? `the environment (${before.origin})` : "turntable.toml"
      }; change it there`,
    );
  }
  let next: unknown;
  if (!unset) {
    const parsed = def.type.safeParse(i.value);
    if (!parsed.success) {
      throw new OpError(
        "invalid_input",
        `${def.key}: ${parsed.error.issues.map((x) => x.message).join("; ")}`,
      );
    }
    next = parsed.data;
  }
  await putStoredSetting(
    ctx.db,
    storeTarget(def, subject),
    def.key,
    next,
    ctx.principal.id,
    ctx.now(),
  );
  const after = await resolveSetting(rt, ctx.db, def.key, subject);
  // The old and new effective values, in the chain of the scope it changed. Never a secret: no
  // setting can be one.
  await appendAudit(ctx.db, ctx.scope, {
    principalKind: ctx.principal.kind,
    principalId: ctx.principal.id,
    op: "setting_changed",
    effect: "write",
    outcome: "ok",
    input: { key: def.key, from: before.value, to: after.value, source: after.source },
  });
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
    "The old and new values are audited. Returns the setting as `get_setting` does.",
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

export const instanceGetSettingOp = defineOp({
  name: "instance_get_setting",
  summary: "One instance setting: effective value, source and lock.",
  description:
    "Returns the effective value of one instance setting, which layer it comes from (`env`, " +
    "`toml`, `db` or `default`) and, for a locked one, the variable or file that sets it. " +
    "Only the instance administrator can call it. Not an MCP tool: instance settings are the " +
    "operator's. Read-only.",
  input: keyInput,
  output: settingView,
  effect: "read",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/instance/settings/{key}" },
  mcp: false,
  async handler(ctx, i) {
    return read(ctx, lookup(ctx, i.key, ["instance"]), true);
  },
});

export const instanceListSettingsOp = defineOp({
  name: "instance_list_settings",
  summary: "Every instance setting with source and lock.",
  description:
    "Lists the instance settings with their effective value, default, source (`env`, `toml`, " +
    "`db` or `default`) and lock. Only the instance administrator can call it. Not an MCP " +
    "tool: instance settings are the operator's. Read-only.",
  input: z.object({}),
  output: z.object({ settings: z.array(settingView) }),
  effect: "read",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/instance/settings" },
  mcp: false,
  async handler(ctx) {
    const defs = runtimeOf(ctx).registry.byScope("instance");
    return { settings: await Promise.all(defs.map((d) => read(ctx, d, true))) };
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
    "agent's context is not an operator's decision.",
  input: setInput,
  output: settingView,
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/settings" },
  mcp: false,
  async handler(ctx, i) {
    return setSetting(ctx, lookup(ctx, i.key, ["instance"]), i, true);
  },
});
