// The challenge half of passkey step-up for web sessions (#430, slice 2). See ../step-up.ts.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  countOpenChallenges,
  getOrgById,
  getOrgBySlug,
  getProjectBySlug,
  insertChallenge,
  purgeExpiredChallenges,
} from "../../db/repos";
import { iso } from "../common";
import { defineOp } from "../define";
import { OpError } from "../errors";
import {
  inputTarget,
  SESSION_STEP_UP_OPS,
  STEP_UP_KIND,
  STEP_UP_TTL_MS,
  stepUpChallengeOf,
  stepUpHash,
  stepUpKeys,
} from "../step-up";
import {
  instanceReplaceAppPrivateKeyOp,
  instanceRotateWebhookSecretOp,
} from "./instance-app-secrets";
import { createApiToken } from "./create-api-token";
import { inviteMemberOp } from "./members";
import { setSettingOp } from "./settings";
import {
  releaseInitKey,
  releasePinRepo,
  releasePublishTargetDelete,
  releasePublishTargetSet,
  releaseSecretSet,
  releaseSetProjectSigning,
} from "./release-config";
import type { Op } from "../define";
import { resolveLaneOrg, resolveLaneTarget } from "../lane-target";

const MAX_OPEN_STEP_UPS = 10;

/** The schema each step-up action validates its input with, exactly as the dispatcher does. */
const SCHEMAS: Record<string, z.ZodObject> = {
  create_api_token: createApiToken.input,
  invite_member: inviteMemberOp.input,
  set_setting: setSettingOp.input,
  instance_rotate_webhook_secret: instanceRotateWebhookSecretOp.input,
  instance_replace_app_private_key: instanceReplaceAppPrivateKeyOp.input,
};
/** The lane configuration ops (#541), whose schemas and secret fields the challenge honours too. */
const LANE_OPS: Record<string, Op> = {};
for (const op of [
  releasePinRepo,
  releasePublishTargetSet,
  releasePublishTargetDelete,
  releaseSecretSet,
  releaseInitKey,
  releaseSetProjectSigning,
]) {
  LANE_OPS[op.name] = op;
  SCHEMAS[op.name] = op.input as z.ZodObject;
}
const SHA256 = /^[0-9a-f]{64}$/;

