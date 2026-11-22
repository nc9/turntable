import type { Db } from "../db";
import { backoffMs } from "./backoff";
import { type PollConfig, readToken } from "./config";
import { type FetchLike, GithubClient, RateLimited } from "./github";
import { pollRepo } from "./ingest";
import { ingestStatus, type RepoStatus } from "./status";

export type PollerOptions = {
  db: Db;
  config: PollConfig;
  fetch?: FetchLike;
  now?: () => number;
  log?: (message: string) => void;
  /** Called after a poll that queued runs, so the scheduler can start them at once. */
  onQueued?: () => void;
};

/** Below this many requests left in the window the poller stops asking until it resets. */
const RESERVE = 5;

/**
 * Polls every configured repo on its own interval. The token (read once from its file) is handed
 * to the read-only client and never logged. Failures back off exponentially, never shorter than
 * `Retry-After` or the rate-limit reset GitHub reported; a success resets the backoff. When the
 * remaining budget is nearly gone the poller waits for the reset instead of spending it.
 */
export class Poller {
  readonly #o: PollerOptions;
  readonly #github: GithubClient;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #failures = new Map<string, number>();
  #running = false;

  constructor(o: PollerOptions) {
    this.#o = o;
    const token = o.config.tokenFile ? readToken(o.config.tokenFile) : undefined;
    this.#github = new GithubClient({
      ...(o.fetch ? { fetch: o.fetch } : {}),
      baseUrl: o.config.apiBaseUrl,
      token,
      ...(o.now ? { now: o.now } : {}),
    });
    for (const r of o.config.repos) {
      ingestStatus.repos.set(r.repo, {
        repo: r.repo,
        org: r.org,
        project: r.project,
        lastPollAt: null,
        lastOutcome: null,
        lastError: null,
        nextPollAt: null,
        consecutiveFailures: 0,
        runsCreated: 0,
      });
    }
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  /** Polls every repo once, now. For tests. */
  async pollAll(): Promise<void> {
    for (const cfg of this.#o.config.repos) await this.#pollOne(cfg.repo);
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    ingestStatus.running = true;
    for (const cfg of this.#o.config.repos) void this.#loop(cfg.repo);
  }

  stop(): void {
    this.#running = false;
    ingestStatus.running = false;
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
  }

  /** Polls one repo and returns how long to wait before the next poll. */
  async #pollOne(repo: string): Promise<number> {
    const cfg = this.#o.config.repos.find((r) => r.repo === repo)!;
    const log = this.#o.log ?? (() => {});
    const status = ingestStatus.repos.get(repo) as RepoStatus;
    const intervalMs = cfg.intervalSeconds * 1000;
    const now = this.#now();

    const finish = (
      outcome: RepoStatus["lastOutcome"],
      error: string | null,
      waitMs: number,
    ): number => {
      status.lastPollAt = now;
      status.lastOutcome = outcome;
      status.lastError = error;
      status.nextPollAt = now + waitMs;
      status.consecutiveFailures = this.#failures.get(repo) ?? 0;
      ingestStatus.rateLimit = this.#github.rateLimit ?? ingestStatus.rateLimit;
      return waitMs;
    };

    // Nearly out of budget: do not spend the rest, wait for the window to reset.
    const rate = this.#github.rateLimit;
    if (
      rate?.remaining !== undefined &&
      rate.remaining <= RESERVE &&
      rate.resetAt !== undefined &&
      rate.resetAt > now
    ) {
      const wait = Math.max(rate.resetAt - now, intervalMs);
      log(
        `poll ${repo}: ${rate.remaining} requests left, waiting ${Math.round(wait / 1000)}s for the reset`,
      );
      return finish("rate_limited", "rate limit budget nearly spent", wait);
    }

    try {
      const res = await pollRepo(
        {
          db: this.#o.db,
          github: this.#github,
          provider: this.#o.config.provider,
          ...(this.#o.now ? { now: this.#o.now } : {}),
          log,
        },
        cfg,
      );
      this.#failures.delete(repo);
      status.runsCreated += res.created.length;
      if (res.created.length > 0) this.#o.onQueued?.();
      return finish("ok", null, intervalMs);
    } catch (err) {
      const failures = (this.#failures.get(repo) ?? 0) + 1;
      this.#failures.set(repo, failures);
      if (err instanceof RateLimited) {
        const wait = backoffMs({
          intervalMs,
          failures,
          retryAfterMs: err.retryAfterMs,
          resetAt: err.resetAt,
          now,
        });
        log(`poll ${repo}: rate limited, backing off ${Math.round(wait / 1000)}s`);
        return finish("rate_limited", "rate limited by GitHub", wait);
      }
      const message = err instanceof Error ? err.message : "error";
      const wait = backoffMs({ intervalMs, failures, capMs: 900_000, now });
      log(`poll ${repo} failed: ${message}`);
      return finish("error", message, wait);
    }
  }

  async #loop(repo: string): Promise<void> {
    if (!this.#running) return;
    const next = await this.#pollOne(repo);
    if (!this.#running) return;
    this.#timers.set(
      repo,
      setTimeout(() => void this.#loop(repo), next),
    );
  }
}
