// Release lane configuration for instances with no shell (#541): the instance administrator sets
// the pinned repository, the publish targets and the lane's secrets through REST, for a project of
// an org. Nothing here writes the main database: each change is a signed message over the release
// channel to the lane, which writes its own file (and, for a secret, its own vault view). The
// lane is not configured here: without its config channel every op is refused.
//
// A write needs the administrator's `tti_` token AND a fresh passkey step-up from an approver
// enrolled in the org the call names, bound to the op and the exact input (see
// ../instance-step-up.ts). None of these is an MCP tool.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { countOpenChallenges, insertChallenge, purgeExpiredChallenges } from "../../db/repos";
import type { ConfigAction } from "../../release/channel";
import { buildTarget, validateRepo, validateTargetKey } from "../../release/config";
import { LaneConfigError } from "../../release/config";
import { SECRET_NAME } from "../../release/publish/types";
import { iso } from "../common";
import { defineOp, type Op, type OpContext } from "../define";
import { OpError } from "../errors";
import { resolveLaneTarget } from "../instance-step-up";
import {
  inputTarget,
  instanceStepUpKeys,
  INSTANCE_STEP_UP_OPS,
  STEP_UP_KIND,
  STEP_UP_TTL_MS,
  stepUpChallengeOf,
  stepUpHash,
  stepUpHolder,
} from "../step-up";

const MAX_OPEN_STEP_UPS = 10;

const scopeFields = {
  target_org: z.string().min(1).max(64).describe("Slug of the org that owns the project."),
  target_project: z
    .string()
    .min(1)
    .max(64)
    .describe("Slug of the project, looked up inside that org."),
};

const stepUpNote =
  "Needs the instance administrator's token AND a fresh passkey step-up from an approver enrolled " +
  "in `target_org`: call instance_step_up_challenge for this exact input, sign its challenge with " +
  "the passkey, and send the assertion as `step_up` beside the input. The step-up is bound to this " +
  "op and input, single-use, and lasts 5 minutes. ";

