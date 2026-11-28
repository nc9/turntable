// Credentials an adopted attempt needs again (#787). A controller that takes over a running
// attempt (a hand-off on deploy, or a re-attach after a crash) rebuilds, in memory, each
// credential the attempt's sandbox already holds or relies on:
//
// - the secrets-proxy credential (the proxy URL's password and the per-attempt CA the sandbox
//   trusts) and the artifact credential (ACTIONS_RUNTIME_TOKEN): both are derived from a per-attempt
//   seed, an HMAC of the org and attempt ids under the master key's `adopt` domain. The seed is
//   never stored; the next controller derives the same one, so the sandbox's credential still
//   works and nothing new is handed to it;
// - the job's GitHub token, which the job never held (the proxy attaches it): re-minted with the
//   permissions recorded at issue time, never wider; the old one is revoked at a hand-off.
//
// What is stored with the attempt (`adopt_spec`) holds no secret: times, the permissions, a hash of
// the rules, the proxy endpoint and a check value that tells whether the seed derived later is the
// one used at issue time (a different master key gives a different check, and the attempt is then
// refused, fail closed).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { domainKey } from "../secrets/crypto";

export type SeedPurpose = "proxy" | "artifact";

/** A per-attempt seed for one purpose. Deterministic for a master key, org and attempt. */
export type AttemptSeeds = (
  purpose: SeedPurpose,
  who: { orgId: string; attemptId: string },
) => Buffer;

export function attemptSeeds(masterKey: Buffer): AttemptSeeds {
  const key = domainKey(masterKey, "adopt");
  return (purpose, who) =>
    createHmac("sha256", key)
      .update(
        `ttadopt1.${purpose}.${who.orgId.length}:${who.orgId}.${who.attemptId.length}:${who.attemptId}`,
      )
      .digest();
}

/** A non-secret check value for a seed: equal checks mean the same seed (and master key). */
export function seedCheck(seed: Buffer): string {
  return createHmac("sha256", seed).update("turntable adopt check v1").digest("hex").slice(0, 32);
}

export function sameCheck(seed: Buffer, check: string): boolean {
  const a = Buffer.from(seedCheck(seed));
  const b = Buffer.from(check);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A stable hash of JSON-able data (the attempt's proxy rules and passthrough hosts). */
export function specHash(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex");
}

/** The proxy part: enough to re-register the same credential with the same rules. */
export interface AdoptProxySpec {
  /** When the credential was registered (epoch ms): its lifetime counts from here. */
  issuedAt: number;
  ttlMs: number;
  /** sha256 of the rules and passthrough hosts the credential was registered with. */
  rules: string;
  /** The endpoint the sandbox was told to use (`host:port`). */
  endpoint: string;
  check: string;
}

/** The job's GitHub token, behind the proxy: re-minted with these permissions, never wider. */
export interface AdoptTokenSpec {
  installationId: string;
  owner: string;
  repo: string;
  permissions: Record<string, string>;
}

export interface AdoptArtifactSpec {
  issuedAt: number;
  mode: "full" | "upload";
  check: string;
}

/** What is stored with an attempt so another controller can take it over. No secret in it. */
export interface AdoptSpec {
  v: 1;
  proxy?: AdoptProxySpec;
  token?: AdoptTokenSpec;
  /** The job had an OIDC request credential (the proxy mints per request). */
  oidc?: true;
  artifact?: AdoptArtifactSpec;
}

/** A stored spec that is present but unusable: the attempt is refused and released, never run. */
export interface InvalidAdoptSpec {
  invalid: string;
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const isTime = (x: unknown, now: number): x is number =>
  typeof x === "number" && Number.isFinite(x) && x > 0 && x <= now;
const isStr = (x: unknown): x is string => typeof x === "string" && x.length > 0;
const isCheck = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f]{32}$/.test(x);

function validSpec(v: unknown, now: number): string | undefined {
  if (!isObj(v) || v.v !== 1) return "unknown version";
  const p = v.proxy;
  if (p !== undefined) {
    if (!isObj(p)) return "proxy";
    if (!isTime(p.issuedAt, now)) return "proxy issuedAt";
    if (typeof p.ttlMs !== "number" || !Number.isFinite(p.ttlMs) || p.ttlMs <= 0) {
      return "proxy ttlMs";
    }
    if (!isStr(p.rules) || !isStr(p.endpoint) || !isCheck(p.check)) return "proxy fields";
  }
  const t = v.token;
  if (t !== undefined) {
    if (!isObj(t)) return "token";
    if (!isStr(t.installationId) || !isStr(t.owner) || !isStr(t.repo)) return "token fields";
    if (!isObj(t.permissions)) return "token permissions";
    if (!Object.values(t.permissions).every((x) => typeof x === "string")) {
      return "token permissions";
    }
  }
  if (v.oidc !== undefined && v.oidc !== true) return "oidc";
  const a = v.artifact;
  if (a !== undefined) {
    if (!isObj(a)) return "artifact";
    if (!isTime(a.issuedAt, now)) return "artifact issuedAt";
    if (a.mode !== "full" && a.mode !== "upload") return "artifact mode";
    if (!isCheck(a.check)) return "artifact check";
  }
  return undefined;
}

/**
 * The stored spec: undefined when there is none, `{ invalid }` when there is one that is not a
 * well-formed v1 spec (the caller refuses and releases the attempt, fail closed). Never throws.
 */
export function parseAdoptSpec(
  raw: string | null | undefined,
  now: number = Date.now(),
): AdoptSpec | InvalidAdoptSpec | undefined {
  if (!raw) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { invalid: "unreadable" };
  }
  const bad = validSpec(v, now);
  return bad ? { invalid: bad } : (v as AdoptSpec);
}

export function invalidSpec(x: AdoptSpec | InvalidAdoptSpec | undefined): x is InvalidAdoptSpec {
  return x !== undefined && "invalid" in x;
}
