// Passkey step-up for web sessions (#430). A session is refused every write the dispatcher does
// not name. A few sensitive writes are opened to it ONLY with a fresh WebAuthn assertion by the
// signed-in person's own passkey, bound to one action (and its target), single-use, and at most
// 5 minutes old. Nothing is stored beyond a row in approval_challenges (kind `step_up`).
//
// Flow: `session_step_up_challenge {action, target?}` stores a challenge row whose statement hash
// binds {org, session, user, action, target, nonce, expiry}. The person's passkey signs the
// challenge. The gated call carries `step_up: {id, approver, signature}`; the dispatcher
// recomputes the hash for THIS call's action and target, verifies the assertion, and spends the
// row atomically before the handler runs. Every refusal is a classified `forbidden`.
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../audit/chain";
import { keyPolicyViolation } from "../approvals/key-policy";
import { verifyAssertion, WebAuthnError, type RelyingParty } from "../approvals/webauthn";
import type { Db } from "../db";
import {
  consumeChallenge,
  getApprover,
  getChallenge,
  getIdentityByUserId,
  getKeyPolicy,
  listApprovers,
  setSignCount,
} from "../db/repos";
import { OpError } from "./errors";

/** A step-up challenge, and so the assertion that answers it, lives at most this long. */
export const STEP_UP_TTL_MS = 5 * 60_000;
/** The `approval_challenges.kind` of a step-up. */
export const STEP_UP_KIND = "step_up";
export const STEP_UP_STATEMENT_TYPE = "turntable.session_step_up.v1";

/** Why a step-up was refused: the `details.reason` of the `forbidden` error. */
export type StepUpReason =
  | "step_up_required"
  | "step_up_unknown"
  | "step_up_expired"
  | "step_up_reused"
  | "step_up_wrong_action"
  | "step_up_bad_key"
  | "step_up_reenrol"
  | "step_up_bad_assertion"
  | "step_up_unavailable";

const refuse = (reason: StepUpReason, message: string): OpError =>
  new OpError("forbidden", `${message} (${reason})`, { reason });

/** What the gated call carries to prove the step-up. The assertion is a WebAuthn `get` result. */
export const stepUpInputSchema = z
  .strictObject({
    id: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    approver: z.string().min(1).max(64),
    signature: z.strictObject({
      credential_id: z.string().regex(/^[A-Za-z0-9_-]{1,8192}$/),
      client_data_json: z.string().regex(/^[A-Za-z0-9_-]{1,8192}$/),
      authenticator_data: z.string().regex(/^[A-Za-z0-9_-]{1,8192}$/),
      signature: z.string().regex(/^[A-Za-z0-9_-]{1,8192}$/),
    }),
  })
  .describe(
    "Web sessions only: a fresh passkey assertion from session_step_up_challenge, for exactly this action.",
  );
export type StepUpInput = z.infer<typeof stepUpInputSchema>;

/**
 * The ops a session may call with a step-up. The step-up binds the op name AND a hash of its
 * exact validated input and project scope (`inputTarget`), so a step-up for one request cannot
 * authorize a different one of the same op (a reader token's step-up never mints a
 * release_operator token).
 */
export const SESSION_STEP_UP_OPS: ReadonlySet<string> = new Set([
  "create_api_token",
  "create_user_token",
  "invite_member",
]);

/** The target a step-up binds for a call: sha256 of the canonical validated input plus project scope. */
export function inputTarget(input: Record<string, unknown>, projectId: string | undefined): string {
  return createHash("sha256")
    .update(canonicalJson({ input, project: projectId ?? null }), "utf8")
    .digest("hex");
}

type Binding = {
  orgId: string;
  sessionHash: string;
  userId: string;
  action: string;
  target: string | undefined;
  nonce: string;
  expiresAt: number;
};

/** The statement a step-up binds: its hash is both the stored hash and the WebAuthn challenge. */
export function stepUpHash(b: Binding): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        type: STEP_UP_STATEMENT_TYPE,
        org: b.orgId,
        session: b.sessionHash,
        user: b.userId,
        action: b.action,
        target: b.target ?? "",
        nonce: b.nonce,
        expires_at: b.expiresAt,
      }),
      "utf8",
    )
    .digest("hex");
}

export const stepUpChallengeOf = (hashHex: string): string =>
  Buffer.from(hashHex, "hex").toString("base64url");

