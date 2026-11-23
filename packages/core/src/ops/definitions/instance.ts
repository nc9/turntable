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
  countActiveApiTokens,
  createOrg,
  findRepoBindingByName,
  getInstallation,
  getInstanceToken,
  getOrgById,
  getOrgBySlug,
  getProject,
  getProjectBySlug,
  insertApiToken,
  listAllOrgs,
  moveRepoBinding,
  setOrgQuotas,
} from "../../db/repos";
import { SYSTEM_ORG_SLUG } from "../../audit/failures";
import { AGENT_ROLES, FORGES, TOKEN_KINDS } from "../../db/schema";
import { ingestStatus } from "../../poll/status";
import { ORG_SLUG } from "../bootstrap";
import { defineOp } from "../define";
import { OpError } from "../errors";
import { rotateInstanceToken } from "../instance-token-cli";
import { generateToken, hashToken } from "../tokens";
import { doctorForApi, doctorOutput } from "./doctor";
import { quotaView, quotaViewSchema } from "./quotas";

const DAY_MS = 86_400_000;

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

export const createOrgOp = defineOp({
  name: "create_org",
  summary: "Create an empty org (instance administrator only).",
  description:
    "Creates an org with a slug (lower-case letters, digits and `-`, up to 63, starting " +
    "alphanumeric) and a display name. The org starts with no projects and no tokens: give it " +
    "its first token with `create_org_token`. A slug already in use is a conflict, and the " +
    "internal system org is never a target. On a hosted instance with no shell this is how a " +
    "second tenant is added. Audited in the system org's chain and in the new org's own. Only " +
    "the instance administrator can call it. Not an MCP tool.",
  input: z.object({
    slug: z.string().min(1).max(63).describe("Slug of the new org."),
    name: z.string().min(1).max(120).describe("Display name. Untrusted text elsewhere."),
  }),
  output: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/orgs" },
  mcp: false,
  async handler(ctx, i) {
    if (!ORG_SLUG.test(i.slug)) {
      throw new OpError(
        "invalid_input",
        "an org slug is lower-case letters, digits and - (up to 63, starting alphanumeric)",
      );
    }
    if (i.slug === SYSTEM_ORG_SLUG || (await getOrgBySlug(ctx.db, i.slug))) {
      throw new OpError("conflict", "an org with that slug already exists");
    }
    const org = await createOrg(ctx.db, { slug: i.slug, name: i.name });
    await appendAudit(
      ctx.db,
      { orgId: org.id },
      {
        principalKind: "instance",
        principalId: ctx.principal.id,
        op: "create_org",
        effect: "write",
        outcome: "ok",
        input: { slug: org.slug },
      },
    );
    return { id: org.id, slug: org.slug, name: org.name };
  },
});

