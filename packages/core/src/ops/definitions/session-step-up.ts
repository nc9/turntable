// The challenge half of passkey step-up for web sessions (#430, slice 2). See ../step-up.ts.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  countOpenChallenges,
  getOrgById,
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
import { createApiToken } from "./create-api-token";
import { createUserToken } from "./user-tokens";
import { inviteMemberOp } from "./members";

const MAX_OPEN_STEP_UPS = 10;

/** The schema each step-up action validates its input with, exactly as the dispatcher does. */
const SCHEMAS: Record<string, z.ZodObject> = {
  create_api_token: createApiToken.input,
  create_user_token: createUserToken.input,
  invite_member: inviteMemberOp.input,
};

export const sessionStepUpChallenge = defineOp({
  name: "session_step_up_challenge",
  summary: "Start a passkey step-up for one sensitive action from a web session.",
  description:
    "Web sessions only. Names an action (create_api_token, create_user_token, or invite_member for an admin or " +
    "owner) and the exact `input` the action will be called with (project scope included), and " +
    "returns a single-use WebAuthn challenge. The signed-in person's own enrolled passkey signs " +
    "`challenge`; the sensitive call then carries `step_up: {id, approver, signature}` (the " +
    "assertion's credential_id, client_data_json, authenticator_data and signature). The step-up " +
    "is bound to the action and to a hash of that exact input, so it authorizes no other action " +
    "and no other parameters, can be used once, and lasts 5 minutes. Needs a passkey enrolled for " +
    "this person in the org (an approver key under their GitHub login that satisfies the org's " +
    "key policy). Issuing a challenge changes nothing else. Audited. Not an MCP tool.",
  input: z.object({
    action: z.string().min(1).max(64).describe("create_api_token or invite_member."),
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
    const parsed = schema.safeParse(i.input);
    if (!parsed.success) {
      throw new OpError("invalid_input", "input does not match that action's schema");
    }
    // Scope the way the dispatcher does: `org` and `project` leave the input and name the scope.
    const { org, project, ...rest } = parsed.data as Record<string, unknown>;
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
      target: inputTarget(rest, projectId),
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
