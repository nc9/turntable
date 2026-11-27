import { randomUUID } from "node:crypto";
import { type InfraKind, isRetryableInfra, retryableAfterSteps } from "@turntable/act-runner";
import { type Db, onAttemptsCancelled } from "../db";
import {
  addCut,
  appendLogFenced,
  type Claim,
  claimNextAttempt,
  earlierInfraReason,
  listAttempts,
  NETWORK_REQUEUE,
  requeuePreSandbox,
  CONTROLLER_LOST,
  finishAttempt,
  heartbeatAttempt,
  ifLeaseHeld,
  markDrainCut,
  type Readiness,
  recordExec,
  recordPlan,
  recordTrustClass,
  DRAIN_CUT_NOT_RETRIED,
  requeueInfraFailureOnce,
  requeueLostAttemptOnce,
  resetAttemptOutput,
  upsertStep,
} from "../db/repos";
import { type NetworkHealth, processNetwork } from "../network";
import { effectiveChecksMode } from "../ops/setting-guard";
import { ambientSettings } from "../settings/ambient";
import { preemptMaxPerJobSetting, preemptWindowMinutesSetting } from "../settings/definitions";
import { LiveLimits } from "./live-limits";
import { resolveSetting, type SettingsRuntime } from "../settings/resolve";
import { type ErrorDetail, errorDetailOf } from "./error-detail";
import { type DrainState, processDrain } from "./drain";
import { workflowReadiness } from "./workflow-readiness";
import type {
  AttemptContext,
  AttemptObserver,
  AttemptOutcome,
  AttemptRunner,
  AttemptStore,
  ProviderResolver,
} from "./types";

export type SchedulerOptions = {
  db: Db;
  runner: AttemptRunner;
  providers: ProviderResolver;
  /** Unique per worker process. Default: a random id. */
  owner?: string;
  /** How long a claim lasts without a heartbeat. Default 30 s. */
  leaseMs?: number;
  /** Heartbeat interval. Default a third of the lease. */
  heartbeatMs?: number;
  /** How often an idle scheduler looks for work. Default 1 s. */
  pollMs?: number;
  /** Fixes the global cap (`turntable run`, tests). Default: the live `scheduler_global_cap` setting (#661). */
  globalCap?: number;
  /** Fixes the per-org cap. Default: the live `scheduler_org_cap` setting. */
  perOrgCap?: number;
  /** The live limits, shared with the provider's create-time hook. Default: its own. */
  limits?: LiveLimits;
  /** Decides when a queued job may run and what becomes of dependents of a failed one. */
  readiness?: Readiness;
  /** Told when attempts start and finish (check runs). Never awaited; its errors are logged. */
  observer?: AttemptObserver;
  /** Run only this run's attempts (see ClaimOptions.onlyRun): `turntable run`'s own scheduler. */
  onlyRun?: string;
  /** The settings layers (env, `turntable.toml`): where the preemption limits come from. Default: the process's own (`ambientSettings`). */
  settings?: SettingsRuntime;
  /** While draining it claims nothing (#446). Default: the process's own (`processDrain`). */
  drain?: DrainState;
  /** While degraded it claims nothing and requeues pre-sandbox failures (#698). Default: the process's own. */
  network?: NetworkHealth;
  /** Wait before an infra retry (#517) starts its new attempt. Default 10 s. */
  infraRetryBackoffMs?: number;
  now?: () => number;
  log?: (message: string) => void;
};

/** The longest an infra retry waits for a forge's rate limit to reset (#621). */
export const MAX_RETRY_AFTER_MS = 3_600_000;

/** The fixed wait before an infra retry (#517). */
export const INFRA_RETRY_BACKOFF_MS = 10_000;

/** What the scheduler records when a runner throws or returns nonsense. */
const infra = (reason: string, infraKind?: InfraKind, cause?: unknown): AttemptOutcome => {
  const d = errorDetailOf(cause);
  return {
    state: "infra_error",
    reason,
    ...(infraKind ? { infraKind } : {}),
    ...(d.name ? { errorName: d.name } : {}),
    ...(d.code ? { errorCode: d.code } : {}),
  };
};

