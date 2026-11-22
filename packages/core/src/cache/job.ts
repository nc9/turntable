// Giving a job its cache: a grant for its namespace and the URL its cache client talks to. The
// grant exists only for the life of the attempt (the caller releases it in a finally), and is
// refused for a job whose sandbox has no network path to the service.
import type { Db } from "../db";
import { getProjectCacheReleaseRestore, type Run } from "../db/repos";
import type { TrustClass } from "../trust";
import { namespaceFor } from "./namespace";
import type { CacheService } from "./service";

export type JobCacheRequest = {
  run: Run;
  attemptId: string;
  scope: { orgId: string; projectId: string };
  klass: TrustClass;
  /** The sandbox's egress: only `open` can reach the service. */
  egress: "none" | "open";
};

export type JobCache = {
  url: string;
  /** The credential inside the URL. The runner registers it for log redaction. */
  secret: string;
  release(): void;
};

export type JobCacheProvider = (req: JobCacheRequest) => Promise<JobCache | undefined>;

export function jobCacheProvider(db: Db, service: CacheService): JobCacheProvider {
  return async (req) => {
    // No network path means no cache: the job keeps act's local, per-sandbox cache.
    if (req.egress !== "open") return undefined;
    if (req.run.local) return undefined;
    const own = namespaceFor(req.scope, req.klass, {
      event: req.run.event,
      ref: req.run.ref,
      prNumber: req.run.prNumber ?? null,
    });
    const releaseRestore = await getProjectCacheReleaseRestore(db, req.scope);
    const token = service.grants.issue({ attemptId: req.attemptId, own, releaseRestore });
    return {
      url: service.urlFor(token),
      secret: token,
      release: () => service.grants.revoke(req.attemptId),
    };
  };
}
