// Authenticating a request that carries its own proof: a statement signed by an enrolled
// approver. Used only for `signature` ops. The statement names the org, so the scope comes from
// what the approver signed, not from anything the transport says.
import { z } from "zod";
import { dbKeyStore } from "../approvals/store";
import { parseStatement, signatureSchema, verifySignature, VerifyError } from "../approvals/verify";
import { auditFailure } from "../audit/failures";
import { getOrgBySlug } from "../db/repos";
import type { Op } from "./define";
import type { DispatchEnv } from "./dispatch";
import { OpError } from "./errors";
import type { Principal } from "./principal";

const REFUSED = "signature not accepted";

const envelope = z.object({ statement: z.record(z.string(), z.unknown()), signature: z.unknown() });

export async function authenticateSigned(
  env: DispatchEnv,
  op: Op,
  raw: Record<string, unknown>,
): Promise<{ principal: Principal; raw: Record<string, unknown> }> {
  if (op.auth.type !== "signature")
    throw new OpError("forbidden", `${op.name} does not take a signed request`);
  const shape = envelope.safeParse(raw);
  if (!shape.success)
    throw new OpError("invalid_input", "a signed request needs a statement and a signature");
  let statement;
  try {
    statement = parseStatement(shape.data.statement);
  } catch (e) {
    if (e instanceof VerifyError) throw new OpError("invalid_input", e.message);
    throw e;
  }
  const sig = signatureSchema.safeParse(shape.data.signature);
  if (!sig.success) throw new OpError("invalid_input", "signature is not a valid signature object");
  const org = await getOrgBySlug(env.db, statement.org);
  const fail = async (reason: string, approver?: string): Promise<never> => {
    if (org) {
      await auditFailure(env.db, {
        orgId: org.id,
        principalKind: "approver",
        principalId: approver ?? "unknown",
        source: approver ?? "unknown",
        op: op.name,
        outcome: "error:unauthenticated",
        detail: { reason },
      });
    }
    throw new OpError("unauthenticated", REFUSED);
  };
  if (!org) return fail("unknown_org");
  const key = await dbKeyStore(env.db, org.id).lookup(statement.approver);
  if (!key) return fail("unknown_approver", statement.approver);
  try {
    verifySignature(statement, sig.data, key, { rp: env.webauthn, counter: "check" });
  } catch (e) {
    if (e instanceof VerifyError) return fail(e.message, key.id);
    throw e;
  }
  const scoped: Record<string, unknown> = {
    ...raw,
    org: statement.org,
    ...(statement.type === "longshore.approve_environment.v1"
      ? { project: statement.project }
      : {}),
  };
  return {
    principal: { kind: "approver", id: key.id, orgId: org.id, person: key.person, role: "viewer" },
    raw: scoped,
  };
}