const detailOf = (o: AttemptOutcome): { errorDetail?: ErrorDetail } =>
  o.errorName || o.errorCode
    ? {
        errorDetail: {
          ...(o.errorName ? { name: o.errorName } : {}),
          ...(o.errorCode ? { code: o.errorCode } : {}),
        },
      }
    : {};

/**
 * Claims queued attempts and runs them through the runner, within the global and per-org caps.
 * It keeps each lease alive with heartbeats and records the outcome fenced by the lease. A
 * worker that dies stops heartbeating; the reconciler resolves what it left behind.
 */
export class Scheduler {
  readonly owner: string;
  readonly #o: Required<
    Omit<
      SchedulerOptions,
      | "owner"
      | "log"
      | "readiness"
      | "onlyRun"
      | "observer"
      | "settings"
      | "drain"
      | "network"
      | "globalCap"
      | "perOrgCap"
      | "limits"
    >
  > & {
    globalCap?: number | undefined;
    perOrgCap?: number | undefined;
    limits: LiveLimits;
    observer?: AttemptObserver | undefined;
    onlyRun?: string | undefined;
    settings?: SettingsRuntime | undefined;
    log: (message: string) => void;
    readiness: Readiness;
    drain: DrainState;
    network: NetworkHealth;
  };
  readonly #active = new Map<
    string,
    { controller: AbortController; done: Promise<void>; scope: Claim["scope"] }
  >();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #wake: (() => void) | undefined;
  readonly #unsubscribe: () => void;