/** Sends one message to the lane, or refuses with the reason. Never echoes an input value. */
async function toLane(
  ctx: OpContext,
  action: ConfigAction,
  scope: { orgId: string; projectId: string },
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
  if (ctx.principal.kind !== "instance" || ctx.stepUp?.action !== name) {
    throw new OpError("forbidden", `${name} needs a fresh passkey step-up`, {
      reason: "step_up_required",
    });
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
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/release/pin-repo" },
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
  artifact: z.string().max(200).optional().describe("npm: the tarball artifact."),
  secret: z
    .string()
    .max(128)
    .optional()
    .describe(
      "npm and oci-image: the NAME of the lane secret (see release_secret_set), never a value.",
    ),
  tag: z.string().max(64).optional().describe("npm: the dist-tag (default latest)."),
  access: z.enum(["public", "restricted"]).optional().describe("npm: access."),
  assets: z.array(z.string().max(200)).max(50).optional().describe("github-release: the assets."),
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
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/release/publish-targets" },
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
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/release/publish-targets/delete" },
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
    "(`value_sha256`, see instance_step_up_challenge), so the approver's device never sees it. " +
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
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/release/secrets" },
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
  input: z.object(scopeFields),
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
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/instance/release/publish-targets" },
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

/** The ops a step-up may be started for, by name: the schema their input is judged with. */
const STEP_UP_OPS: Record<string, Op> = {};
for (const op of [
  releasePinRepo,
  releasePublishTargetSet,
  releasePublishTargetDelete,
  releaseSecretSet,
]) {
  STEP_UP_OPS[op.name] = op;
}

const SHA256 = /^[0-9a-f]{64}$/;

export const instanceStepUpChallenge = defineOp({
  name: "instance_step_up_challenge",
  summary: "Start a passkey step-up for one release lane configuration change.",
  description:
    "Names a release lane configuration op (release_pin_repo, release_publish_target_set, " +
    "release_publish_target_delete or release_secret_set) and the exact `input` it will be called " +
    "with, and returns a single-use WebAuthn challenge. For release_secret_set send " +
    "`value_sha256` in place of `value`: sha256 of `turntable.step_up.secret.v1`, a NUL byte, the " +
    "field name (`value`), a NUL byte and the value, in hex; the value itself never goes here and " +
    "the approver's device never sees it. A passkey enrolled as an approver in `target_org` signs " +
    "`challenge`; the configuration call then carries `step_up: {id, approver, signature}` (the " +
    "assertion's credential_id, client_data_json, authenticator_data and signature) beside its " +
    "input. The step-up is bound to the instance token, the op and a hash of that exact input, " +
    "so it authorizes no other op and no other parameters, can be used once, and lasts 5 " +
    "minutes. Issuing a challenge changes nothing else. Audited. Not an MCP tool.",
  input: z.object({
    action: z.string().min(1).max(64).describe("The release_* op the step-up is for."),
    input: z
      .record(z.string(), z.unknown())
      .describe("The exact input that op will be called with (`value_sha256` for a secret value)."),
  }),
  output: z.object({
    step_up_id: z.string(),
    challenge: z.string().describe("base64url: the WebAuthn challenge to sign."),
    rp_id: z.string(),
    passkeys: z.array(z.object({ approver: z.string(), passkey_id: z.string() })),
    expires_at: z.string(),
  }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/step-up" },
  mcp: false,
  async handler(ctx, i) {
    const p = ctx.principal;
    if (p.kind !== "instance") throw new OpError("forbidden", "step-up is for the instance token");
    if (!ctx.webauthn) {
      throw new OpError("unavailable", "WebAuthn is not configured on this server");
    }
    const op = STEP_UP_OPS[i.action];
    if (!op || !INSTANCE_STEP_UP_OPS.has(i.action)) {
      throw new OpError("invalid_input", `${i.action} does not take a step-up`);
    }
    // Judge the input as the op will: a secret value is not here, so a placeholder stands in for
    // validation, and its digest (given by the caller) is what gets bound.
    const given: Record<string, unknown> = { ...i.input };
    const digests: Record<string, string> = {};
    for (const f of op.secretInputFields) {
      const d = given[`${f}_sha256`];
      if (f in given || typeof d !== "string" || !SHA256.test(d)) {
        throw new OpError(
          "invalid_input",
          `send ${f}_sha256 (sha256 hex of the value) instead of ${f}: the value never goes into a step-up`,
        );
      }
      digests[`${f}_sha256`] = d;
      delete given[`${f}_sha256`];
      given[f] = "x";
    }
    const parsed = op.input.safeParse(given);
    if (!parsed.success) {
      throw new OpError("invalid_input", "input does not match that op's schema");
    }
    const validated = { ...(parsed.data as Record<string, unknown>) };
    for (const f of op.secretInputFields) delete validated[f];
    const { orgId, projectId } = await resolveLaneTarget(ctx.db, validated);
    const keys = await instanceStepUpKeys(ctx.db, orgId);
    if (keys.length === 0) {
      throw new OpError(
        "conflict",
        "no passkey is enrolled as an approver in that org (or none satisfies the org's key policy)",
      );
    }
    const now = ctx.now();
    const holder = stepUpHolder("instance", p.id);
    await purgeExpiredChallenges(ctx.db, orgId, now);
    if ((await countOpenChallenges(ctx.db, orgId, holder, now)) >= MAX_OPEN_STEP_UPS) {
      throw new OpError("conflict", "too many open step-ups: use or wait out the others");
    }
    const nonce = randomBytes(24).toString("base64url");
    const expiresAt = now + STEP_UP_TTL_MS;
    const hash = stepUpHash({
      orgId,
      sessionHash: `instance:${p.id}`,
      userId: p.id,
      action: i.action,
      target: inputTarget({ ...validated, ...digests }, projectId),
      nonce,
      expiresAt,
    });
    await insertChallenge(ctx.db, orgId, {
      id: nonce,
      kind: STEP_UP_KIND,
      statementHash: hash,
      principal: holder,
      expiresAt,
    });
    return {
      step_up_id: nonce,
      challenge: stepUpChallengeOf(hash),
      rp_id: ctx.webauthn.rpId,
      passkeys: keys.map((k) => ({ approver: k.id, passkey_id: k.credentialId })),
      expires_at: iso(expiresAt)!,
    };
  },
});
