// Per-job cache credentials. A grant is minted when a job starts, names the namespace the job
// owns, and is dropped when the job ends. It lives in memory only, so it is never stored: a
// restart drops every grant and the running jobs simply lose their cache. The token is the
// credential, a random value carried in the cache URL path (act's cache URL is the one thing the
// job's cache client reads; its Authorization header is act's own artifact token, kept intact).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { CacheNamespace } from "../db/repos";

export type CacheGrant = {
  attemptId: string;
  own: CacheNamespace;
  releaseRestore: boolean;
  expiresAt: number;
};

export class CacheGrants {
  readonly #byHash = new Map<string, CacheGrant>();
  readonly #byAttempt = new Map<string, string>();
  readonly #now: () => number;
  readonly #maxMs: number;

  constructor(o: { now?: () => number; maxMs?: number } = {}) {
    this.#now = o.now ?? Date.now;
    this.#maxMs = o.maxMs ?? 6 * 3600_000;
  }

  /** Mints a credential for the attempt. A second grant for the same attempt replaces the first. */
  issue(g: Omit<CacheGrant, "expiresAt">): string {
    this.revoke(g.attemptId);
    const token = randomBytes(24).toString("base64url");
    const h = hash(token);
    this.#byHash.set(h, { ...g, expiresAt: this.#now() + this.#maxMs });
    this.#byAttempt.set(g.attemptId, h);
    return token;
  }

  /** The grant for a token, or undefined if it is unknown, revoked or expired. */
  verify(token: string): CacheGrant | undefined {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return undefined;
    const h = hash(token);
    const g = this.#byHash.get(h);
    if (!g) return undefined;
    // Compare the digest in constant time even though it came from a map lookup.
    if (!timingSafeEqual(Buffer.from(h), Buffer.from(this.#byAttempt.get(g.attemptId) ?? "")))
      return undefined;
    if (g.expiresAt <= this.#now()) {
      this.revoke(g.attemptId);
      return undefined;
    }
    return g;
  }

  /** Ends the job's access. Idempotent. */
  revoke(attemptId: string): void {
    const h = this.#byAttempt.get(attemptId);
    if (h) this.#byHash.delete(h);
    this.#byAttempt.delete(attemptId);
  }

  get size(): number {
    return this.#byHash.size;
  }
}

const hash = (token: string): string => createHash("sha256").update(token).digest("hex");
