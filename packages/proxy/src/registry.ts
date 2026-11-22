// Per-attempt proxy credentials. A credential is `attempt id : token`, bound to one attempt and
// its lifetime. Only a hash of the token is kept; the CA of the attempt lives here too.
import crypto from "node:crypto";
import { JobCa } from "./ca";
import { type CompiledRule, compileRules } from "./rules";
import type { AttemptCredential, AttemptSpec } from "./types";

export interface Attempt {
  spec: AttemptSpec;
  rules: readonly CompiledRule[];
  ca: JobCa;
  expiresAt: number;
  revoked: boolean;
  tokenHash: Buffer;
  /** Sockets of this attempt's open tunnels, closed on revoke. */
  tunnels: Set<{ destroy(): void }>;
}

export type AuthResult =
  | { ok: true; attempt: Attempt }
  /** Every failure is the same answer to the caller; `reason` is for the audit log only. */
  | {
      ok: false;
      reason: "malformed" | "unknown_attempt" | "bad_credential" | "expired" | "revoked";
      attemptId: string;
    };

const sha = (s: string): Buffer => crypto.createHash("sha256").update(s).digest();

export class AttemptRegistry {
  readonly #attempts = new Map<string, Attempt>();
  readonly #now: () => number;

  constructor(o: { now?: () => number } = {}) {
    this.#now = o.now ?? Date.now;
  }

  /** Registers an attempt and returns what the job is given. The token is never shown again. */
  register(spec: AttemptSpec): AttemptCredential {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(spec.attemptId)) throw new Error("attempt id must be plain");
    if (this.#attempts.has(spec.attemptId)) throw new Error("attempt already registered");
    if (!(spec.ttlMs > 0)) throw new Error("ttl must be positive");
    const now = this.#now();
    const token = crypto.randomBytes(32).toString("base64url");
    const attempt: Attempt = {
      spec,
      rules: compileRules(spec.rules),
      ca: new JobCa({ label: spec.attemptId, now, ttlMs: spec.ttlMs }),
      expiresAt: now + spec.ttlMs,
      revoked: false,
      tokenHash: sha(token),
      tunnels: new Set(),
    };
    this.#attempts.set(spec.attemptId, attempt);
    return {
      username: spec.attemptId,
      password: token,
      caPem: attempt.ca.certPem,
      expiresAt: attempt.expiresAt,
      proxyUrl: (host, port) => `http://${spec.attemptId}:${token}@${host}:${port}`,
    };
  }

  /** Checks a `Proxy-Authorization` header. Call at CONNECT and again for every request. */
  authenticate(header: string | undefined): AuthResult {
    const m = /^Basic +([A-Za-z0-9+/=]+)$/i.exec(header ?? "");
    const decoded = m ? Buffer.from(m[1]!, "base64").toString("utf8") : "";
    const i = decoded.indexOf(":");
    if (i < 1) return { ok: false, reason: "malformed", attemptId: "" };
    const attemptId = decoded.slice(0, i);
    const token = decoded.slice(i + 1);
    const attempt = this.#attempts.get(attemptId);
    if (!attempt) return { ok: false, reason: "unknown_attempt", attemptId };
    // Constant time on the hashes, whatever the outcome that follows.
    const same = crypto.timingSafeEqual(sha(token), attempt.tokenHash);
    if (!same) return { ok: false, reason: "bad_credential", attemptId };
    if (attempt.revoked) return { ok: false, reason: "revoked", attemptId };
    if (this.#now() >= attempt.expiresAt) return { ok: false, reason: "expired", attemptId };
    return { ok: true, attempt };
  }

  /** Whether an authenticated attempt is still within its lifetime (checked per request). */
  live(attempt: Attempt): boolean {
    return !attempt.revoked && this.#now() < attempt.expiresAt;
  }

  /** Ends an attempt: its credential stops working and its open tunnels are closed. */
  revoke(attemptId: string): void {
    const a = this.#attempts.get(attemptId);
    if (!a) return;
    a.revoked = true;
    for (const t of a.tunnels) t.destroy();
    a.tunnels.clear();
  }

  /** Drops attempts whose lifetime is over (their tunnels are closed). */
  sweep(): number {
    let n = 0;
    for (const [id, a] of this.#attempts) {
      if (a.revoked || this.#now() >= a.expiresAt) {
        for (const t of a.tunnels) t.destroy();
        this.#attempts.delete(id);
        n++;
      }
    }
    return n;
  }

  get size(): number {
    return this.#attempts.size;
  }
}
