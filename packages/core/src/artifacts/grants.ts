// Per-job artifact credentials, the counterpart of cache/grants.ts. A grant is minted when a job
// starts, names the run and attempt the job belongs to, and is dropped when the job ends. It lives
// in memory only, so a restart drops every grant and running jobs simply lose their artifact
// access.
//
// The token is what actions/upload-artifact and download-artifact read as ACTIONS_RUNTIME_TOKEN.
// Their client decodes it as a JWT (without verifying it) to learn the run and job ids from the
// `scp` claim, so it has three dot-separated parts: a header, a claims part, and a random secret
// where a signature would be. The claims are not trusted by this service: the grant, found by the
// hash of the whole token, decides which run and attempt a request is for.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { TrustClass } from "../trust";

export type ArtifactGrant = {
  attemptId: string;
  runId: string;
  scope: { orgId: string; projectId: string };
  /** The class the job runs as: what its downloads are decided against. */
  klass: TrustClass;
  /**
   * `full` reads and writes the run's artifacts (a job that can reach the service itself).
   * `upload` can only create and finalize its own uploads and put blocks into them: it cannot
   * list, ask for a download URL or download (the grant of a job whose only way to the service is
   * the narrow proxy route).
   */
  mode: "full" | "upload";
  expiresAt: number;
};

/** How long an upload-only grant lives, at most: it is minted per attempt and revoked with it. */
export const UPLOAD_GRANT_MS = 2 * 3600_000;

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
const SHAPE = /^[A-Za-z0-9_-]{8,400}\.[A-Za-z0-9_-]{8,400}\.[A-Za-z0-9_-]{16,64}$/;

export class ArtifactGrants {
  readonly #byHash = new Map<string, ArtifactGrant>();
  readonly #byAttempt = new Map<string, string>();
  readonly #now: () => number;
  readonly #maxMs: number;

  constructor(o: { now?: () => number; maxMs?: number } = {}) {
    this.#now = o.now ?? Date.now;
    this.#maxMs = o.maxMs ?? 6 * 3600_000;
  }

  /**
   * Mints a credential for the attempt. A second grant for the same attempt replaces the first.
   *
   * `derive` (#787): the secret part comes from `seed` (a per-attempt key derived from the master
   * key, never stored) and the lifetime counts from `issuedAt`. Issuing again with the same seed
   * and time, in another controller, gives the token the job already holds: that is how an
   * adopted attempt keeps its artifact access. An already expired grant is not issued.
   */
  issue(
    g: Omit<ArtifactGrant, "expiresAt" | "mode"> & { mode?: ArtifactGrant["mode"] },
    derive?: { seed: Buffer; issuedAt: number },
  ): string {
    this.revoke(g.attemptId);
    if (derive && derive.seed.length < 32) throw new Error("seed too short");
    const token = [
      b64({ alg: "none", typ: "JWT" }),
      b64({ scp: `Actions.Results:${g.runId}:${g.attemptId}`, iss: "turntable" }),
      derive
        ? createHmac("sha256", derive.seed)
            .update("turntable artifact credential v1")
            .digest()
            .subarray(0, 24)
            .toString("base64url")
        : randomBytes(24).toString("base64url"),
    ].join(".");
    const h = hash(token);
    const mode = g.mode ?? "full";
    const ttl = mode === "upload" ? Math.min(this.#maxMs, UPLOAD_GRANT_MS) : this.#maxMs;
    const expiresAt = (derive ? derive.issuedAt : this.#now()) + ttl;
    if (expiresAt <= this.#now()) throw new Error("grant already expired");
    this.#byHash.set(h, { ...g, mode, expiresAt });
    this.#byAttempt.set(g.attemptId, h);
    return token;
  }

  /** The grant for a token, or undefined if it is unknown, revoked or expired. */
  verify(token: string): ArtifactGrant | undefined {
    if (!SHAPE.test(token)) return undefined;
    const h = hash(token);
    const g = this.#byHash.get(h);
    if (!g) return undefined;
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
