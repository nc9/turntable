// The credential a running attempt holds to ask the control plane for things that belong to it
// (an OIDC token today, the secrets proxy later). It is bound to one attempt of one org, expires,
// and is an HMAC under its own key domain, so the control plane stores nothing and a token minted
// for one purpose cannot be replayed as another. The attempt must also still be running when it
// is used: a credential outlives nothing.
import { createHmac, timingSafeEqual } from "node:crypto";
import { domainKey } from "../secrets/crypto";

const PREFIX = "lsat1";
/** The longest a credential is valid: a job's own limit, with room. */
export const MAX_ATTEMPT_CREDENTIAL_MS = 24 * 60 * 60 * 1000;

interface Body {
  o: string;
  a: string;
  e: number;
}

const mac = (masterKey: Buffer, body: string): Buffer =>
  createHmac("sha256", domainKey(masterKey, "attempt")).update(`${PREFIX}.${body}`).digest();

export function mintAttemptCredential(
  masterKey: Buffer,
  who: { orgId: string; attemptId: string },
  now: number,
  ttlMs: number = MAX_ATTEMPT_CREDENTIAL_MS,
): string {
  const exp = now + Math.min(ttlMs, MAX_ATTEMPT_CREDENTIAL_MS);
  const body = Buffer.from(
    JSON.stringify({ o: who.orgId, a: who.attemptId, e: exp } satisfies Body),
  ).toString("base64url");
  return `${PREFIX}.${body}.${mac(masterKey, body).toString("base64url")}`;
}

/** The org and attempt a credential names, or undefined for anything wrong. No detail on why. */
export function verifyAttemptCredential(
  masterKey: Buffer,
  token: string,
  now: number,
): { orgId: string; attemptId: string } | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return undefined;
  const [, body, sig] = parts as [string, string, string];
  const given = Buffer.from(sig, "base64url");
  const want = mac(masterKey, body);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return undefined;
  try {
    const b = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Body;
    if (typeof b.o !== "string" || typeof b.a !== "string" || typeof b.e !== "number")
      return undefined;
    if (b.e <= now) return undefined;
    return { orgId: b.o, attemptId: b.a };
  } catch {
    return undefined;
  }
}
