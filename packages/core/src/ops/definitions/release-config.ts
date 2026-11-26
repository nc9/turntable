// Release lane configuration for instances with no shell (#541): the operator org's owner sets
// the pinned repository, the publish targets and the lane's secrets through REST, for a project of
// an org. Nothing here writes the main database: each change is a signed message over the release
// channel to the lane, which writes its own file (and, for a secret, its own vault view). The
// lane is not configured here: without its config channel every op is refused.
//
// A write needs a signed-in WEB SESSION of an owner of the operator org (the org that owns the
// GitHub App) AND a fresh passkey step-up in that org, bound to the op and the exact input (see
// ../lane-target.ts and ../step-up.ts). A `tti_` instance token, an org token and MCP are refused.
// None of these is an MCP tool.
import { z } from "zod";
import {
  getIdentityByUserId,
  getProjectSigning,
  listAuditByOp,
  listMembershipsOfUser,
  setProjectSigning,
} from "../../db/repos";
import type { ConfigAction } from "../../release/channel";
import { buildTarget, validateRepo, validateTargetKey } from "../../release/config";
import { LaneConfigError } from "../../release/config";
import { SECRET_NAME } from "../../release/publish/types";
import { iso } from "../common";
import { validateSigningPatch } from "../policy-cli";
import { defineOp, type OpContext } from "../define";
import { OpError } from "../errors";
import { principalLabel } from "../principal";
import { releaseKeyReads } from "../read-rate-limit";
import { resolveLaneOrg, resolveLaneTarget } from "../lane-target";

const scopeFields = {
  target_org: z.string().min(1).max(64).describe("Slug of the org that owns the project."),
  target_project: z
    .string()
    .min(1)
    .max(64)
    .describe("Slug of the project, looked up inside that org."),
};

const stepUpNote =
  "Needs a signed-in web session of an OWNER of the operator org (`org`) AND a fresh passkey " +
  "step-up in that org: call session_step_up_challenge for this exact input, sign its challenge " +
  "with your passkey, and send the assertion as `step_up` beside the input. The step-up is bound " +
  "to this op and input, single-use, and lasts 5 minutes. A `tti_` instance token, an org token " +
  "and MCP are refused. ";

/** Sends one message to the lane, or refuses with the reason. Never echoes an input value. */
async function toLane(
  ctx: OpContext,
  action: ConfigAction,
  scope: { orgId: string; projectId?: string },
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const client = ctx.releaseConfig;
  if (!client) {
    throw new OpError(
      "unavailable",
      "the release lane is not configured on this instance: it has no config channel (see the hosted setup section of the release lane docs)",
      { reason: "lane_not_configured" },
    );
  }
  const r = await client.call(action, { ...scope, ...args });
  if (r.ok) return r.result as Record<string, unknown>;
  if (r.kind === "invalid") throw new OpError("invalid_input", r.reason);
  throw new OpError(
    "unavailable",
    `the release lane refused or could not be reached (${r.reason})`,
    {
      reason: r.kind === "unreachable" ? "lane_unreachable" : "lane_refused",
    },
  );
}

/** Defence in depth: the dispatcher spends the step-up before the handler; the handler insists. */
function requireStepUp(ctx: OpContext, name: string): void {
  if (ctx.principal.kind !== "session" || ctx.stepUp?.action !== name) {
    throw new OpError("forbidden", `${name} needs a fresh passkey step-up`, {
      reason: "step_up_required",
    });
  }
}

/** The caller must be an OWNER (by Turntable's own membership row) of the org `orgId`. */
async function requireOwnerOf(ctx: OpContext, orgId: string): Promise<void> {
  if (ctx.principal.kind !== "session") {
    throw new OpError("forbidden", "a web session is required");
  }
  const mine = await listMembershipsOfUser(ctx.db, ctx.principal.id);
  if (!mine.some((m) => m.orgId === orgId && m.role === "owner")) {
    throw new OpError(
      "forbidden",
      "you must be an owner of the project's org to change its policy",
      {
        reason: "not_target_org_owner",
      },
    );
  }
}