export const sessionStepUpChallenge = defineOp({
  name: "session_step_up_challenge",
  summary: "Start a passkey step-up for one sensitive action from a web session.",
  description:
    "Web sessions only. Names an action (create_api_token, invite_member for an admin or " +
    "owner, set_setting to loosen a trust setting, or, for an owner of the operator org, instance_rotate_webhook_secret or instance_replace_app_private_key) and the exact `input` the action will be called with (project scope included), and " +
    "returns a single-use WebAuthn challenge. The signed-in person's own enrolled passkey signs " +
    "`challenge`; the sensitive call then carries `step_up: {id, approver, signature}` (the " +
    "assertion's credential_id, client_data_json, authenticator_data and signature). The step-up " +
    "is bound to the action and to a hash of that exact input, so it authorizes no other action " +
    "and no other parameters, can be used once, and lasts 5 minutes. Needs a passkey enrolled for " +
    "this person in the org (an approver key under their GitHub login that satisfies the org's " +
    "key policy). Issuing a challenge changes nothing else. Audited. Not an MCP tool.",
  input: z.object({
    action: z.string().min(1).max(64).describe("create_api_token, invite_member or set_setting."),
    input: z
      .record(z.string(), z.unknown())
      .describe("The exact input the action will be called with, `org` and `project` included."),
  }),
  output: z.object({
    step_up_id: z.string(),
    challenge: z.string().describe("base64url: the WebAuthn challenge to sign."),
    rp_id: z.string(),
    passkeys: z.array(z.object({ approver: z.string(), passkey_id: z.string() })),
    expires_at: z.string(),
  }),
  effect: "write",
  auth: { type: "token", minRole: "viewer" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/session/step-up" },
  mcp: false,
  // The action input can carry a secret (the App private key): the audit keeps the action name only.
  logOmitFields: ["input"],
  async handler(ctx, i) {
    const p = ctx.principal;
    if (p.kind !== "session" || !p.sessionHash) {
      throw new OpError("forbidden", "step-up is for web sessions");
    }
    if (!ctx.webauthn) {
      throw new OpError("unavailable", "WebAuthn is not configured on this server");
    }
    const schema = SCHEMAS[i.action];
    if (!schema || !SESSION_STEP_UP_OPS.has(i.action)) {
      throw new OpError("invalid_input", `${i.action} does not take a step-up`);
    }
    // A lane op is for an owner of the operator org alone: refused here before a challenge exists.
    const lane = LANE_OPS[i.action];
    if (lane) {
      const operator = await getOrgBySlug(ctx.db, ctx.operatorOrgSlug ?? "local");
      if (!operator || operator.id !== ctx.scope.orgId || p.role !== "owner") {
        throw new OpError(
          "forbidden",
          `${i.action} is for a signed-in owner of the operator org, in the web app`,
          { reason: "lane_operator_owner_only" },
        );
      }
    }
    // A secret value is not here: its digest (`value_sha256`) is, and a placeholder stands in for
    // the value to judge the rest of the input as the op will.
    const given: Record<string, unknown> = { ...i.input };
    const digests: Record<string, string> = {};
    for (const f of lane?.secretInputFields ?? []) {
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
    const parsed = schema.safeParse(given);
    if (!parsed.success) {
      throw new OpError("invalid_input", "input does not match that action's schema");
    }
    // Scope the way the dispatcher does: `org` and `project` leave the input and name the scope.
    const { org, project, ...restAll } = parsed.data as Record<string, unknown>;
    const rest = { ...restAll };
    for (const f of lane?.secretInputFields ?? []) delete rest[f];
    // The target org and project must exist as a pair, as the op itself will resolve them.
    if (lane) {
      if (lane.name === "release_init_key") await resolveLaneOrg(ctx.db, rest);
      else await resolveLaneTarget(ctx.db, rest);
    }
    if (org !== undefined) {
      const o = await getOrgById(ctx.db, ctx.scope.orgId);
      if (!o || o.slug !== org) throw new OpError("not_found", "org or project not found");
    }
    let projectId: string | undefined;
    if (project !== undefined) {
      const pr = await getProjectBySlug(ctx.db, { orgId: ctx.scope.orgId }, String(project));
      if (!pr) throw new OpError("not_found", "org or project not found");
      projectId = pr.id;
    }
    const { keys, legacy } = await stepUpKeys(ctx.db, ctx.scope.orgId, p.id);
    if (keys.length === 0 && legacy > 0) {
      throw new OpError(
        "forbidden",
        "no passkey of yours has a recorded GitHub account id: re-enrol this passkey (step_up_reenrol)",
        { reason: "step_up_reenrol" },
      );
    }
    if (keys.length === 0) {
      throw new OpError(
        "conflict",
        "no passkey is enrolled for you in this org (or none satisfies the org's key policy)",
      );
    }
    const now = ctx.now();
    const principal = `session:${p.id}`;
    await purgeExpiredChallenges(ctx.db, ctx.scope.orgId, now);
    if ((await countOpenChallenges(ctx.db, ctx.scope.orgId, principal, now)) >= MAX_OPEN_STEP_UPS) {
      throw new OpError("conflict", "too many open step-ups: use or wait out the others");
    }
    const nonce = randomBytes(24).toString("base64url");
    const expiresAt = now + STEP_UP_TTL_MS;
    const hash = stepUpHash({
      orgId: ctx.scope.orgId,
      sessionHash: p.sessionHash,
      userId: p.id,
      action: i.action,
      target: inputTarget({ ...rest, ...digests }, projectId),
      nonce,
      expiresAt,
    });
    await insertChallenge(ctx.db, ctx.scope.orgId, {
      id: nonce,
      kind: STEP_UP_KIND,
      statementHash: hash,
      principal,
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