/**
 * The passkeys this person may step up with in this org: WebAuthn keys enrolled for THEIR numeric
 * GitHub id, live, and within the key policy. The forge login is display text here: only the id
 * counts. A key with no recorded id never qualifies (`legacy`: it must be re-enrolled).
 */
export async function stepUpKeys(
  db: Db,
  orgId: string,
  userId: string,
): Promise<{ keys: { id: string; credentialId: string }[]; legacy: number }> {
  const identity = await getIdentityByUserId(db, userId);
  if (!identity) return { keys: [], legacy: 0 };
  const policy = await getKeyPolicy(db, orgId);
  const live = (await listApprovers(db, orgId)).filter(
    (k) =>
      k.kind === "webauthn" && k.credentialId !== null && keyPolicyViolation(policy, k) === null,
  );
  return {
    keys: live
      .filter((k) => k.githubUserId !== null && k.githubUserId === identity.githubUserId)
      .map((k) => ({ id: k.id, credentialId: k.credentialId! })),
    legacy: live.filter((k) => k.githubUserId === null).length,
  };
}

export type VerifiedStepUp = { action: string; target: string | undefined };

/**
 * Verifies the step-up a session call carries, for exactly `action` and `target`, and spends it.
 * Throws a classified `forbidden` on any failure; nothing is spent unless the assertion verified.
 */
export async function verifyStepUp(
  o: {
    db: Db;
    rp: RelyingParty | undefined;
    now: number;
    orgId: string;
    sessionHash: string | undefined;
    userId: string;
    action: string;
    target: string | undefined;
  },
  raw: unknown,
): Promise<VerifiedStepUp> {
  if (!o.sessionHash) throw refuse("step_up_unavailable", "this session cannot step up");
  if (!o.rp) throw refuse("step_up_unavailable", "WebAuthn is not configured on this server");
  const parsed = stepUpInputSchema.safeParse(raw);
  if (!parsed.success) throw new OpError("invalid_input", "step_up is malformed");
  const su = parsed.data;
  const row = await getChallenge(o.db, o.orgId, su.id);
  // Not ours (another kind, another person's session): the same answer as an unknown id.
  if (!row || row.kind !== STEP_UP_KIND || row.principal !== `session:${o.userId}`) {
    throw refuse("step_up_unknown", "no such step-up");
  }
  if (row.usedAt !== null) throw refuse("step_up_reused", "that step-up was already used");
  if (row.expiresAt <= o.now) throw refuse("step_up_expired", "that step-up has expired");
  const hash = stepUpHash({
    orgId: o.orgId,
    sessionHash: o.sessionHash,
    userId: o.userId,
    action: o.action,
    target: o.target,
    nonce: row.id,
    expiresAt: row.expiresAt,
  });
  if (hash !== row.statementHash) {
    throw refuse("step_up_wrong_action", "that step-up was issued for a different action");
  }
  const key = await getApprover(o.db, o.orgId, su.approver);
  // A key with no numeric id can never satisfy a step-up, whatever its login says.
  if (key && key.revokedAt === null && key.githubUserId === null) {
    throw refuse("step_up_reenrol", "that passkey has no GitHub account id: re-enrol this passkey");
  }
  const allowed = (await stepUpKeys(o.db, o.orgId, o.userId)).keys.some(
    (k) => k.id === su.approver,
  );
  if (
    !key ||
    key.revokedAt !== null ||
    key.kind !== "webauthn" ||
    !allowed ||
    key.credentialId !== su.signature.credential_id
  ) {
    throw refuse("step_up_bad_key", "that passkey cannot step this session up");
  }
  let signCount: number;
  try {
    ({ signCount } = verifyAssertion(
      {
        credentialId: su.signature.credential_id,
        clientDataJSON: su.signature.client_data_json,
        authenticatorData: su.signature.authenticator_data,
        signature: su.signature.signature,
      },
      { publicKey: key.publicKey, alg: key.alg, signCount: key.signCount },
      { challenge: stepUpChallengeOf(hash), rp: o.rp },
    ));
  } catch (e) {
    if (e instanceof WebAuthnError) throw refuse("step_up_bad_assertion", e.message);
    throw e;
  }
  // Spend it first: a lost race is a reuse. The counter follows only a spent step-up.
  const spent = await consumeChallenge(o.db, o.orgId, {
    id: row.id,
    kind: STEP_UP_KIND,
    statementHash: hash,
    now: o.now,
  });
  if (!spent) throw refuse("step_up_reused", "that step-up was already used");
  await setSignCount(o.db, o.orgId, key.id, signCount);
  return { action: o.action, target: o.target };
}
