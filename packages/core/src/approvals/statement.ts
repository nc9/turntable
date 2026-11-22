// The approval statement: what a human signs. Canonical JSON (sorted keys, no whitespace) over
// fixed fields, with a `type` for domain separation so a signature over one kind of statement
// can never be replayed as another. The hash of the canonical text is the WebAuthn challenge, and
// the canonical text itself is what an offline ed25519 key signs.
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../audit/chain";

export const ENV_STATEMENT_TYPE = "longshore.approve_environment.v1";
export const ENROL_STATEMENT_TYPE = "longshore.approve_enrolment.v1";

/** A statement is valid for at most this long after it is checked. */
export const MAX_STATEMENT_TTL_MS = 7 * 24 * 3600_000;
/** How long a server-issued challenge (and the nonce in its statement) lives. */
export const CHALLENGE_TTL_MS = 10 * 60_000;

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

export const enrolStatementSchema = z.strictObject({
  type: z.literal(ENROL_STATEMENT_TYPE),
  org: slug,
  enrolment_id: z.string().min(1).max(64),
  person: z.string().min(1).max(200),
  /** sha256 hex over the key being enrolled (see keyFingerprint). */
  key_fingerprint: hex(64, 64),
  approver: z.string().min(1).max(64),
  expires_at: z.int().positive(),
  nonce,
});
export type EnrolStatement = z.infer<typeof enrolStatementSchema>;

export const statementSchema = z.discriminatedUnion("type", [
  envStatementSchema,
  enrolStatementSchema,
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
