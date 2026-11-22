import { finishAttempt, listExpiredLeases, type Readiness } from "../db/repos";
import type { Db } from "../db";
import type { ProviderResolver } from "./types";

export type ReconcileReport = {
  /** Attempts whose lease had expired and that were marked infra_error. */
  resolved: { attemptId: string; sandboxId: string | null; probe: string }[];
  /** Expired attempts left alone because a live worker finished them first. */
  skipped: number;
};

/**
 * Resolves attempts left running by a worker that is gone (crash, kill -9, lost host): every
 * running attempt whose lease has expired. For each, probes the sandbox with `exec.status`,
 * stops whatever is still running, destroys the sandbox, and marks the attempt infra_error.
 *
 * The result is never guessed: an exec that exited while nobody was watching has no trustworthy
 * verdict (the events that decide success were never read), so it is infra_error too, and the
 * probe is recorded in the error class. Run it on boot, and periodically after.
 */
export async function reconcileExpired(
  db: Db,
  providers: ProviderResolver,
  opts: {
    now?: () => number;
    owner?: string;
    readiness?: Readiness;
    log?: (message: string) => void;
  } = {},
): Promise<ReconcileReport> {
  const now = (opts.now ?? Date.now)();
  const log = opts.log ?? (() => {});
  const report: ReconcileReport = { resolved: [], skipped: 0 };
  for (const attempt of await listExpiredLeases(db, now)) {
    const provider = providers(attempt.provider);
    let probe = "no sandbox recorded";
    if (provider && attempt.sandboxId) {
      try {
        if (attempt.execId) {
          const status = await provider.exec.status(attempt.sandboxId, attempt.execId);
          probe = `exec ${status.state}`;
          if (status.state === "running") {
            await provider.exec.kill(attempt.sandboxId, attempt.execId, "KILL");
          }
        } else {
          probe = "sandbox created, no exec recorded";
        }
      } catch (err) {
        probe = `probe failed: ${err instanceof Error ? err.name : "error"}`;
      }
      try {
        await provider.destroy(attempt.sandboxId);
      } catch (err) {
        // The sandbox's own ttl is the backstop for one we could not destroy.
        log(`could not destroy sandbox ${attempt.sandboxId}: ${String(err)}`);
      }
    } else if (!provider) {
      probe = `no provider named ${attempt.provider}`;
    }
    const scope = { orgId: attempt.orgId, projectId: attempt.projectId };
    const done = await finishAttempt(db, scope, {
      attemptId: attempt.id,
      owner: attempt.leaseOwner ?? "",
      state: "infra_error",
      errorClass: `controller_lost (${probe})`.slice(0, 200),
      expiredBefore: now,
      ...(opts.readiness ? { readiness: opts.readiness } : {}),
    });
    if (done) report.resolved.push({ attemptId: attempt.id, sandboxId: attempt.sandboxId, probe });
    else report.skipped++;
  }
  return report;
}
