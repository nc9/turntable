import { z } from "zod";
import { clearRotationFlagIfRotated } from "../../db/repos";
import { type SecretView, VaultInputError, type SecretVault } from "../../secrets/vault";
import { decodeCursor, encodeCursor, nextCursor, pageInput } from "../common";
import { defineOp, type OpContext } from "../define";
import { OpError } from "../errors";

const nameField = z.string().min(1).max(128).describe("Name, e.g. DEPLOY_KEY.");
const environmentField = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe("Limit to jobs that run in this environment.");
const refField = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe("Limit to this ref pattern (main, release/*, refs/tags/v*).");

const viewSchema = z.object({
  id: z.string(),
  name: z.string(),
  project_id: z.string().nullable().describe("Null: the whole org."),
  environment: z.string().nullable(),
  ref_pattern: z.string().nullable(),
  trust_classes: z.array(z.string()).describe("Classes allowed to use it. Never untrusted_pr."),
  destinations: z.array(z.string()).describe("Hosts a delivery may go to. Empty: nowhere."),
  source: z.string().describe("sealed, or the store that holds the value (onepassword)."),
  external_ref: z
    .string()
    .nullable()
    .describe("The store's reference (vault, item and field names). Null when sealed."),
  current_version: z.int().describe("0 for an external reference."),
  versions: z.array(
    z.object({
      version: z.int(),
      created_at: z.int(),
      created_by: z.string(),
      valid_until: z
        .int()
        .nullable()
        .describe("End of the rotation overlap; null for the current one."),
    }),
  ),
  created_at: z.int(),
  updated_at: z.int(),
  last_used_at: z.int().nullable(),
});

/** The vault, or a clear refusal when the server runs without a master key. */
function vaultOf(ctx: OpContext): SecretVault {
  if (!ctx.vault) {
    throw new OpError(
      "unavailable",
      "the secrets vault is not configured: start the server with TURNTABLE_MASTER_KEY_FILE",
    );
  }
  return ctx.vault;
}

/** Input problems are the caller's to fix; they never carry a value. */
async function guarded<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (err) {
    if (err instanceof VaultInputError) throw new OpError("invalid_input", err.message);
    throw err;
  }
}

/**
 * The scope an incident flag may be closed from: the token's own grant. A project given in the
 * input only narrows what the call touches; it must not let an org-wide token pose as a project
 * one, and a project-scoped token must stay inside its project.
 */
const grantScope = (ctx: OpContext) => ({
  orgId: ctx.scope.orgId,
  ...(ctx.principal.kind === "token" && ctx.principal.projectId
    ? { projectId: ctx.principal.projectId }
    : {}),
});

const actor = (ctx: OpContext): string => `${ctx.principal.kind}:${ctx.principal.id}`;

const scopeOf = (
  ctx: OpContext,
  i: { name: string; environment?: string | undefined; ref_pattern?: string | undefined },
) => ({
  name: i.name,
  projectId: ctx.scope.projectId ?? null,
  environment: i.environment ?? null,
  refPattern: i.ref_pattern ?? null,
});

const VALUE_NOTE =
  "The value is in the request body and is never returned, logged or audited. Send it only over " +
  "https; prefer `turntable secret set --value-file`. Not available over MCP.";

export const setSecretOp = defineOp({
  name: "set_secret",
  summary: "Store a scoped secret value (new, or a new version of an existing scope).",
  description:
    "Stores a secret for jobs under a scope: the org, or one project when a project is given, " +
    "optionally limited to an environment and a ref pattern. It names the trust classes allowed " +
    "to use it (default protected and release; untrusted_pr is refused) and the destination " +
    "hosts it may be sent to (default none: it is stored but deliverable nowhere). Setting an " +
    "existing scope adds a version and retires the old one at once; use rotate_secret for an " +
    "overlap. " +
    VALUE_NOTE +
    " Needs release_operator or admin. Audited by name and scope, never by value.",
  input: z.object({
    name: nameField,
    value: z
      .string()
      .min(1)
      .max(16 * 1024)
      .describe("The secret value."),
    environment: environmentField,
    ref_pattern: refField,
    trust_classes: z.array(z.string().max(32)).max(8).optional(),
    destinations: z.array(z.string().max(253)).max(64).optional(),
  }),
  output: z.object({ created: z.boolean(), entry: viewSchema }),
  effect: "write",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/secrets" },
  secretInputFields: ["value"],
  mcp: false,
  async handler(ctx, i) {
    const r = await guarded(() =>
      vaultOf(ctx).set(ctx.scope.orgId, actor(ctx), scopeOf(ctx, i), i.value, {
        trustClasses: i.trust_classes,
        destinations: i.destinations,
      }),
    );
    // A new value for an existing secret is a rotation: close the incident flag if every scope of
    // the name has been replaced since it was raised.
    if (!r.created) await clearRotationFlagIfRotated(ctx.db, grantScope(ctx), i.name, ctx.now());
    return { created: r.created, entry: r.secret };
  },
});

