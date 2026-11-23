// Instance-level operations (#205). They belong to the instance administrator, not to any org: the
// caller is a `tti_` token minted on the host, and only such a token can call them over REST. No
// org token of any role can, whatever its grant, and none of these is an MCP tool. Their audit
// entries go to the system org's chain.
import { z } from "zod";
import { createSettingsRuntime, resolveSetting } from "../../settings/resolve";
import { settingsRegistry } from "../../settings/definitions";
import { approvalWarnings, bootstrapFirstApprover } from "../../approvals/apply";
import {
  ApprovalConflict,
  appendAudit,
  getInstanceToken,
  getOrgBySlug,
  listAllOrgs,
  setOrgQuotas,
} from "../../db/repos";
import { SYSTEM_ORG_SLUG } from "../../audit/failures";
import { defineOp } from "../define";
import { OpError } from "../errors";
import { rotateInstanceToken } from "../instance-token-cli";
import { quotaView, quotaViewSchema } from "./quotas";

const iso = (ms: number | null | undefined): string | null =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString();

export const instanceWhoami = defineOp({
  name: "instance_whoami",
  summary: "Who the instance administrator token is.",
  description:
    "Returns the id and label of the instance token in use and when it expires. Use it to check " +
    "that a `tti_` token works. Only the instance administrator can call it. Read-only.",
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

export const rotateInstanceTokenOp = defineOp({
  name: "rotate_instance_token",
  summary:
    "Replace the instance administrator token in use with a new one (instance administrator only).",
  description:
    "Mints a new instance token with the same name (or the one given) and revokes the token that " +
    "made this call, in one step. The new secret is returned once; only its hash is stored, so it " +
    "cannot be shown again. Use it once after a first boot with " +
    "TURNTABLE_INSTANCE_BOOTSTRAP_TOKEN_SHA256, then remove that variable. The audit entry names " +
    "the two token ids and never a secret or a hash. Only the instance administrator can call it. " +
    "Not an MCP tool: instance tokens are not MCP credentials.",
  input: z.object({
    name: z.string().min(1).max(80).optional().describe("Label of the new token."),
    expires_days: z.int().min(1).max(90).optional().describe("Lifetime in days. Default 30."),
  }),
  output: z.object({
    id: z.string(),
    secret: z.string().describe("The new token. Shown once."),
    expires_at: z.string(),
    revoked_id: z.string(),
  }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/tokens/rotate" },
  mcp: false,
  oneTimeSecretFields: ["secret"],
  auditDetail: (o) => ({ id: o.id, revoked_id: o.revoked_id }),
  async handler(ctx, i) {
    try {
      const r = await rotateInstanceToken(ctx.db, {
        oldId: ctx.principal.id,
        name: i.name,
        expiresInDays: i.expires_days,
        createdBy: `instance:${ctx.principal.id}`,
        now: ctx.now,
      });
      return {
        id: r.id,
        secret: r.secret,
        expires_at: new Date(r.expiresAt).toISOString(),
        revoked_id: r.revokedId,
      };
    } catch (err) {
      if (err instanceof Error) throw new OpError("invalid_input", err.message);
      throw err;
    }
  },
});

export const bootstrapApprover = defineOp({
  name: "bootstrap_approver",
  summary:
    "Enrol an org's first approver from an offline ed25519 public key (instance administrator only).",
  description:
    "The hosted counterpart of `turntable approvals bootstrap`, for an instance with no shell. " +
    "Takes the target org, the person's name and forge login, and an ed25519 public key generated " +
    "offline (`turntable approvals keygen`); the private key never reaches the server. Works only " +
    "while the org has no active approver and never adds to an existing set: after that, new keys " +
    "need a quorum of existing approvers (request_enrolment and approve_enrolment), and the " +
    "bootstrap key signs the passkey's enrolment as usual. An org whose approvers were all revoked " +
    "can be bootstrapped again only after the `approver_rebootstrap_delay_hours` setting (24 by " +
    "default, at least 1) has passed since the last revocation, so a stolen token cannot revoke " +
    "every approver and enrol its own key at once; the refusal says when. Revoking the last " +
    "approver and every bootstrap emit an event (`approvers.depleted`, `approver.bootstrapped`) " +
    "that outbound webhooks can carry. Returns the approver id and the key's " +
    "fingerprint. The change is audited in the system org's chain and in the target org's own, " +
    "with the fingerprint and never the key. Only the instance administrator can call it: an " +
    "org's own tokens, of any role, never can. Not an MCP tool.",
  input: z.object({
    target_org: z.string().min(1).max(64).describe("Slug of the org that gets its first approver."),
    person: z.string().trim().min(1).max(200).describe("A name for the human who holds the key."),
    forge_login: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .describe("Their forge login, which an approval is checked against the run's author with."),
    public_key: z
      .string()
      .min(1)
      .max(4096)
      .describe("The ed25519 public key (SPKI PEM or base64)."),
  }),
  output: z.object({
    approver_id: z.string(),
    person: z.string(),
    key_fingerprint: z.string(),
    warnings: z.array(z.string()),
  }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/approvers/bootstrap" },
  mcp: false,
  // Only the public key's fingerprint is audited, never the key text itself.
  auditOmitFields: ["public_key"],
  auditDetail: (o) => ({ approver_id: o.approver_id, key_fingerprint: o.key_fingerprint }),
  async handler(ctx, i) {
    const org = await getOrgBySlug(ctx.db, i.target_org);
    if (!org || org.slug === SYSTEM_ORG_SLUG) throw new OpError("not_found", "no such org");
    const rt = ctx.settings ?? createSettingsRuntime(settingsRegistry);
    const hours = (
      await resolveSetting(rt, ctx.db, "approver_rebootstrap_delay_hours", {
        orgId: org.id,
        orgSlug: org.slug,
      })
    ).value as number;
    let made: { id: string; person: string; fingerprint: string };
    try {
      made = await bootstrapFirstApprover(
        ctx.db,
        org.id,
        {
          person: i.person,
          forgeLogin: i.forge_login,
          publicKey: i.public_key,
          createdBy: `instance:${ctx.principal.id}`,
        },
        ctx.now(),
        { delayMs: hours * 3_600_000 },
      );
    } catch (e) {
      if (e instanceof ApprovalConflict) throw new OpError("conflict", e.message);
      if (e instanceof OpError) throw e;
      throw new OpError("invalid_input", "public_key is not a valid ed25519 public key");
    }
    // The org's own chain says it too: its operators should see how their first approver came.
    await appendAudit(
      ctx.db,
      { orgId: org.id },
      {
        principalKind: "instance",
        principalId: ctx.principal.id,
        op: "bootstrap_approver",
        effect: "write",
        outcome: "ok",
        input: {
          target_org: org.slug,
          person: made.person,
          forge_login: i.forge_login,
          approver_id: made.id,
          key_fingerprint: made.fingerprint,
        },
      },
    );
    return {
      approver_id: made.id,
      person: made.person,
      key_fingerprint: made.fingerprint,
      warnings: await approvalWarnings(ctx.db, org.id, ["production", "release"]),
    };
  },
});