export const createOrgTokenOp = defineOp({
  name: "create_org_token",
  summary: "Mint an org's first token (instance administrator only).",
  description:
    "Mints the first token of an org that has none: it is refused as a conflict once the org " +
    "has any token that is neither revoked nor expired, so it cannot be used to add access to " +
    "an org that already has some (the same one-shot rule as the env bootstrap). The role is " +
    "at most `release_operator`; `kind` defaults to `person` (the operator's own token, which " +
    "may approve under `no_agents`). An expiry of 1 to 365 days is required. The secret is " +
    "returned once in `token` and cannot be read again: only its hash is stored, and the audit " +
    "entries never hold it. After this the org manages its own tokens. The system org is never " +
    "a target. Audited in the system org's chain and in the org's own. Only the instance " +
    "administrator can call it. Not an MCP tool.",
  input: z.object({
    target_org: z.string().min(1).max(64).describe("Slug of the org."),
    name: z.string().min(1).max(80).describe("A label for the token."),
    role: z.enum(AGENT_ROLES).describe("At most release_operator."),
    kind: z
      .enum(TOKEN_KINDS)
      .default("person")
      .describe("person: a human's own token (default). agent: an MCP client or script."),
    expires_days: z.int().min(1).max(365).describe("Lifetime in days."),
  }),
  output: z.object({
    id: z.string(),
    name: z.string(),
    org: z.string().describe("Org slug."),
    role: z.enum(AGENT_ROLES),
    kind: z.enum(TOKEN_KINDS),
    expires_at: z.string(),
    token: z.string().describe("The secret. Shown once, store it now."),
  }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/orgs/tokens" },
  mcp: false,
  oneTimeSecretFields: ["token"],
  async handler(ctx, i) {
    const org = await getOrgBySlug(ctx.db, i.target_org);
    if (!org || org.slug === SYSTEM_ORG_SLUG) throw new OpError("not_found", "no such org");
    const scope = { orgId: org.id };
    if ((await countActiveApiTokens(ctx.db, scope, ctx.now())) > 0) {
      throw new OpError(
        "conflict",
        "the org already has an active token; only the org's own admins can add more",
      );
    }
    const secret = generateToken();
    const expiresAt = ctx.now() + i.expires_days * DAY_MS;
    const row = await insertApiToken(ctx.db, scope, {
      name: i.name,
      role: i.role,
      kind: i.kind,
      tokenHash: hashToken(secret),
      createdBy: `instance:${ctx.principal.id}`,
      expiresAt,
    });
    await appendAudit(ctx.db, scope, {
      principalKind: "instance",
      principalId: ctx.principal.id,
      op: "create_org_token",
      effect: "write",
      outcome: "ok",
      input: {
        target_org: org.slug,
        token_id: row.id,
        name: i.name,
        role: i.role,
        kind: i.kind,
        expires_days: i.expires_days,
      },
    });
    return {
      id: row.id,
      name: row.name,
      org: org.slug,
      role: i.role,
      kind: i.kind,
      expires_at: new Date(expiresAt).toISOString(),
      token: secret,
    };
  },
});

const REFUSED = "that binding cannot be moved to that org and project";

export const moveRepoBindingOp = defineOp({
  name: "move_repo_binding",
  summary: "Move a repo's binding to a project in another org (instance administrator only).",
  description:
    "Moves the one binding of a repo (`forge`, `owner`, `repo`) to `to_project` of `to_org`, in " +
    "one transaction, and keeps its installation. A repo is bound to one project on the whole " +
    "instance, so this is how a tenant's repo leaves the bootstrap org before its installation is " +
    "claimed. Refused, with one message that names no other org, when the target project is not in " +
    "the target org, when the binding's installation is not mapped to the target org, or when " +
    "`forge_repo_id` is given and differs from the binding's. Run history stays with the old " +
    "project, and its queued and running attempts finish there; only later ingest lands in the new " +
    "project. The poller's seen markers of the repo are copied to the new project, so a poll at " +
    "the same head creates no second run. A static poll entry still naming the old project is " +
    "skipped by the poller (one warning per interval) until it is changed and the instance " +
    "restarted: the response lists the entries of the running poll config that still name the " +
    "old project. Audited in the system org's chain and in both orgs' chains, with the old and new " +
    "ids. Only the instance administrator can call it. Not an MCP tool.",
  input: z.object({
    forge: z.enum(FORGES).default("github"),
    owner: z.string().min(1).max(100),
    repo: z.string().min(1).max(100),
    forge_repo_id: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe("Forge's numeric repo id; refused if the binding holds a different one."),
    to_org: z.string().min(1).max(64).describe("Slug of the target org."),
    to_project: z.string().min(1).max(63).describe("Slug of the target project in that org."),
  }),
  output: z.object({
    binding_id: z.string(),
    repo: z.string(),
    installation_id: z.string().nullable(),
    from: z.object({ org: z.string(), project: z.string() }),
    to: z.object({ org: z.string(), project: z.string() }),
    poll_entries_to_update: z
      .array(z.object({ repo: z.string(), org: z.string(), project: z.string() }))
      .describe("Entries of the running poll config that still name the old project."),
  }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/repo-bindings/move" },
  mcp: false,
  async handler(ctx, i) {
    const org = await getOrgBySlug(ctx.db, i.to_org);
    const project =
      org && org.slug !== SYSTEM_ORG_SLUG
        ? await getProjectBySlug(ctx.db, { orgId: org.id }, i.to_project)
        : undefined;
    if (!org || !project) throw new OpError("not_found", "no such org or project");
    const binding = await findRepoBindingByName(ctx.db, i);
    if (!binding) throw new OpError("not_found", "no such binding");
    if (
      binding.forgeRepoId !== null &&
      i.forge_repo_id &&
      binding.forgeRepoId !== i.forge_repo_id
    ) {
      throw new OpError("conflict", REFUSED);
    }
    if (binding.installationId !== null) {
      const inst = await getInstallation(ctx.db, binding.installationId);
      if (!inst || inst.orgId !== org.id) throw new OpError("conflict", REFUSED);
    }
    if (binding.orgId === org.id && binding.projectId === project.id) {
      throw new OpError("conflict", "the binding is already in that project");
    }
    const fromOrg = (await getOrgById(ctx.db, binding.orgId))!;
    const fromProject = (await getProject(ctx.db, { orgId: binding.orgId }, binding.projectId))!;
    if (!(await moveRepoBinding(ctx.db, binding.id, { orgId: org.id, projectId: project.id }))) {
      throw new OpError("not_found", "no such binding");
    }
    const detail = {
      binding_id: binding.id,
      repo: `${binding.owner}/${binding.repo}`,
      from_org_id: fromOrg.id,
      from_project_id: fromProject.id,
      to_org_id: org.id,
      to_project_id: project.id,
    };
    const entry = {
      principalKind: "instance" as const,
      principalId: ctx.principal.id,
      op: "move_repo_binding",
      effect: "write" as const,
      outcome: "ok" as const,
      input: detail,
    };
    // The system chain gets the dispatcher's entry; each org's own chain says it too.
    await appendAudit(ctx.db, { orgId: fromOrg.id, projectId: fromProject.id }, entry);
    if (org.id !== fromOrg.id) {
      await appendAudit(ctx.db, { orgId: org.id, projectId: project.id }, entry);
    }
    const key = `${binding.owner}/${binding.repo}`;
    return {
      binding_id: binding.id,
      repo: key,
      installation_id: binding.installationId,
      from: { org: fromOrg.slug, project: fromProject.slug },
      to: { org: org.slug, project: project.slug },
      poll_entries_to_update: [...ingestStatus.repos.values()]
        .filter(
          (r) =>
            r.repo.toLowerCase() === key &&
            r.org === fromOrg.slug &&
            r.project === fromProject.slug,
        )
        .map((r) => ({ repo: r.repo, org: r.org, project: r.project })),
    };
  },
});

export const instanceDoctorOp = defineOp({
  name: "instance_doctor",
  summary: "The instance's readiness report, for the instance administrator.",
  description:
    "Runs the same read-only readiness checks as `turntable doctor` (master key and audit " +
    "anchor, database and migrations, GitHub App credentials, sandbox provider, proxy TLS, " +
    "forwarded headers, release channel, quotas) and returns each check's id, area, status " +
    "(pass, warn or fail), a fixed one-line summary and a fixed fix. It never returns raw error " +
    "text or a secret value. Use it on a hosted instance with no shell, for example to confirm " +
    "a master-key rotation before removing the previous key. Only the instance administrator " +
    "can call it. Read-only. Not an MCP tool.",
  input: z.object({}),
  output: doctorOutput,
  effect: "read",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/instance/doctor" },
  mcp: false,
  async handler(ctx) {
    return doctorForApi(ctx.doctor);
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
  logOmitFields: ["public_key"],
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