export const rotateSecretOp = defineOp({
  name: "rotate_secret",
  summary: "Give an existing secret a new value; keep the old one usable for an overlap window.",
  description:
    "Adds a new version of an existing secret (same scope) and makes it current. The previous " +
    "version stays usable for overlap_seconds (0 to 7 days, default 0) so a run that already " +
    "started, or a system you have not updated yet, keeps working. Scope and policy do not " +
    "change. " +
    VALUE_NOTE +
    " Needs release_operator or admin; audited by name, scope and version, never by value.",
  input: z.object({
    name: nameField,
    value: z
      .string()
      .min(1)
      .max(16 * 1024)
      .describe("The new secret value."),
    environment: environmentField,
    ref_pattern: refField,
    overlap_seconds: z
      .int()
      .min(0)
      .max(7 * 24 * 3600)
      .default(0),
  }),
  output: viewSchema,
  effect: "write",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/secrets/rotate" },
  secretInputFields: ["value"],
  mcp: false,
  async handler(ctx, i) {
    const r = await guarded(() =>
      vaultOf(ctx).rotate(
        ctx.scope.orgId,
        actor(ctx),
        scopeOf(ctx, i),
        i.value,
        i.overlap_seconds * 1000,
      ),
    );
    if (!r) throw new OpError("not_found", "no secret with that name and scope");
    await clearRotationFlagIfRotated(ctx.db, grantScope(ctx), i.name, ctx.now());
    return r;
  },
});

export const deleteSecretOp = defineOp({
  name: "delete_secret",
  summary: "Delete a secret and every version of it.",
  description:
    "Permanently deletes the secret under that exact name and scope, with all its versions. " +
    "Irreversible. Needs release_operator or admin; audited by name and scope.",
  input: z.object({ name: nameField, environment: environmentField, ref_pattern: refField }),
  output: z.object({ name: z.string(), versions_removed: z.int() }),
  effect: "destructive",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "DELETE", path: "/secrets" },
  async handler(ctx, i) {
    const r = await guarded(() => vaultOf(ctx).delete(ctx.scope.orgId, scopeOf(ctx, i)));
    if (!r) throw new OpError("not_found", "no secret with that name and scope");
    return { name: r.name, versions_removed: r.versions.length };
  },
});

export const listSecretsOp = defineOp({
  name: "list_secrets",
  summary: "List secrets: names, scopes, policy, versions and last use. Never values.",
  description:
    "Lists the org's secrets (or one project's, when a project is given) with their scope, " +
    "allowed trust classes, destination hosts, versions and when each was last used. Values are " +
    "never returned by any operation. Needs release_operator or admin, because names and scopes " +
    "show what is worth attacking. Read-only.",
  input: z.object({ ...pageInput }),
  output: z.object({ entries: z.array(viewSchema), next_cursor: nextCursor }),
  effect: "read",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/secrets" },
  async handler(ctx, i) {
    const rows: SecretView[] = await vaultOf(ctx).list(ctx.scope.orgId, ctx.scope.projectId, {
      ...(i.cursor === undefined ? {} : { afterId: decodeCursor(i.cursor) }),
      limit: i.limit + 1,
    });
    const page = rows.slice(0, i.limit);
    const last = page.at(-1);
    return {
      entries: page,
      next_cursor: rows.length > i.limit && last ? encodeCursor(last.id) : null,
    };
  },
});

const referenceField = z
  .string()
  .min(1)
  .max(512)
  .describe("A 1Password reference: op://<vault>/<item>/[section/]<field>. Names, never a value.");

