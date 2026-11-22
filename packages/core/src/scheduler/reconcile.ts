import {
  type Claim,
  finishAttempt,
  listExpiredLeases,
  type Readiness,
  takeExpiredLease,
} from "../db/repos";
import type { Db } from "../db";
import type { ProviderResolver } from "./types";

export type ReconcileReport = {
  /** Attempts whose lease had expired and that were marked infra_error. */
  resolved: { attemptId: string; sandboxId: string | null; probe: string }[];
  /** Attempts handed to a worker to re-attach to their still-existing exec. */
  adopted: { attemptId: string; sandboxId: string; execId: string; probe: string }[];
  /** Expired attempts left alone because a live worker finished them first. */
  skipped: number;
};

/**
 * Resolves attempts left running by a worker that is gone (crash, kill -9, lost host): every
 * running attempt whose lease has expired. For each, probes the sandbox with `exec.status`.
 *
 * - The exec still exists (running, exited or killed) and an `adopt` callback is given: the
 *   attempt is taken over and handed to a worker to RE-ATTACH. The detached exec outlives the
 *   controller, so a job that finished meanwhile keeps its real result: the worker replays the
 *   exec's log by offset, rewrites the stored log and steps, and records the real verdict.
 * - The exec is lost, the sandbox is gone, nothing was recorded, the provider cannot be reached,
 *   or there is no `adopt`: whatever still runs is killed, the sandbox is destroyed, and the
 *   attempt is marked infra_error with the probe in the error class. No verdict is guessed.
 *
 * Run it on boot, and periodically after.
 */
export async function reconcileExpired(
  db: Db,
  providers: ProviderResolver,
  opts: {
    now?: () => number;
    /** Lease owner the adopting worker will hold (the scheduler's `owner`). */
    owner?: string;
    leaseMs?: number;
    /**
     * Re-attach: given the claim of an attempt whose exec still exists, start watching it. The
     * claim already carries a fresh lease for `owner`.
     */
    adopt?: (claim: Claim, resume: { sandboxId: string; execId: string }) => void;
    readiness?: Readiness;
    log?: (message: string) => void;
  } = {},
): Promise<ReconcileReport> {
  const now = (opts.now ?? Date.now)();
  const log = opts.log ?? (() => {});
  const report: ReconcileReport = { resolved: [], adopted: [], skipped: 0 };
  for (const attempt of await listExpiredLeases(db, now)) {
    const provider = providers(attempt.provider);
    let probe = "no sandbox recorded";
    let alive = false;
    if (provider && attempt.sandboxId) {
      try {
        if (attempt.execId) {
          const status = await provider.exec.status(attempt.sandboxId, attempt.execId);
          probe = `exec ${status.state}`;
          alive = status.state !== "lost";
        } else {
          probe = "sandbox created, no exec recorded";
        }
      } catch (err) {
        probe = `probe failed: ${err instanceof Error ? err.name : "error"}`;
      }
    } else if (!provider && attempt.sandboxId) {
      probe = `no provider named ${attempt.provider}`;
    }

    if (alive && opts.adopt && opts.owner && attempt.sandboxId && attempt.execId) {
      const claim = await takeExpiredLease(db, attempt.id, {
        owner: opts.owner,
        leaseMs: opts.leaseMs ?? 30_000,
        now,
      });
      if (!claim) {
        report.skipped++; // a live worker finished it, or another reconciler took it
        continue;
      }
      opts.adopt(claim, { sandboxId: attempt.sandboxId, execId: attempt.execId });
      report.adopted.push({
        attemptId: attempt.id,
        sandboxId: attempt.sandboxId,
        execId: attempt.execId,
        probe,
      });
      continue;
    }

    // Not re-attachable: stop whatever still runs and give up on the sandbox.
    if (provider && attempt.sandboxId) {
      if (alive && attempt.execId) {
        try {
          await provider.exec.kill(attempt.sandboxId, attempt.execId, "KILL");
        } catch {
          // destroying the sandbox below ends it anyway
        }
      }
      try {
        await provider.destroy(attempt.sandboxId);
      } catch (err) {
        // The sandbox's own ttl is the backstop for one we could not destroy.
        log(`could not destroy sandbox ${attempt.sandboxId}: ${String(err)}`);
      }
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
