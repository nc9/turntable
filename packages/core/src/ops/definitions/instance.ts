// Instance-level operations (#205). They belong to the instance administrator, not to any org: the
// caller is an `lsi_` token minted on the host, and only such a token can call them over REST. No
// org token of any role can, whatever its grant, and none of these is an MCP tool. Their audit
// entries go to the system org's chain.
import { z } from "zod";
import {
  appendAudit,
  getInstanceToken,
  getOrgBySlug,
  listAllOrgs,
  setOrgQuotas,
} from "../../db/repos";
import { SYSTEM_ORG_SLUG } from "../../audit/failures";
import { defineOp } from "../define";
import { OpError } from "../errors";
import { quotaView, quotaViewSchema } from "./quotas";

const iso = (ms: number | null | undefined): string | null =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString();

export const instanceWhoami = defineOp({
  name: "instance_whoami",
  summary: "Who the instance administrator token is.",
  description:
    "Returns the id and label of the instance token in use and when it expires. Use it to check " +
    "that an `lsi_` token works. Only the instance administrator can call it. Read-only.",
  input: z.object({}),
  output: z.object({
    id: z.string(),
    name: z.string(),
    expires_at: z.string().nullable(),
  }),
  effect: "read",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/instance/whoami" },
  mcp: false,
  async handler(ctx) {
    const row = await getInstanceToken(ctx.db, ctx.principal.id);
    if (!row) throw new OpError("not_found", "instance token not found");
    return { id: row.id, name: row.name, expires_at: iso(row.expiresAt) };
  },
});

export const instanceListOrgs = defineOp({
  name: "instance_list_orgs",
  summary: "Every org on the instance, for the instance administrator.",
  description:
    "Lists the slug and name of every org of the instance (not the internal system org), so the " +
    "administrator can name one in set_quotas. Names come from the orgs' admins: untrusted text. " +
    "Only the instance administrator can call it. Read-only.",
  input: z.object({}),
  output: z.object({
    orgs: z.array(z.object({ slug: z.string(), name: z.string() })),
  }),
  effect: "read",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: true,
  scope: "org",
  http: { method: "GET", path: "/instance/orgs" },
  mcp: false,
  async handler(ctx) {
    const orgs = await listAllOrgs(ctx.db);
    return {
      orgs: orgs
        .filter((o) => o.slug !== SYSTEM_ORG_SLUG)
        .map((o) => ({ slug: o.slug, name: o.name })),
    };
  },
});

const limit = z.int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();

export const setQuotas = defineOp({
  name: "set_quotas",
  summary: "Set an org's quotas (instance administrator only).",
  description:
    "Changes the limits of one org, naming only the ones to change (null removes a limit). " +
    "`max_concurrent` can only lower the org's concurrency below the instance's per-org cap " +
    "(`--org-cap`): a value above it is refused, and removing it falls back to the cap. The new " +
    "limits and the usage against them are returned. The change is audited in the system org's " +
    "chain and in the target org's own. Only the instance administrator can call it: an org's own " +
    "tokens, of any role, never can. Not an MCP tool.",
  input: z.object({
    target_org: z.string().min(1).max(64).describe("Slug of the org whose quotas change."),
    max_concurrent: limit.optional(),
    max_runs_per_hour: limit.optional(),
    max_sandbox_minutes_per_day: limit.optional(),
    max_log_bytes: limit.optional(),
    max_stored_bytes: limit.optional(),
  }),
  output: quotaViewSchema,
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/quotas" },
  mcp: false,
  async handler(ctx, i) {
    const org = await getOrgBySlug(ctx.db, i.target_org);
    if (!org || org.slug === SYSTEM_ORG_SLUG) throw new OpError("not_found", "no such org");
    const patch: Record<string, number | null> = {};
    const set = (key: string, v: number | null | undefined): void => {
      if (v !== undefined) patch[key] = v;
    };
    set("maxConcurrent", i.max_concurrent);
    set("maxRunsPerHour", i.max_runs_per_hour);
    set("maxSandboxMinutesPerDay", i.max_sandbox_minutes_per_day);
    set("maxLogBytes", i.max_log_bytes);
    set("maxStoredBytes", i.max_stored_bytes);
    if (Object.keys(patch).length === 0) {
      throw new OpError("invalid_input", "name at least one limit to set");
    }
    const cap = ctx.instanceOrgCap;
    if (typeof i.max_concurrent === "number" && cap !== undefined && i.max_concurrent > cap) {
      throw new OpError(
        "invalid_input",
        `max_concurrent ${i.max_concurrent} is above the instance's per-org cap of ${cap}; it can only lower it`,
      );
    }
    await setOrgQuotas(ctx.db, org.id, patch, `instance:${ctx.principal.id}`, ctx.now());
    // The org's own chain says it too: its operators should see who changed their limits.
    await appendAudit(
      ctx.db,
      { orgId: org.id },
      {
        principalKind: "instance",
        principalId: ctx.principal.id,
        op: "set_quotas",
        effect: "write",
        outcome: "ok",
        input: { target_org: org.slug, ...patch },
      },
    );
    return quotaView(ctx, org.id);
  },
});