export const bindSecretReferenceOp = defineOp({
  name: "bind_secret_reference",
  summary: "Point a secret name at a 1Password reference instead of a sealed value.",
  description:
    "Makes the secret under that name and scope an external reference. The value is read from " +
    "1Password at use time, through the same policy as a sealed secret (trust class, scope, " +
    "destination), cached in memory for a short TTL, and delivered only by the secrets proxy. " +
    "The reference must name a vault that an operator-configured service account serves, and " +
    "that account must also be bound to the job's org or project and trust class, or every use " +
    "is refused. Re-binding the same scope re-points it. A sealed secret of that scope is not " +
    "converted: delete it first. Reads no value. Needs admin; audited by name, scope and reference.",
  input: z.object({
    name: nameField,
    reference: referenceField,
    environment: environmentField,
    ref_pattern: refField,
    trust_classes: z.array(z.string().max(32)).max(8).optional(),
    destinations: z.array(z.string().max(253)).max(64).optional(),
  }),
  output: z.object({ created: z.boolean(), entry: viewSchema }),
  effect: "write",
  auth: { type: "token", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/secrets/references" },
  async handler(ctx, i) {
    const r = await guarded(() =>
      vaultOf(ctx).bindReference(
        ctx.scope.orgId,
        actor(ctx),
        scopeOf(ctx, i),
        "onepassword",
        i.reference,
        { trustClasses: i.trust_classes, destinations: i.destinations },
      ),
    );
    return { created: r.created, entry: r.secret };
  },
});

export const unbindSecretReferenceOp = defineOp({
  name: "unbind_secret_reference",
  summary: "Remove a secret's 1Password reference.",
  description:
    "Deletes the external reference under that exact name and scope. Nothing in 1Password " +
    "changes. A sealed secret is refused (use delete_secret). Needs admin; audited by name and " +
    "scope.",
  input: z.object({ name: nameField, environment: environmentField, ref_pattern: refField }),
  output: z.object({ name: z.string(), external_ref: z.string().nullable() }),
  effect: "destructive",
  auth: { type: "token", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "DELETE", path: "/secrets/references" },
  async handler(ctx, i) {
    const r = await guarded(() => vaultOf(ctx).unbindReference(ctx.scope.orgId, scopeOf(ctx, i)));
    if (!r) throw new OpError("not_found", "no secret with that name and scope");
    return { name: r.name, external_ref: r.external_ref };
  },
});

export const refreshSecretsOp = defineOp({
  name: "refresh_secrets",
  summary: "Drop the in-memory cache of external secret values.",
  description:
    "Forgets every cached 1Password value, so the next use reads the current one (after a " +
    "rotation, say). Each distinct reference costs one read against the service account's rate " +
    "limit, so use it when you need it. Does not touch sealed secrets. Needs admin; audited.",
  input: z.object({}),
  output: z.object({ dropped: z.int().describe("Cached values dropped.") }),
  effect: "write",
  auth: { type: "token", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/secrets/refresh" },
  async handler(ctx) {
    return { dropped: vaultOf(ctx).refreshBackends() };
  },
});

export const doctorSecretsOp = defineOp({
  name: "doctor_secrets",
  summary: "Check the external secret stores: reachability of a canary reference, and quota.",
  description:
    "For each configured store, lists the service accounts (names and the vaults they serve, " +
    "never a token), the reads made in the last hour and the remaining hourly quota when a " +
    "limit is configured (the daily per-account limit is not tracked: see the 1Password " +
    "account), and resolves the operator-named canary reference live to report " +
    "whether the store is reachable. The canary's value is never returned. Needs admin. " +
    "Read-only apart from that one read.",
  input: z.object({}),
  output: z.object({
    backends: z.array(
      z.object({
        source: z.string(),
        accounts: z.array(
          z.object({
            name: z.string(),
            vaults: z.array(z.string()),
            reads_last_hour: z.int(),
            remaining_hourly: z.int().nullable(),
            blocked_until: z.int().nullable(),
          }),
        ),
        canary: z.object({
          configured: z.boolean(),
          account: z.string().nullable().optional(),
          vault: z.string().optional(),
          item: z.string().optional(),
          field: z.string().optional(),
          reachable: z.boolean().optional(),
          error_kind: z.string().nullable().optional(),
        }),
      }),
    ),
  }),
  effect: "read",
  auth: { type: "token", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/secrets/doctor" },
  async handler(ctx) {
    const rows = await vaultOf(ctx).backendHealth();
    return {
      backends: rows.map((r) => ({
        source: r.source,
        accounts: r.health.accounts.map((a) => ({ ...a, vaults: [...a.vaults] })),
        canary: r.health.canary,
      })),
    };
  },
});
