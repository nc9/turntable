// Verifying a signed statement against an enrolled key, and re-verifying stored approvals. The
// pure checks live here; applying an approval (writing records, releasing jobs) is in ops.
import { z } from "zod";
import { type Approver } from "../db/repos";
import {
  canonicalStatement,
  challengeOf,
  statementHash,
  statementSchema,
  type Statement,
} from "./statement";
import { verifyEd25519 } from "./keys";
import { verifyAssertion, WebAuthnError, type RelyingParty } from "./webauthn";

const b64url = z.string().regex(/^[A-Za-z0-9_-]{1,8192}$/);

export const signatureSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ed25519"), signature: b64url }),
  z.strictObject({
    kind: z.literal("webauthn"),
    credential_id: b64url,
    client_data_json: b64url,
    authenticator_data: b64url,
    signature: b64url,
  }),
]);
export type SignatureMaterial = z.infer<typeof signatureSchema>;

export class VerifyError extends Error {
  readonly code: "unauthenticated" | "invalid_input" | "conflict";
  constructor(code: VerifyError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** The key facts a verification needs; the default store reads them from the approvers table. */
export type ApproverKey = Pick<
  Approver,
  "id" | "kind" | "publicKey" | "alg" | "person" | "forgeLogin" | "credentialId" | "signCount"
> & { revoked: boolean };

export interface ApproverKeyStore {
  lookup(approverId: string): Promise<ApproverKey | undefined>;
}

export type Verified = {
  statement: Statement;
  hash: string;
  key: ApproverKey;
  method: "webauthn" | "ed25519";
  /** The authenticator's counter after this assertion (webauthn only). */
  signCount: number | null;
};

/**
 * Checks that `signature` is a valid signature by the approver the statement names over exactly
 * this statement. `counter: "ignore"` is for re-verifying a stored approval, where the counter
 * has long since moved on.
 */
export function verifySignature(
  statement: Statement,
  signature: SignatureMaterial,
  key: ApproverKey,
  o: { rp?: RelyingParty | undefined; counter: "check" | "ignore" },
): Verified {
  if (key.revoked) throw new VerifyError("unauthenticated", "that approver key is revoked");
  if (statement.approver !== key.id) throw new VerifyError("unauthenticated", "approver mismatch");
  if (key.kind !== signature.kind)
    throw new VerifyError("unauthenticated", `the approver key is ${key.kind}`);
  const hash = statementHash(statement);
  if (signature.kind === "ed25519") {
    if (!verifyEd25519(key.publicKey, canonicalStatement(statement), signature.signature))
      throw new VerifyError("unauthenticated", "signature does not verify");
    return { statement, hash, key, method: "ed25519", signCount: null };
  }
  if (!o.rp) throw new VerifyError("unauthenticated", "WebAuthn is not configured on this server");
  if (signature.credential_id !== key.credentialId)
    throw new VerifyError("unauthenticated", "credential does not belong to that approver");
  try {
    const r = verifyAssertion(
      {
        credentialId: signature.credential_id,
        clientDataJSON: signature.client_data_json,
        authenticatorData: signature.authenticator_data,
        signature: signature.signature,
      },
      {
        publicKey: key.publicKey,
        alg: key.alg,
        signCount: o.counter === "check" ? key.signCount : 0,
      },
      { challenge: challengeOf(statement), rp: o.rp },
    );
    return { statement, hash, key, method: "webauthn", signCount: r.signCount };
  } catch (e) {
    if (e instanceof WebAuthnError) throw new VerifyError("unauthenticated", e.message);
    throw e;
  }
}

export function parseStatement(raw: unknown): Statement {
  const p = statementSchema.safeParse(raw);
  if (!p.success)
    throw new VerifyError("invalid_input", "statement is not a valid approval statement");
  return p.data;
}
