import { randomUUID } from "node:crypto";
import { type Db, onAttemptsCancelled } from "../db";
import {
  addCut,
  appendLogFenced,
  type Claim,
  claimNextAttempt,
  finishAttempt,
  heartbeatAttempt,
  ifLeaseHeld,
  type Readiness,
  recordExec,
  recordPlan,
  recordTrustClass,
  resetAttemptOutput,
  upsertStep,
} from "../db/repos";
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
  globalCap?: number;
  perOrgCap?: number;
  /** Decides when a queued job may run and what becomes of dependents of a failed one. */
  readiness?: Readiness;
  /** Told when attempts start and finish (check runs). Never awaited; its errors are logged. */
  observer?: AttemptObserver;
  /** Run only this run's attempts (see ClaimOptions.onlyRun): `longshore run`'s own scheduler. */
  onlyRun?: string;
  now?: () => number;
  log?: (message: string) => void;
};

/** What the scheduler records when a runner throws or returns nonsense. */
const infra = (reason: string): AttemptOutcome => ({ state: "infra_error", reason });

/**
 * Claims queued attempts and runs them through the runner, within the global and per-org caps.
 * It keeps each lease alive with heartbeats and records the outcome fenced by the lease. A
 * worker that dies stops heartbeating; the reconciler resolves what it left behind.
 */
export class Scheduler {
  readonly owner: string;
  readonly #o: Required<
    Omit<SchedulerOptions, "owner" | "log" | "readiness" | "onlyRun" | "observer">
  > & {
    observer?: AttemptObserver | undefined;
    onlyRun?: string | undefined;
    log: (message: string) => void;
    readiness: Readiness;
  };
  readonly #active = new Map<string, { controller: AbortController; done: Promise<void> }>();
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
      globalCap: o.globalCap ?? 4,
      perOrgCap: o.perOrgCap ?? 2,
      readiness: o.readiness ?? workflowReadiness,
      onlyRun: o.onlyRun,
      observer: o.observer,
      now: o.now ?? Date.now,
      log: o.log ?? (() => {}),
    };
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
      const claim = await claimNextAttempt(this.#o.db, {
        owner: this.owner,
        leaseMs: this.#o.leaseMs,
        now: this.#o.now(),
        globalCap: this.#o.globalCap,
        perOrgCap: this.#o.perOrgCap,
        quotaCacheMs: 5_000,
        readiness: this.#o.readiness,
        ...(this.#o.onlyRun ? { onlyRun: this.#o.onlyRun } : {}),
      });
      if (!claim) return started;
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

  #launch(claim: Claim, resume?: { sandboxId: string; execId: string }): void {
    const { attempt, scope } = claim;
    const controller = new AbortController();
    const db = this.#o.db;
    const owner = this.owner;

    const store: AttemptStore = {
      setExec: async (where) => {
        await recordExec(db, scope, attempt.id, owner, where);
      },
      setPlan: async (planJson) => {
        await recordPlan(db, scope, attempt.id, owner, planJson);
      },
      setTrustClass: async (klass) => {
        await recordTrustClass(db, scope, attempt.id, owner, klass);
      },
      reset: async () => {
        await resetAttemptOutput(db, scope, attempt.id, owner);
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
          const ctx: AttemptContext = {
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
        outcome = infra(err instanceof Error ? err.message : String(err));
      } finally {
        clearInterval(beat);
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
          errorClass: outcome.state === "infra_error" ? outcome.reason.slice(0, 200) : null,
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
    this.#active.set(attempt.id, { controller, done });
    this.#notify((o) => o.started(claim));
  }
}
