// The approval statement: what a human signs. Canonical JSON (sorted keys, no whitespace) over
// fixed fields, with a `type` for domain separation so a signature over one kind of statement
// can never be replayed as another. The hash of the canonical text is the WebAuthn challenge, and
// the canonical text itself is what an offline ed25519 key signs.
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../audit/chain";

export const ENV_STATEMENT_TYPE = "longshore.approve_environment.v1";
/** New statement types use the new name; only the frozen types above stay `longshore.*`. */
export const RUN_STATEMENT_TYPE = "turntable.approve_run.v1";
/**
 * A release environment's approval (#424). It binds the digest of the artifact set that will be
 * signed (`manifest_sha256`, see release/manifest.ts), so the human approves the release contents.
 * `longshore.approve_environment.v1` is refused for a release environment.
 */
export const RELEASE_STATEMENT_TYPE = "turntable.approve_release.v2";
export const ENROL_STATEMENT_TYPE = "longshore.approve_enrolment.v1";

/** A statement is valid for at most this long after it is checked. */
export const MAX_STATEMENT_TTL_MS = 7 * 24 * 3600_000;
/** How long a server-issued challenge (and the nonce in its statement) lives. */
export const CHALLENGE_TTL_MS = 10 * 60_000;
/** A run approval statement is valid for at most this long: it is signed and spent in one sitting. */
export const MAX_RUN_STATEMENT_TTL_MS = 10 * 60_000;

const hex = (min: number, max: number) => z.string().regex(new RegExp(`^[0-9a-f]{${min},${max}}$`));
const nonce = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
const slug = z.string().min(1).max(64);

export const envStatementSchema = z.strictObject({
  type: z.literal(ENV_STATEMENT_TYPE),
  org: slug,
  project: slug,
  run_id: z.string().min(1).max(64),
  head_sha: hex(40, 64),
  workflow_hash: hex(64, 64),
  environment: z.string().min(1).max(100),
  /** The enrolled approver's id: the key that signs. */
  approver: z.string().min(1).max(64),
  /** Epoch milliseconds. */
  expires_at: z.int().positive(),
  nonce,
});
export type EnvStatement = z.infer<typeof envStatementSchema>;

export const releaseStatementSchema = z.strictObject({
  type: z.literal(RELEASE_STATEMENT_TYPE),
  org: slug,
  project: slug,
  run_id: z.string().min(1).max(64),
  head_sha: hex(40, 64),
  workflow_hash: hex(64, 64),
  environment: z.string().min(1).max(100),
  /** sha256 hex of the canonical manifest of the artifacts the release lane will sign. */
  manifest_sha256: hex(64, 64),
  /**
   * The release lane's configuration version when the challenge was issued (the server reads it
   * from the lane). The approver signs over the pin, targets and secrets they saw: the lane
   * refuses to sign or publish when its version has moved since. Required: a statement without it
   * is not a valid v2 statement.
   */
  lane_config_version: z.int().min(0),
  approver: z.string().min(1).max(64),
  expires_at: z.int().positive(),
  /** The single-use challenge id. */
  nonce,
});
export type ReleaseStatement = z.infer<typeof releaseStatementSchema>;

/**
 * A person's approval of one run held for an untrusted author (#324). It binds the run, the commit
 * and workflow they read, and the trust class they approved, so it cannot be spent on another.
 */
export const runStatementSchema = z.strictObject({
  type: z.literal(RUN_STATEMENT_TYPE),
  org: slug,
  project: slug,
  run_id: z.string().min(1).max(64),
  head_sha: hex(40, 64),
  workflow_hash: hex(64, 64),
  /** The trust class of the run when the statement was issued (`untrusted_pr`, `release`...). */
  trust_class: z.string().min(1).max(40),
  approver: z.string().min(1).max(64),
  expires_at: z.int().positive(),
  nonce,
});
export type RunStatement = z.infer<typeof runStatementSchema>;

export const enrolStatementSchema = z.strictObject({
  type: z.literal(ENROL_STATEMENT_TYPE),
  org: slug,
  enrolment_id: z.string().min(1).max(64),
  person: z.string().min(1).max(200),
  /** The forge login the key is enrolled under, lower-cased: what the approvers sign off on. */
  forge_login: z.string().min(1).max(100),
  /** sha256 hex over the key being enrolled (see keyFingerprint). */
  key_fingerprint: hex(64, 64),
  approver: z.string().min(1).max(64),
  expires_at: z.int().positive(),
  nonce,
});
export type EnrolStatement = z.infer<typeof enrolStatementSchema>;

