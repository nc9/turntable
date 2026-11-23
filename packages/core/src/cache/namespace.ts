// Which cache a job may use. The namespace is derived by the server from the job (org, project,
// trust class, ref scope); a client never names one. The rule that matters: a job restores from
// its own namespace and from classes at least as trusted as itself, never from a lower one, and
// writes only to its own. A privileged job therefore consumes nothing a less trusted job wrote.
import type { CacheNamespace } from "../db/repos";
import type { TrustClass } from "../trust";

/** Most trusted first. */
export const TRUST_ORDER: readonly TrustClass[] = [
  "release",
  "protected",
  "trusted_pr",
  "untrusted_pr",
];

export const rank = (k: TrustClass): number => TRUST_ORDER.indexOf(k);

/** What identifies the job's place in history, from its run. */
export type RunRefInfo = { event: string; ref: string; prNumber: number | null };

/**
 * The ref scope of a namespace. Protected and release classes share one scope per class (they
 * are already limited to refs the org trusts). Pull request classes get one per pull request, so
 * one PR cannot poison another's cache.
 */
export function refScopeFor(klass: TrustClass, run: RunRefInfo): string {
  if (klass === "protected" || klass === "release") return "-";
  if (run.prNumber !== null) return `pr:${run.prNumber}`;
  const m = /^refs\/pull\/(\d+)\//.exec(run.ref);
  return m ? `pr:${m[1]}` : `ref:${run.ref.slice(0, 200)}`;
}

export function namespaceFor(
  o: { orgId: string; projectId: string },
  klass: TrustClass,
  run: RunRefInfo,
): CacheNamespace {
  return { orgId: o.orgId, projectId: o.projectId, klass, refScope: refScopeFor(klass, run) };
}

/**
 * The namespaces a job may restore from, in the order they are searched.
 * - release: nothing, unless the project opted in; then only release-written caches.
 * - protected: its own.
 * - trusted_pr: its own pull request's, then the protected cache (read up: a trusted PR gets the
 *   default branch's warm cache; the PR cannot write there).
 * - untrusted_pr: its own pull request's only.
 * Never a lower class than the job's own.
 */
export function readableNamespaces(
  own: CacheNamespace,
  o: { releaseRestore: boolean },
): CacheNamespace[] {
  const klass = own.klass as TrustClass;
  const out: CacheNamespace[] = [];
  if (klass === "release") {
    if (o.releaseRestore) out.push(own);
  } else {
    out.push(own);
    if (klass === "trusted_pr") out.push({ ...own, klass: "protected", refScope: "-" });
  }
  // The invariant, checked on the way out: nothing readable is less trusted than the reader.
  for (const ns of out) {
    if (rank(ns.klass as TrustClass) > rank(klass))
      throw new Error("cache read down the trust order");
  }
  return out;
}

/** Share of an org's cache quota each class may use. Eviction stays inside a class's share. */
export const CLASS_SHARE: Record<TrustClass, number> = {
  protected: 0.4,
  release: 0.1,
  trusted_pr: 0.3,
  untrusted_pr: 0.2,
};
