// Remembers what it took the network to learn about an action, per project, in the database:
// a tag resolved to a sha, and a sha is (not) reachable from its own repo. A restart, or a second
// job in parallel, then does not ask GitHub again, which is what keeps a busy server under the
// API rate limit. Failures are never remembered, only answers.
import type { ActionRefResolver } from "@longshore/act-runner";
import type { Db } from "../db";
import { getVerdict, putVerdict, type Scope } from "../db/repos";
import type { ReachabilityChecker } from "./reachability";

export interface VerdictTtl {
  /** A tag or branch resolved to a sha. Refs move, so this is short. Default 5 minutes. */
  resolveMs: number;
  /** A sha reachable from its repo. A commit stays reachable. Default 24 hours. */
  reachYesMs: number;
  /** A sha NOT reachable (a possible impostor). Short, so a fixed situation is noticed. Default 10 minutes. */
  reachNoMs: number;
}

export const DEFAULT_VERDICT_TTL: VerdictTtl = {
  resolveMs: 5 * 60_000,
  reachYesMs: 24 * 3_600_000,
  reachNoMs: 10 * 60_000,
};

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * What the base was asked with. A verdict learned with a credential (which can see more than an
 * anonymous request) is kept apart from one learned without, so it is never served to a caller
 * that must not have used one.
 */
type Cred = { credentialed?: boolean };

export function cachedResolver(
  o: {
    db: Db;
    scope: Required<Scope>;
    base: ActionRefResolver;
    ttl?: Partial<VerdictTtl>;
    now?: () => number;
  } & Cred,
): ActionRefResolver {
  const kind = o.credentialed ? "resolve_auth" : "resolve";
  const ttl = { ...DEFAULT_VERDICT_TTL, ...o.ttl };
  const now = o.now ?? Date.now;
  return async (owner, repo, ref) => {
    const full = `${owner}/${repo}`;
    // A full sha needs no resolving, and is not worth a row.
    if (FULL_SHA.test(ref)) return o.base(owner, repo, ref);
    const hit = await getVerdict(o.db, o.scope, { kind, repo: full, ref }, ttl.resolveMs, now());
    if (hit?.verdict) return hit.sha;
    const sha = await o.base(owner, repo, ref);
    await putVerdict(o.db, o.scope, { kind, repo: full, ref, sha, verdict: true }, { now: now() });
    return sha;
  };
}

export function cachedReachability(
  o: {
    db: Db;
    scope: Required<Scope>;
    base: ReachabilityChecker;
    ttl?: Partial<VerdictTtl>;
    now?: () => number;
  } & Cred,
): ReachabilityChecker {
  const kind = o.credentialed ? "reach_auth" : "reach";
  const ttl = { ...DEFAULT_VERDICT_TTL, ...o.ttl };
  const now = o.now ?? Date.now;
  return async (owner, repo, sha) => {
    const full = `${owner}/${repo}`;
    const hit = await getVerdict(
      o.db,
      o.scope,
      { kind, repo: full, sha },
      Math.max(ttl.reachYesMs, ttl.reachNoMs),
      now(),
    );
    if (hit && now() - hit.checkedAt < (hit.verdict ? ttl.reachYesMs : ttl.reachNoMs)) {
      return hit.verdict;
    }
    const verdict = await o.base(owner, repo, sha);
    await putVerdict(o.db, o.scope, { kind, repo: full, sha, verdict }, { now: now() });
    return verdict;
  };
}
