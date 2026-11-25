import { retryableAfterSteps } from "@turntable/act-runner";
import {
  type Claim,
  DRAIN_CUT_NOT_RETRIED,
  finishAttempt,
  CONTROLLER_LOST,
  DRAIN_CUT,
  listExpiredLeases,
  listUndestroyedSandboxes,
  type Readiness,
  requeueLostAttemptOnce,
  takeExpiredLease,
  updateAttempt,
} from "../db/repos";
import type { Db } from "../db";
import type { ProviderResolver } from "./types";
import { workflowReadiness } from "./workflow-readiness";

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
      let destroyed = false;
      try {
        await provider.destroy(attempt.sandboxId);
        destroyed = true;
      } catch (err) {
        // The sandbox's own ttl is the backstop for one we could not destroy.
        log(`could not destroy sandbox ${attempt.sandboxId}: ${String(err)}`);
      }
      // Recorded without the lease (it expired): the confirmed destroy ends the billed life. A
      // destroy that failed records nothing: the time is never guessed.
      if (destroyed) {
        await updateAttempt(
          db,
          { orgId: attempt.orgId, projectId: attempt.projectId },
          attempt.id,
          { sandboxDestroyedAt: (opts.now ?? Date.now)() },
        ).catch((err) =>
          log(`could not record the destroy of ${attempt.sandboxId}: ${String(err)}`),
        );
      }
    }
    const scope = { orgId: attempt.orgId, projectId: attempt.projectId };
    // An attempt a drain timeout cut (a deploy) is retried once, by the infra-retry rule: it goes
    // back to the queue under a new attempt and is never a job failure. A protected or release job
    // cut after a step started ends with its own reason instead (#565). Any other loss, and a
    // second one, ends the job.
    let errorClass = `${CONTROLLER_LOST} (${probe})`.slice(0, 200);
    const requeue =
      attempt.errorClass === DRAIN_CUT
        ? await requeueLostAttemptOnce(db, scope, {
            attemptId: attempt.id,
            owner: attempt.leaseOwner ?? "",
            errorClass,
            now,
            retryableAfterSteps,
          })
        : "no";
    if (requeue === "not_retried") errorClass = DRAIN_CUT_NOT_RETRIED;
    if (requeue === "requeued") {
      report.resolved.push({ attemptId: attempt.id, sandboxId: attempt.sandboxId, probe });
      continue;
    }
    const done = await finishAttempt(db, scope, {
      attemptId: attempt.id,
      owner: attempt.leaseOwner ?? "",
      state: "infra_error",
      errorClass,
      expiredBefore: now,
      readiness: opts.readiness ?? workflowReadiness,
    });
    if (done) report.resolved.push({ attemptId: attempt.id, sandboxId: attempt.sandboxId, probe });
    else report.skipped++;
  }
  return report;
}

/**
 * Hands every provider the sandboxes this controller recorded and never confirmed destroyed, so a
 * provider whose listings cannot be trusted (Daytona's) counts and cleans up its own fleet by id.
 * Idempotent; run it on boot and with every reconcile. Returns how many ids were handed over.
 */
export async function adoptRecordedSandboxes(db: Db, providers: ProviderResolver): Promise<number> {
  const byProvider = new Map<string, string[]>();
  for (const a of await listUndestroyedSandboxes(db)) {
    if (!a.sandboxId) continue;
    byProvider.set(a.provider, [...(byProvider.get(a.provider) ?? []), a.sandboxId]);
  }
  let n = 0;
  for (const [name, ids] of byProvider) {
    const provider = providers(name);
    if (!provider?.adopt) continue;
    provider.adopt(ids);
    n += ids.length;
  }
  return n;
}

/** A finished attempt is left this long to record its own destroy before the sweep does. */
export const SWEEP_GRACE_MS = 60_000;
const SETTLED = new Set(["success", "failure", "infra_error", "cancelled", "skipped"]);

/**
 * For finished attempts whose sandbox was never confirmed destroyed (a failed delete, a crash
 * between the delete and its record): destroy it by id and record the confirmed destroy. The
 * provider's destroy is a get first (a sandbox that is gone is success) and a delete only if it
 * still exists, so this never relies on a listing. A destroy that fails records nothing and is
 * retried next time. (Attempts that are still running, and whose lease is alive, are a live
 * worker's; expired ones are reconcileExpired's.)
 */
export async function sweepUndestroyedSandboxes(
  db: Db,
  providers: ProviderResolver,
  opts: { now?: () => number; log?: (message: string) => void } = {},
): Promise<{ destroyed: number; failed: number }> {
  const now = (opts.now ?? Date.now)();
  const log = opts.log ?? (() => {});
  const out = { destroyed: 0, failed: 0 };
  for (const a of await listUndestroyedSandboxes(db)) {
    if (!a.sandboxId || !SETTLED.has(a.state)) continue;
    if (a.finishedAt !== null && now - a.finishedAt < SWEEP_GRACE_MS) continue;
    const provider = providers(a.provider);
    if (!provider) continue;
    try {
      await provider.destroy(a.sandboxId);
    } catch (err) {
      out.failed++;
      log(`could not destroy sandbox ${a.sandboxId}: ${String(err)}`);
      continue;
    }
    await updateAttempt(db, { orgId: a.orgId, projectId: a.projectId }, a.id, {
      sandboxDestroyedAt: (opts.now ?? Date.now)(),
    }).catch((err) => log(`could not record the destroy of ${a.sandboxId}: ${String(err)}`));
    out.destroyed++;
  }
  return out;
}