const mapLaneError = <T>(f: () => T): T => {
  try {
    return f();
  } catch (e) {
    if (e instanceof LaneConfigError) throw new OpError("invalid_input", e.message);
    throw e;
  }
};

const version = z.int().describe("The lane's configuration version after the change.");

export const releasePinRepo = defineOp({
  name: "release_pin_repo",
  summary: "Pin the repository a project releases from, in the release lane.",
  description:
    "Sets which repository (owner/name) a project releases from, in the release lane's own file: " +
    "the lane asks the forge about this repository only and refuses a run whose row names another. " +
    "The project must belong to `target_org`. Bumps the lane's config version, so a release " +
    "approved earlier must be approved again before it publishes. " +
    stepUpNote +
    "Refused when the lane is not configured on the instance. Audited. Not an MCP tool.",
  input: z.object({ ...scopeFields, repo: z.string().min(3).max(200).describe("owner/name") }),
  output: z.object({ repo: z.string(), config_version: version }),
  effect: "write",
  auth: { type: "token", minRole: "owner" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/release-lane/pin-repo" },
  mcp: false,
  outsideTransaction: true,
  async handler(ctx, i) {
    requireStepUp(ctx, "release_pin_repo");
    mapLaneError(() => validateRepo(i.repo));
    const scope = await resolveLaneTarget(ctx.db, i);
    const r = await toLane(ctx, "pin_repo", scope, { repo: i.repo });
    return { repo: String(r.repo), config_version: Number(r.config_version) };
  },
});

const kindEnum = z.enum(["npm", "github-release", "oci-image"]);

const targetFields = {
  key: z.string().min(1).max(32).describe("A short lower-case name for the target."),
  kind: kindEnum,
  mode: z
    .enum(["strict", "compat"])
    .optional()
    .describe("npm and github-release; an image is always compat."),
  package: z.string().max(214).optional().describe("npm: the package name."),
  artifact: z
    .string()
    .max(200)
    .optional()
    .describe("npm: the ARTIFACT holding the tarball; the lane publishes its single .tgz file."),
  secret: z
    .string()
    .max(128)
    .optional()
    .describe(
      "npm and oci-image: the NAME of the lane secret (see release_secret_set), never a value.",
    ),
  tag: z
    .string()
    .max(64)
    .optional()
    .describe(
      "npm: the dist-tag (default latest), or auto: the version's prerelease channel (1.2.3-beta.4 is beta), latest for a plain version.",
    ),
  access: z.enum(["public", "restricted"]).optional().describe("npm: access."),
  assets: z
    .array(z.string().max(200))
    .max(50)
    .optional()
    .describe("github-release: individual files to attach, by their path in the release."),
  asset_artifacts: z
    .array(z.string().max(200))
    .max(20)
    .optional()
    .describe(
      "github-release: artifact names (upload-artifact names) whose EVERY file is attached under its own basename. The name stays the same across releases.",
    ),
  provenance_asset: z
    .string()
    .max(200)
    .optional()
    .describe("github-release: the provenance asset name, or `none`."),
  accept_long_lived_token: z
    .boolean()
    .optional()
    .describe("npm: say you accept that publishing uses a long-lived registry token (required)."),
  registry: z.string().max(253).optional().describe("oci-image: the registry host."),
  repository: z.string().max(200).optional().describe("oci-image: owner/name."),
  manifest: z.string().max(200).optional().describe("oci-image: the manifest artifact."),
  tags: z.array(z.string().max(128)).max(10).optional().describe("oci-image: tags to push."),
  username: z.string().max(64).optional().describe("oci-image: the registry user."),
  realm_host: z
    .string()
    .max(253)
    .optional()
    .describe("oci-image: the token host, when not the registry's."),
};

export const releasePublishTargetSet = defineOp({
  name: "release_publish_target_set",
  summary: "Declare or replace a publish target of a project, in the release lane.",
  description:
    "Sets one publish target (npm, github-release or oci-image) of a project in the release lane's " +
    "own file, with exactly the fields and validation of `turntable release publish-target set` " +
    "(the same code). A target names a lane secret by NAME only; the value is set with " +
    "release_secret_set. An npm target needs `accept_long_lived_token: true`. Replaces a target " +
    "of the same key. Bumps the lane's config version (a release approved earlier must be " +
    "approved again). " +
    stepUpNote +
    "Refused when the lane is not configured. Audited. Not an MCP tool.",
  input: z.object({ ...scopeFields, ...targetFields }),
  output: z.object({ key: z.string(), kind: z.string(), config_version: version }),
  effect: "write",
  auth: { type: "token", minRole: "owner" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/release-lane/publish-targets" },
  mcp: false,
  outsideTransaction: true,
  async handler(ctx, i) {
    requireStepUp(ctx, "release_publish_target_set");
    mapLaneError(() => validateTargetKey(i.key));
    // The same check the lane makes (and the CLI): refused here before anything is sent.
    mapLaneError(() => buildTarget(i));
    const scope = await resolveLaneTarget(ctx.db, i);
    const { target_org: _o, target_project: _p, key, ...fields } = i;
    const r = await toLane(ctx, "target_set", scope, { key, fields });
    return { key, kind: String(r.kind), config_version: Number(r.config_version) };
  },
});

export const releasePublishTargetDelete = defineOp({
  name: "release_publish_target_delete",
  summary: "Remove a publish target of a project, in the release lane.",
  description:
    "Removes one publish target of a project from the release lane's own file. Bumps the lane's " +
    "config version (a release approved earlier must be approved again). " +
    stepUpNote +
    "Refused when the lane is not configured. Audited. Not an MCP tool.",
  input: z.object({ ...scopeFields, key: z.string().min(1).max(32) }),
  output: z.object({ removed: z.boolean(), config_version: version }),
  effect: "destructive",
  auth: { type: "token", minRole: "owner" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/release-lane/publish-targets/delete" },
  mcp: false,
  outsideTransaction: true,
  async handler(ctx, i) {
    requireStepUp(ctx, "release_publish_target_delete");
    mapLaneError(() => validateTargetKey(i.key));
    const scope = await resolveLaneTarget(ctx.db, i);
    const r = await toLane(ctx, "target_delete", scope, { key: i.key });
    return { removed: r.removed === true, config_version: Number(r.config_version) };
  },
});

export const releaseSecretSet = defineOp({
  name: "release_secret_set",
  summary: "Set a lane secret (a publish credential) for a project, in the release lane's vault.",
  description:
    "Stores a publish credential, such as an npm token, in the release lane's vault: sealed under " +
    "the lane's own key, release class only, for a project, and usable only against the hosts of " +
    "the project's targets that name it (declare the target first). `value` is write-only: it is " +
    "never returned, never logged and never audited (the audit records the name, the project and " +
    "who), is refused in a URL and over plain http, and is bound in the step-up by its digest " +
    "(`value_sha256`, see session_step_up_challenge), so the approver's device never sees it. " +
    "Setting an existing name adds a version. Bumps the lane's config version. " +
    stepUpNote +
    "Refused when the lane is not configured. Not an MCP tool.",
  input: z.object({
    ...scopeFields,
    name: z.string().min(1).max(128).describe("The lane secret's name, as a target's `secret`."),
    value: z.string().min(1).max(16_384).describe("The secret value. Send it in the body only."),
  }),
  output: z.object({ name: z.string(), created: z.boolean(), config_version: version }),
  effect: "write",
  auth: { type: "token", minRole: "owner" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/release-lane/secrets" },
  mcp: false,
  outsideTransaction: true,
  secretInputFields: ["value"],
  async handler(ctx, i) {
    requireStepUp(ctx, "release_secret_set");
    if (!SECRET_NAME.test(i.name)) throw new OpError("invalid_input", "invalid secret name");
    const scope = await resolveLaneTarget(ctx.db, i);
    const r = await toLane(ctx, "secret_set", scope, {
      name: i.name,
      value: i.value,
      actor: `${ctx.principal.kind}:${ctx.principal.id}`,
    });
    return { name: i.name, created: r.created === true, config_version: Number(r.config_version) };
  },
});

export const releasePublishTargetList = defineOp({
  name: "release_publish_target_list",
  summary: "A project's release lane configuration: the pin and each publish target.",
  description:
    "Returns the pinned repository, the lane's config version and each publish target of a project " +
    "as the release lane's file holds them, with `has_credential` true or false for whether the " +
    "lane's vault holds a usable secret for it, and nothing else secret. The project must belong " +
    "to `target_org`. Read-only, no step-up. Refused when the lane is not configured. Not an MCP tool.",
  input: z.object({ ...scopeFields }),
  output: z.object({
    pinned_repo: z.string().nullable(),
    config_version: version,
    targets: z.array(
      z.object({
        key: z.string(),
        kind: z.string(),
        mode: z.string(),
        has_credential: z.boolean(),
        settings: z
          .record(z.string(), z.unknown())
          .describe("The declaration; `vault_name` names the lane secret it uses."),
      }),
    ),
  }),
  effect: "read",
  auth: { type: "token", minRole: "owner" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/release-lane/publish-targets" },
  mcp: false,
  async handler(ctx, i) {
    const scope = await resolveLaneTarget(ctx.db, i);
    const r = (await toLane(ctx, "snapshot", scope, {})) as {
      pinned_repo: string | null;
      config_version: number;
      targets: {
        key: string;
        kind: string;
        mode: string;
        has_credential: boolean;
        settings: Record<string, unknown>;
      }[];
    };
    return {
      pinned_repo: r.pinned_repo,
      config_version: r.config_version,
      targets: r.targets.map((t) => ({
        key: t.key,
        kind: t.kind,
        mode: t.mode,
        has_credential: t.has_credential === true,
        settings: t.settings,
      })),
    };
  },
});

const keyName = z
  .string()
  .min(1)
  .max(64)
  .describe("The key's name, as a project's `builtin:<name>` signing key setting.");

const keyOutput = z.object({
  keyid: z.string().describe("Hex sha256 of the public key (SPKI DER): its stable id."),
  public_key_pem: z.string().describe("The public key, SPKI PEM, Ed25519."),
  created_at: z.string().describe("When the lane sealed the key, as an ISO timestamp."),
});

export const releaseInitKey = defineOp({
  name: "release_init_key",
  summary: "Create the release lane's signing key for an org, inside the lane.",
  description:
    "Generates an Ed25519 signing key INSIDE the release lane and seals it under the release " +
    "master key in the lane's own directory: the private key is never returned, exported, " +
    "logged or audited, and the main process never holds it. Returns the public half only " +
    "(`keyid`, `public_key_pem`, `created_at`): record its fingerprint out of band, then pin it " +
    "where releases are verified. Refuses a name that already exists in the org (it never " +
    "overwrites; rotation is a separate act) and refuses when the lane has no release master " +
    "key. A project signs with it by setting its signing key to `builtin:<name>`. " +
    stepUpNote +
    "Refused when the lane is not configured. Audited with the key id and who. Not an MCP tool.",
  input: z.object({
    target_org: scopeFields.target_org,
    name: keyName,
  }),
  output: keyOutput,
  effect: "write",
  auth: { type: "token", minRole: "owner" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/release-lane/keys" },
  mcp: false,
  outsideTransaction: true,
  auditDetail: (o) => ({ keyid: o.keyid }),
  async handler(ctx, i) {
    requireStepUp(ctx, "release_init_key");
    const { orgId } = await resolveLaneOrg(ctx.db, i);
    const r = await toLane(ctx, "key_init", { orgId }, { name: i.name });
    const k = laneKey.safeParse(r);
    if (!k.success) throw unexpected();
    return {
      keyid: k.data.keyid,
      public_key_pem: k.data.public_key_pem,
      created_at: iso(k.data.created_at)!,
    };
  },
});

export const releasePublicKey = defineOp({
  name: "release_public_key",
  summary: "The public half of an org's release signing key, to pin and verify releases with.",
  description:
    "Returns the public key of the org's release signing key `name`: `keyid`, `public_key_pem` " +
    "(SPKI PEM, Ed25519), `created_at` and `status`. It is public material: anyone who can read " +
    "the org may call it, over REST or MCP, and it is what `turntable verify --pubkey` checks a " +
    "release against. Compare its fingerprint with the one recorded out of band when the key was " +
    "created (release_init_key); never trust it from this response alone. Read-only. Refused when " +
    "the release lane is not configured or has no such key. Rate limited per token (30 reads a " +
    "minute): past that it is refused with rate_limited and a retry_after_seconds.",
  input: z.object({ name: keyName }),
  output: keyOutput.extend({ status: z.enum(["active"]).describe("The key's state.") }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/release/keys/{name}" },
  async handler(ctx, i) {
    // Per token, before the lane is asked: a burst of reads is refused with rate_limited.
    releaseKeyReads.take(principalLabel(ctx.principal), ctx.now());
    let r;
    try {
      r = await toLane(ctx, "key_public", { orgId: ctx.scope.orgId }, { name: i.name });
    } catch (e) {
      if (
        e instanceof OpError &&
        e.code === "invalid_input" &&
        e.message === "no such release key"
      ) {
        throw new OpError("not_found", "no such release key");
      }
      throw e;
    }
    const k = laneKey.safeParse(r);
    if (!k.success) throw unexpected();
    return {
      keyid: k.data.keyid,
      public_key_pem: k.data.public_key_pem,
      created_at: iso(k.data.created_at)!,
      status: "active" as const,
    };
  },
});

/** What the lane answers for a key: checked, so a malformed answer is an error, not a crash. */
const laneKey = z.object({
  keyid: z.string().min(1),
  public_key_pem: z.string().min(1),
  created_at: z.number().int().nonnegative(),
});
const unexpected = (): OpError =>
  new OpError("unavailable", "the release lane gave an unexpected answer", {
    reason: "lane_refused",
  });

const signingFields = {
  signing_key: z
    .string()
    .min(1)
    .max(300)
    .describe(
      "The key reference: `builtin:<name>` (a key in the lane for this org, see release_init_key), `aws-kms:<key>` or `gcp-kms:<key version>`.",
    ),
  signing_environment: z
    .string()
    .max(64)
    .optional()
    .describe("The environment whose approval signing needs (default `release`)."),
  release_refs: z
    .array(z.string().max(220))
    .max(50)
    .optional()
    .describe("The ref patterns that count as a release (default `refs/tags/v*`)."),
};

export const releaseSetProjectSigning = defineOp({
  name: "release_set_project_signing",
  summary:
    "Set how a project signs releases: its signing key, approval environment and ref patterns.",
  description:
    "Sets a project's signing key reference, approval environment and release ref patterns, with " +
    "exactly the validation of `turntable policy set --signing-key --signing-environment " +
    "--release-refs` (the same code) and the same stored settings. A `builtin:<name>` key must " +
    "exist in the release lane for `target_org` (see release_init_key and release_public_key); a " +
    "missing one is refused. Bumps the lane's config version, so a release approved earlier must " +
    "be approved again. " +
    stepUpNote +
    "Refused when the lane is not configured. Audited with the key name, environment and refs " +
    "(nothing secret). Not an MCP tool.",
  input: z.object({
    target_org: scopeFields.target_org,
    target_project: scopeFields.target_project,
    ...signingFields,
  }),
  output: z.object({
    signing_key: z.string(),
    signing_environment: z.string(),
    release_refs: z.array(z.string()),
    config_version: version,
  }),
  effect: "write",
  auth: { type: "token", minRole: "owner" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/release-lane/project-signing" },
  mcp: false,
  outsideTransaction: true,
  async handler(ctx, i) {
    requireStepUp(ctx, "release_set_project_signing");
    try {
      await validateSigningPatch({
        signingKey: i.signing_key,
        ...(i.signing_environment === undefined ? {} : { environment: i.signing_environment }),
        ...(i.release_refs === undefined ? {} : { releaseRefs: i.release_refs }),
      });
    } catch (e) {
      throw new OpError("invalid_input", e instanceof Error ? e.message : String(e));
    }
    const scope = await resolveLaneTarget(ctx.db, i);
    // A project's release policy is its tenant's: the operator org's owner must also own that org.
    await requireOwnerOf(ctx, scope.orgId);
    if (i.signing_key.startsWith("builtin:")) {
      // The lane is asked first: a name it does not hold is refused, and an unreachable lane is too.
      try {
        await toLane(ctx, "key_public", { orgId: scope.orgId }, { name: i.signing_key.slice(8) });
      } catch (e) {
        if (
          e instanceof OpError &&
          e.code === "invalid_input" &&
          e.message === "no such release key"
        ) {
          throw new OpError(
            "invalid_input",
            `no such release key: the lane holds no key named ${i.signing_key.slice(8)} for this org (create it with release_init_key)`,
          );
        }
        throw e;
      }
    }
    // The version is bumped before the write and again after it: an approval made in between is
    // stale either way, and a failure of the first bump changes nothing.
    await toLane(ctx, "signing_changed", { ...scope }, {});
    await setProjectSigning(ctx.db, scope, {
      signingKey: i.signing_key,
      ...(i.signing_environment === undefined ? {} : { environment: i.signing_environment }),
      ...(i.release_refs === undefined ? {} : { releaseRefs: i.release_refs }),
    });
    const bumped = await toLane(ctx, "signing_changed", { ...scope }, {});
    const now = await getProjectSigning(ctx.db, scope);
    return {
      signing_key: now.signingKey ?? i.signing_key,
      signing_environment: now.environment,
      release_refs: now.releaseRefs,
      config_version: Number(bumped.config_version),
    };
  },
});

export const releaseProjectSigning = defineOp({
  name: "release_project_signing",
  summary: "The project's effective release signing settings.",
  description:
    "Returns how this project signs releases, with defaults applied: `signing_key` (the key " +
    "reference, or null when none is set), `keyid` (the hex sha256 of the public key for a " +
    "`builtin:` key the release lane holds; null for any other key, or when the lane cannot be " +
    "asked), `signing_environment` (default `release`) and `release_refs` (default " +
    "`refs/tags/v*`). Nothing secret. Read-only, over REST and MCP. Rate limited per token " +
    "(30 reads a minute): past that it is refused with rate_limited and a retry_after_seconds.",
  input: z.object({}),
  output: z.object({
    signing_key: z.string().nullable(),
    keyid: z.string().nullable(),
    signing_environment: z.string(),
    release_refs: z.array(z.string()),
  }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: false,
  scope: "project",
  http: { method: "GET", path: "/release/signing" },
  async handler(ctx) {
    releaseKeyReads.take(principalLabel(ctx.principal), ctx.now());
    const s = await getProjectSigning(ctx.db, ctx.scope);
    let keyid: string | null = null;
    if (s.signingKey?.startsWith("builtin:") && ctx.releaseConfig) {
      try {
        const r = await toLane(
          ctx,
          "key_public",
          { orgId: ctx.scope.orgId },
          { name: s.signingKey.slice(8) },
        );
        const k = laneKey.safeParse(r);
        if (k.success) keyid = k.data.keyid;
      } catch {
        keyid = null;
      }
    }
    return {
      signing_key: s.signingKey,
      keyid,
      signing_environment: s.environment,
      release_refs: s.releaseRefs,
    };
  },
});

export const releaseKeyShow = defineOp({
  name: "release_key_show",
  summary: "The public half of an org's release signing key, for the operator org's owner.",
  description:
    "Returns `keyid`, `public_key_pem` and `created_at` of the release signing key `name` the lane " +
    "holds for `target_org`: public material only, never the private key. The caller is a " +
    "signed-in owner of the operator org (`org`); no step-up, since nothing changes. Compare the " +
    "key id with the one recorded out of band. Refused when the lane is not configured or holds " +
    "no such key. Not an MCP tool.",
  input: z.object({ target_org: scopeFields.target_org, name: keyName }),
  output: keyOutput,
  effect: "read",
  auth: { type: "token", minRole: "owner" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/release-lane/keys/{name}" },
  mcp: false,
  async handler(ctx, i) {
    const { orgId } = await resolveLaneOrg(ctx.db, i);
    let r;
    try {
      r = await toLane(ctx, "key_public", { orgId }, { name: i.name });
    } catch (e) {
      if (
        e instanceof OpError &&
        e.code === "invalid_input" &&
        e.message === "no such release key"
      ) {
        throw new OpError("not_found", "no such release key");
      }
      throw e;
    }
    const k = laneKey.safeParse(r);
    if (!k.success) throw unexpected();
    return {
      keyid: k.data.keyid,
      public_key_pem: k.data.public_key_pem,
      created_at: iso(k.data.created_at)!,
    };
  },
});

export const releaseSecretStatus = defineOp({
  name: "release_secret_status",
  summary: "Whether a lane secret was set for a project, when and by whom. Never the value.",
  description:
    "Returns whether `release_secret_set` has stored the lane secret `name` for the project, and " +
    "if so when and by whom (from the operator org's audit chain). The value is write-only and " +
    "is not readable by any operation. The caller is a signed-in owner of the operator org " +
    "(`org`); no step-up. Not an MCP tool.",
  input: z.object({
    ...scopeFields,
    name: z.string().min(1).max(128).describe("The lane secret's name."),
  }),
  output: z.object({
    set: z.boolean(),
    set_at: z.string().nullable(),
    set_by: z.string().nullable().describe("The GitHub login of the person who set it."),
  }),
  effect: "read",
  auth: { type: "token", minRole: "owner" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/release-lane/secrets" },
  mcp: false,
  async handler(ctx, i) {
    await resolveLaneTarget(ctx.db, i);
    const rows = await listAuditByOp(
      ctx.db,
      { orgId: ctx.scope.orgId },
      { op: "release_secret_set", outcome: "ok", limit: 200 },
    );
    for (const row of rows) {
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(row.input) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (
        input.name !== i.name ||
        input.target_org !== i.target_org ||
        input.target_project !== i.target_project
      ) {
        continue;
      }
      const who = await getIdentityByUserId(ctx.db, row.principalId);
      return {
        set: true,
        set_at: iso(row.createdAt)!,
        set_by: who?.login ?? "unknown",
      };
    }
    return { set: false, set_at: null, set_by: null };
  },
});

const cosignOutput = z.object({
  name: z.string(),
  key_id: z
    .string()
    .describe("First 16 hex of sha256 over the key's SPKI DER: what a client pins."),
  spki_sha256: z.string().describe("The full sha256 over the key's SPKI DER."),
  signs: z.string(),
  output_name: z.string(),
  format: z.string(),
  manifest: z.boolean(),
});

const cosignName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
  .describe("A short lower-case name for the co-signing key.");

export const releaseCosignKeySet = defineOp({
  name: "release_cosign_key_set",
  summary: "Set a project's co-signing key (a client-pinned public key), in the release lane.",
  description:
    "Declares the PUBLIC key a client pins, in the release lane's own file: the release lane " +
    "refuses to sign or publish a release unless the request carries a valid co-signature by it " +
    "over `signs` (a file in the release, by its path in the artifact). With " +
    "`manifest_binaries: true` the signed file is a JSON manifest `{ version, signing_key_id, " +
    "binaries: { <platform>: { filename, sha256 } } }` and the key must also sign every listed " +
    "binary (`<filename>.sig`). Only a public key is accepted; a private key is refused. Replaces " +
    "a key of the same name. Bumps the lane's config version, so a release approved earlier must " +
    "be approved again. " +
    stepUpNote +
    "Audited with the key's fingerprint and name, never the key. Refused when the lane is not " +
    "configured. Not an MCP tool.",
  input: z.object({
    ...scopeFields,
    name: cosignName,
    public_key_pem: z.string().min(1).max(4096).describe("The public key, SPKI PEM (ECDSA P-256)."),
    signs: z
      .string()
      .min(1)
      .max(200)
      .describe("The file in the release the key signs, by its path in the artifact."),
    output_name: z
      .string()
      .min(1)
      .max(200)
      .describe("The release asset name of the signature (a plain name)."),
    format: z.string().max(64).default("detached-der-p256-sha256"),
    manifest_binaries: z
      .boolean()
      .optional()
      .describe("The signed file is a manifest with a `binaries` map, each binary co-signed too."),
  }),
  output: cosignOutput.extend({ config_version: version }),
  effect: "write",
  auth: { type: "token", minRole: "owner" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/release-lane/cosign-keys" },
  mcp: false,
  outsideTransaction: true,
  logOmitFields: ["public_key_pem"],
  auditDetail: (o) => ({ key_id: o.key_id, spki_sha256: o.spki_sha256 }),
  async handler(ctx, i) {
    requireStepUp(ctx, "release_cosign_key_set");
    // A private key never travels: refused here before anything is sent. Everything else (the
    // key's type, the format, the names) is validated by the lane, which stores it.
    if (i.public_key_pem.includes("PRIVATE"))
      throw new OpError("invalid_input", "only a public key may be set");
    const scope = await resolveLaneTarget(ctx.db, i);
    const r = await toLane(ctx, "cosign_set", scope, {
      key: {
        name: i.name,
        public_key_pem: i.public_key_pem,
        signs: i.signs,
        output_name: i.output_name,
        format: i.format,
        ...(i.manifest_binaries ? { manifest: { shape: "binaries-map" } } : {}),
      },
    });
    const k = cosignOutput.safeParse(r.key);
    if (!k.success) throw unexpected();
    return { ...k.data, config_version: Number(r.config_version) };
  },
});

export const releaseCosignKeyRemove = defineOp({
  name: "release_cosign_key_remove",
  summary: "Remove a project's co-signing key, in the release lane.",
  description:
    "Removes one co-signing key of a project from the release lane's own file. Bumps the lane's " +
    "config version (a release approved earlier must be approved again). " +
    stepUpNote +
    "Audited with the key's name. Refused when the lane is not configured. Not an MCP tool.",
  input: z.object({ ...scopeFields, name: cosignName }),
  output: z.object({ removed: z.boolean(), config_version: version }),
  effect: "destructive",
  auth: { type: "token", minRole: "owner" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/release-lane/cosign-keys/delete" },
  mcp: false,
  outsideTransaction: true,
  async handler(ctx, i) {
    requireStepUp(ctx, "release_cosign_key_remove");
    const scope = await resolveLaneTarget(ctx.db, i);
    const r = await toLane(ctx, "cosign_remove", scope, { name: i.name });
    return { removed: r.removed === true, config_version: Number(r.config_version) };
  },
});

export const releaseCosignKeyList = defineOp({
  name: "release_cosign_key_list",
  summary: "A project's co-signing keys, by fingerprint.",
  description:
    "Returns each co-signing key of a project as the release lane's file holds it: name, key id, " +
    "SPKI fingerprint, what it signs and the signature's asset name. Public information only, no " +
    "key material. The project must belong to `target_org`. Read-only, no step-up. Refused when " +
    "the lane is not configured. Not an MCP tool.",
  input: z.object({ ...scopeFields }),
  output: z.object({ keys: z.array(cosignOutput), config_version: version }),
  effect: "read",
  auth: { type: "token", minRole: "owner" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/release-lane/cosign-keys" },
  mcp: false,
  async handler(ctx, i) {
    const scope = await resolveLaneTarget(ctx.db, i);
    const r = await toLane(ctx, "cosign_list", scope, {});
    const keys = z.array(cosignOutput).safeParse(r.keys);
    if (!keys.success) throw unexpected();
    return { keys: keys.data, config_version: Number(r.config_version) };
  },
});