export const POLICY_STATEMENT_TYPE = "longshore.approve_key_policy.v1";

const keyPolicyShape = z.strictObject({
  mode: z.enum(["any", "hardware"]),
  presets: z.array(z.string().max(40)).max(10),
  aaguids: z.array(z.string().max(40)).max(200),
});

/**
 * A change of the org's key policy. It names the policy being replaced and the one that replaces
 * it, plus a hash of the AAGUID allowlist the new policy expands to, so the signers approve exactly
 * this change against exactly this state, and it cannot be replayed after the policy moved on.
 */
export const policyStatementSchema = z.strictObject({
  type: z.literal(POLICY_STATEMENT_TYPE),
  org: slug,
  /** The policy's change counter when the statement was issued: it cannot be replayed later. */
  generation: z.int().min(0),
  old: keyPolicyShape,
  new: keyPolicyShape,
  /** sha256 hex over the new policy's effective AAGUID set (sorted, newline-joined). */
  allowlist_hash: hex(64, 64),
  approver: z.string().min(1).max(64),
  expires_at: z.int().positive(),
  nonce,
});
export type PolicyStatement = z.infer<typeof policyStatementSchema>;

/** The same change, whoever signs it: what the signers of one proposal have in common. */
export const policyDigest = (s: PolicyStatement): string =>
  createHash("sha256")
    .update(
      canonicalJson({
        org: s.org,
        generation: s.generation,
        old: s.old,
        new: s.new,
        allowlist_hash: s.allowlist_hash,
      }),
      "utf8",
    )
    .digest("hex");

export const APPROVAL_POLICY_STATEMENT_TYPE = "turntable.approve_approval_policy.v1";

/** One environment's effective approval policy, as a statement binds it. */
const approvalPolicyShape = z.strictObject({
  /** False for an environment with no entry that is ungated by default. */
  gated: z.boolean(),
  required: z.int().min(1).max(10),
  allow_author_approval: z.boolean(),
  key_policy: z.enum(["any", "hardware"]),
});
export type ApprovalPolicyShape = z.infer<typeof approvalPolicyShape>;

/**
 * A loosening of one environment's `approval_policy` (#664). It names the org, the environment,
 * the effective policy being replaced and the one that replaces it, and the stored setting's
 * write time when it was issued (`generation`), so it cannot be replayed once the setting moved.
 */
export const approvalPolicyStatementSchema = z.strictObject({
  type: z.literal(APPROVAL_POLICY_STATEMENT_TYPE),
  org: slug,
  environment: z.string().min(1).max(100),
  generation: z.int().min(0),
  old: approvalPolicyShape,
  new: approvalPolicyShape,
  approver: z.string().min(1).max(64),
  expires_at: z.int().positive(),
  nonce,
});
export type ApprovalPolicyStatement = z.infer<typeof approvalPolicyStatementSchema>;

/** The same change, whoever signs it. */
export const approvalPolicyDigest = (s: ApprovalPolicyStatement): string =>
  createHash("sha256")
    .update(
      canonicalJson({
        type: s.type,
        org: s.org,
        environment: s.environment,
        generation: s.generation,
        old: s.old,
        new: s.new,
      }),
      "utf8",
    )
    .digest("hex");

export const statementSchema = z.discriminatedUnion("type", [
  envStatementSchema,
  releaseStatementSchema,
  runStatementSchema,
  enrolStatementSchema,
  policyStatementSchema,
  approvalPolicyStatementSchema,
]);
export type Statement = z.infer<typeof statementSchema>;

/** The exact text that is signed. */
export const canonicalStatement = (s: Statement): string => canonicalJson(s);

/** sha256 of the canonical text, hex. The WebAuthn challenge is these bytes, base64url. */
export const statementHash = (s: Statement): string =>
  createHash("sha256").update(canonicalStatement(s), "utf8").digest("hex");

export const challengeOf = (s: Statement): string =>
  Buffer.from(statementHash(s), "hex").toString("base64url");

/** Identifies the key an enrolment is for, without carrying it: sha256(kind \n credentialId \n spki). */
export function keyFingerprint(k: {
  kind: string;
  credentialId: string | null;
  publicKey: string;
}): string {
  return createHash("sha256")
    .update(`${k.kind}\n${k.credentialId ?? ""}\n${k.publicKey}`, "utf8")
    .digest("hex");
}