  constructor(o: SchedulerOptions) {
    this.owner = o.owner ?? `worker-${randomUUID()}`;
    // A manual cancel (or supersession) of a run with attempts running here stops them at once.
    this.#unsubscribe = onAttemptsCancelled((attempts) =>
      this.abort(attempts.map((a) => a.attemptId)),
    );
    const leaseMs = o.leaseMs ?? 30_000;
    this.#o = {
      db: o.db,
      runner: o.runner,
      providers: o.providers,
      leaseMs,
      heartbeatMs: o.heartbeatMs ?? Math.max(1, Math.floor(leaseMs / 3)),
      pollMs: o.pollMs ?? 1000,
      globalCap: o.globalCap,
      perOrgCap: o.perOrgCap,
      limits: o.limits ?? new LiveLimits(o.db, () => o.settings ?? ambientSettings()),
      readiness: o.readiness ?? workflowReadiness,
      onlyRun: o.onlyRun,
      settings: o.settings,
      observer: o.observer,
      drain: o.drain ?? processDrain,
      network: o.network ?? processNetwork,
      infraRetryBackoffMs: o.infraRetryBackoffMs ?? INFRA_RETRY_BACKOFF_MS,
      now: o.now ?? Date.now,
      log: o.log ?? (() => {}),
    };
    this.#o.drain.trackRunning(() => this.#active.size);
    this.#o.drain.trackShadowCutter(() => this.cutShadow());
  }

  /** Attempts a drain is cutting (#480): their runner is stopped and the job requeued once. */
  readonly #cutting = new Set<string>();

  /**
   * Drain `shadow: "cancel"` (#480): for each running attempt of a project whose checks mode is
   * not `live`, marks it cut by the drain (the same mark #448's timeout uses) and stops its runner,
   * which destroys the sandbox like a supersede does. The attempt ends as an infra retry (see
   * `#launch`), never a job failure. Live projects' attempts are left to finish. Returns the count.
   */
  async cutShadow(): Promise<number> {
    let n = 0;
    for (const [id, a] of [...this.#active.entries()]) {
      if (this.#cutting.has(id)) continue;
      try {
        if (
          (await effectiveChecksMode(
            this.#o.settings ?? ambientSettings(),
            this.#o.db,
            a.scope.orgId,
            a.scope.projectId,
          )) === "live"
        )
          continue;
        if (!(await markDrainCut(this.#o.db, a.scope, id, this.owner))) continue;
      } catch (err) {
        this.#o.log(`could not cut ${id} for the drain: ${String(err)}`);
        continue;
      }
      this.#cutting.add(id);
      a.controller.abort("drain_cut");
      n++;
    }
    return n;
  }

  #limit: { at: number; value: { max: number; windowMs: number } } | undefined;

  /** The anti-thrash limits (#355), read through the settings and kept a few seconds. */
  async #preemptLimit(now: number): Promise<{ max: number; windowMs: number }> {
    const rt = this.#o.settings ?? ambientSettings();
    if (this.#limit && Math.abs(now - this.#limit.at) < 5_000) return this.#limit.value;
    const max = (await resolveSetting(rt, this.#o.db, preemptMaxPerJobSetting.key)).value;
    const minutes = (await resolveSetting(rt, this.#o.db, preemptWindowMinutesSetting.key)).value;
    const value = { max: max as number, windowMs: (minutes as number) * 60_000 };
    this.#limit = { at: now, value };
    return value;
  }

  /** Attempts this worker is running right now. */
  get activeCount(): number {
    return this.#active.size;
  }

  /**
   * Claims as many attempts as the caps allow and starts them. Returns how many it started.
   * Safe to call concurrently with other workers and other calls.
   */
  async tick(): Promise<number> {
    let started = 0;
    for (;;) {
      // Draining: nothing new starts. Queued work stays queued; running attempts carry on.
      if (this.#o.drain.draining) return started;
      // Degraded network (#698): nothing is claimed; the queue waits and resumes in order.
      if (this.#o.network.degraded) return started;
      const now = this.#o.now();
      // Read at every claim (cached for seconds): a raised cap applies to the next one, a lowered
      // one holds new claims and never touches what is running.
      const live = await this.#o.limits.read(now);
      const claim = await claimNextAttempt(this.#o.db, {
        owner: this.owner,
        leaseMs: this.#o.leaseMs,
        now,
        preemptLimit: await this.#preemptLimit(now),
        globalCap: this.#o.globalCap ?? live.globalCap,
        perOrgCap: this.#o.perOrgCap ?? live.orgCap,
        quotaCacheMs: 5_000,
        readiness: this.#o.readiness,
        ...(this.#o.onlyRun ? { onlyRun: this.#o.onlyRun } : {}),
      });
      if (!claim) {
        this.#notify((o) => o.tick?.());
        return started;
      }
      this.#launch(claim);
      started++;
    }
  }

  /** Runs the claim loop until `stop`. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    const loop = async (): Promise<void> => {
      if (!this.#running) return;
      try {
        await this.tick();
      } catch (err) {
        this.#o.log(`scheduler tick failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!this.#running) return;
      this.#timer = setTimeout(() => void loop(), this.#o.pollMs);
      this.#wake = () => {
        clearTimeout(this.#timer);
        void loop();
      };
    };
    void loop();
  }

  /** Wakes an idle loop now (a new attempt was queued in this process). */
  nudge(): void {
    this.#wake?.();
  }

  /**
   * Stops claiming. With `abort`, running attempts are told to stop (their sandboxes are
   * destroyed and they end as cancelled or infra_error); without it, waits for them to finish.
   */
  async stop(opts: { abort?: boolean } = {}): Promise<void> {
    this.#running = false;
    this.#unsubscribe();
    clearTimeout(this.#timer);
    if (opts.abort) for (const a of this.#active.values()) a.controller.abort("scheduler stopping");
    await Promise.all([...this.#active.values()].map((a) => a.done));
  }

  /**
   * Graceful shutdown (#446): starts a drain (no new attempt starts), waits up to `timeoutMs` for
   * the running ones, then marks those still running as cut by the drain so the next boot's
   * reconcile re-attaches to their execs or, failing that, retries each job once as an infra
   * error. Never aborts them. Returns how many were still running.
   */
  async drainAndWait(timeoutMs: number, reason = "shutdown"): Promise<{ remaining: number }> {
    this.#o.drain.set(true, reason, this.#o.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs));
    });
    try {
      await Promise.race([this.idle(), timedOut]);
    } finally {
      clearTimeout(timer);
    }
    const left = [...this.#active.entries()];
    for (const [id, a] of left) {
      await markDrainCut(this.#o.db, a.scope, id, this.owner).catch((err) =>
        this.#o.log(`could not mark ${id} as cut by the drain: ${String(err)}`),
      );
    }
    // The loop ends here either way: the process is going away, and what still runs is left.
    this.#running = false;
    this.#unsubscribe();
    clearTimeout(this.#timer);
    return { remaining: left.length };
  }

  /**
   * Stops attempts of this worker now (a newer run superseded them, or they were cancelled). Their
   * runners destroy the sandboxes. Returns how many were running here.
   */
  abort(attemptIds: readonly string[]): number {
    let n = 0;
    for (const id of attemptIds) {
      const a = this.#active.get(id);
      if (a) {
        a.controller.abort("superseded or cancelled");
        n++;
      }
    }
    return n;
  }

  /** Resolves when every attempt this worker started has finished. */
  async idle(): Promise<void> {
    while (this.#active.size > 0) await Promise.all([...this.#active.values()].map((a) => a.done));
  }

  /**
   * Takes over an attempt a dead worker left running (see reconcileExpired) and re-attaches to its
   * exec: the runner is called with `resume`, so it replays the exec and records the real result.
   * The claim comes from `takeExpiredLease`, so this worker already holds the lease.
   */
  adopt(claim: Claim, resume: { sandboxId: string; execId: string }): void {
    this.#launch(claim, resume);
  }

  /** Calls the observer without letting it affect the run. */
  #notify(f: (o: AttemptObserver) => void): void {
    const obs = this.#o.observer;
    if (!obs) return;
    try {
      f(obs);
    } catch (err) {
      this.#o.log(`attempt observer failed: ${String(err)}`);
    }
  }

  /**
   * After a pre-sandbox failure: probes once more (the failure may land before two scheduled probes
   * have said so), and requeues when the network is degraded or the probe just failed.
   */
  async #requeueForNetwork(claim: Claim, reason: string): Promise<boolean> {
    const net = this.#o.network;
    await net.probeNow();
    if (!net.degraded && !net.suspect) return false;
    return requeuePreSandbox(this.#o.db, claim.scope, {
      attemptId: claim.attempt.id,
      owner: this.owner,
      reason,
      now: this.#o.now(),
    });
  }

  /** One job-log line for each degraded window a requeued job waited through (#698). */
  async #networkNotices(claim: Claim): Promise<string[]> {
    if (claim.attempt.attempt <= 1) return [];
    // Only the requeues directly behind this attempt: a later retry does not repeat the line.
    const before = (await listAttempts(this.#o.db, claim.scope, claim.job.id)).filter(
      (a) => a.attempt < claim.attempt.attempt,
    );
    const earlier: typeof before = [];
    for (const a of before.toReversed()) {
      if (!a.errorClass?.startsWith(NETWORK_REQUEUE)) break;
      earlier.push(a);
    }
    if (earlier.length === 0) return [];
    const now = this.#o.now();
    const seen = new Map<number, string>();
    let unknown = false;
    for (const a of earlier) {
      const wins = this.#o.network.windowsBetween(a.finishedAt ?? now, now);
      if (wins.length === 0) unknown = true;
      for (const w of wins) {
        if (seen.has(w.start)) continue;
        const end = w.end ?? now;
        const secs = Math.max(0, Math.round((end - w.start) / 1000));
        seen.set(
          w.start,
          `[turntable] waited out a network degraded window (${new Date(w.start).toISOString()} to ${new Date(end).toISOString()}, ${secs}s)`,
        );
      }
    }
    const lines = [...seen.values()];
    if (lines.length === 0 && unknown) {
      lines.push(
        "[turntable] waited out a network degraded window (re-queued before a sandbox existed)",
      );
    }
    return lines;
  }

  #launch(claim: Claim, resume?: { sandboxId: string; execId: string }): void {
    const { attempt, scope } = claim;
    const controller = new AbortController();
    const db = this.#o.db;
    const owner = this.owner;
    // The class this attempt runs as, once known: a mid-run infra kind is retried only for PR jobs.
    let recordedClass: string | undefined;

    const store: AttemptStore = {
      setExec: async (where) => {
        await recordExec(db, scope, attempt.id, owner, where);
      },
      setPlan: async (planJson) => {
        await recordPlan(db, scope, attempt.id, owner, planJson);
      },
      setTrustClass: async (klass) => {
        recordedClass = klass;
        await recordTrustClass(db, scope, attempt.id, owner, klass);
      },
      reset: async () => {
        await resetAttemptOutput(db, scope, attempt.id, owner, { signal: controller.signal });
      },
      // Everything a worker writes is fenced by its lease: after it loses the lease (reconciled,
      // cancelled) its writes are dropped instead of landing in a log someone else now owns.
      appendLog: async (offset, bytes) => {
        await appendLogFenced(db, scope, attempt.id, owner, offset, bytes);
      },
      recordStep: async (step) => {
        await ifLeaseHeld(db, scope, attempt.id, owner, () =>
          upsertStep(db, scope, { ...step, attemptId: attempt.id }),
        );
      },
      addCut: async (cut) => {
        await ifLeaseHeld(db, scope, attempt.id, owner, () =>
          addCut(db, scope, { ...cut, attemptId: attempt.id }),
        );
      },
    };

    const beat = setInterval(() => {
      void heartbeatAttempt(db, scope, attempt.id, owner, this.#o.now(), this.#o.leaseMs)
        .then((ok) => {
          if (!ok) controller.abort("lease lost");
        })
        .catch((err) => {
          // A failed heartbeat is not a lost lease yet; the next one may succeed. If the
          // database stays unreachable the lease expires and the reconciler takes over.
          this.#o.log(`heartbeat failed for ${attempt.id}: ${String(err)}`);
        });
    }, this.#o.heartbeatMs);

    const run = async (): Promise<void> => {
      let outcome: AttemptOutcome;
      try {
        const provider = this.#o.providers(attempt.provider);
        if (!provider) {
          outcome = infra(`no provider named ${attempt.provider}`);
        } else {
          const notices = resume ? [] : await this.#networkNotices(claim);
          const ctx: AttemptContext = {
            ...(notices.length > 0 ? { notices } : {}),
            attempt,
            job: claim.job,
            run: claim.run,
            scope,
            provider,
            signal: controller.signal,
            store,
            ...(resume ? { resume } : {}),
          };
          outcome = await this.#o.runner(ctx);
        }
      } catch (err) {
        // An exception the runner did not classify: kind `unknown`, retried once (#670).
        outcome = infra(err instanceof Error ? err.message : String(err), "unknown", err);
      }
      // The network is degraded and this attempt failed before its sandbox existed (#698): it is
      // requeued, not finished, and does not use the one automatic retry. An attempt that had a
      // sandbox is never requeued here (see `requeuePreSandbox`).
      if (
        outcome.state === "infra_error" &&
        (outcome.infraKind === "sandbox_create_failed" ||
          outcome.infraKind === "checkout_fetch_failed" ||
          outcome.infraKind === "unknown") &&
        !controller.signal.aborted &&
        !this.#cutting.has(attempt.id)
      ) {
        const requeued = await this.#requeueForNetwork(claim, outcome.reason).catch((err) => {
          this.#o.log(`could not requeue ${attempt.id} for the network: ${String(err)}`);
          return false;
        });
        if (requeued) {
          clearInterval(beat);
          this.nudge();
          return;
        }
      }
      // A transient infra failure waits out the backoff while the lease is still held (the
      // heartbeat runs, a cancel still lands), then retries below. The sandbox is already gone.
      let retryable =
        outcome.state === "infra_error" &&
        isRetryableInfra(outcome.infraKind, recordedClass ?? attempt.trustClass) &&
        !controller.signal.aborted &&
        !this.#cutting.has(attempt.id);
      try {
        if (retryable) {
          const waitMs = Math.max(
            this.#o.infraRetryBackoffMs,
            Math.min(outcome.retryAfterMs ?? 0, MAX_RETRY_AFTER_MS),
          );
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, waitMs);
            controller.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                resolve();
              },
              { once: true },
            );
          });
          retryable = !controller.signal.aborted;
        }
      } finally {
        clearInterval(beat);
      }
      // A shadow attempt the drain cut ends as a requeue, not a result: its job goes back to the
      // queue under a new attempt (once) and no check is reported. A verdict it reached before the
      // stop landed is kept.
      if (
        this.#cutting.delete(attempt.id) &&
        (outcome.state === "infra_error" || outcome.state === "cancelled")
      ) {
        const requeued = await requeueLostAttemptOnce(db, scope, {
          attemptId: attempt.id,
          owner,
          errorClass: `${CONTROLLER_LOST} (drain cancel)`,
          now: this.#o.now(),
          requireExpired: false,
          retryableAfterSteps,
        }).catch((err) => {
          this.#o.log(`could not requeue ${attempt.id} after the drain cut: ${String(err)}`);
          return "no" as const;
        });
        if (requeued === "requeued") return;
        // The one infra retry is spent (or the requeue failed, or steps ran for a protected or
        // release job): the stop must not read as a human cancel. The job ends infra_error, like a
        // drain-timeout cut with no retry left.
        outcome = infra(
          requeued === "not_retried" ? DRAIN_CUT_NOT_RETRIED : `${CONTROLLER_LOST} (drain cancel)`,
        );
      }
      // Retry a transient infra failure once, on a fresh sandbox: a NEW attempt for the same job.
      // Every run-step check and refusal applies again, since the new attempt is claimed and run
      // like any other. A job that already used its infra retry ends below with both reasons.
      let reason = outcome.reason;
      if (outcome.state === "infra_error") {
        if (retryable && outcome.infraKind) {
          const retried = await requeueInfraFailureOnce(db, scope, {
            attemptId: attempt.id,
            owner,
            kind: outcome.infraKind,
            reason: outcome.reason,
            ...detailOf(outcome),
            now: this.#o.now(),
          }).catch((err) => {
            this.#o.log(`could not retry ${attempt.id} after an infra error: ${String(err)}`);
            return false;
          });
          if (retried) {
            this.nudge();
            return;
          }
        }
        // The job's own infra retry is spent: this attempt's reason carries the first one too.
        const earlier = await earlierInfraReason(db, scope, attempt).catch(() => undefined);
        if (earlier) reason = `${reason.slice(0, 100)} (after: ${earlier.slice(0, 80)})`;
      }
      const exitCode =
        outcome.state === "success"
          ? 0
          : outcome.state === "failure"
            ? outcome.exitCode && outcome.exitCode !== 0
              ? outcome.exitCode
              : 1
            : null;
      try {
        const done = await finishAttempt(db, scope, {
          attemptId: attempt.id,
          owner,
          state: outcome.state,
          exitCode,
          errorClass: outcome.state === "infra_error" ? reason.slice(0, 200) : null,
          ...(outcome.state === "infra_error" && outcome.infraKind
            ? { infraKind: outcome.infraKind }
            : {}),
          ...(outcome.state === "infra_error" ? detailOf(outcome) : {}),
          readiness: this.#o.readiness,
          ...(outcome.outputs ? { outputs: outcome.outputs } : {}),
        });
        if (!done)
          this.#o.log(`attempt ${attempt.id} was already resolved elsewhere; dropped result`);
      } catch (err) {
        this.#o.log(`could not record outcome of ${attempt.id}: ${String(err)}`);
      }
      this.#notify((o) => o.finished(claim, outcome));
    };

    const done = run().finally(() => this.#active.delete(attempt.id));
    this.#active.set(attempt.id, { controller, done, scope });
    this.#notify((o) => o.started(claim));
  }
}
